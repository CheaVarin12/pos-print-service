import { ApiClient, ApiError } from "../api/client";
import { Logger } from "../logger";
import { AckOutbox } from "../store/ackOutbox";

/**
 * Delivers acks from the on-disk outbox to the server, with retry and backoff.
 * An ack leaves the outbox only when the server answered for it (any result).
 */
export class AckSender {
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  private stopped = false;
  private failures = 0;
  private lastError: string | null = null;

  constructor(
    private readonly api: Pick<ApiClient, "ack">,
    private readonly outbox: AckOutbox,
    private readonly logger: Logger,
    private readonly baseDelayMs = 1000,
    private readonly maxDelayMs = 30000,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Try now (called when a new ack is queued). */
  kick(): void {
    if (!this.stopped && !this.sending && this.failures === 0) {
      this.schedule(0);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Last try to deliver before exit (acks stay on disk if this fails).
    if (this.outbox.size() > 0 && !this.sending) {
      await this.flushOnce().catch(() => undefined);
    }
  }

  status(): { pending: number; lastError: string | null } {
    return { pending: this.outbox.size(), lastError: this.lastError };
  }

  /** Send one batch. Returns true if the outbox is now empty. */
  async flushOnce(): Promise<boolean> {
    const batch = this.outbox.list(100);
    if (batch.length === 0) {
      return true;
    }

    this.sending = true;
    try {
      const response = await this.api.ack(
        batch.map(({ id, claim_token, status, error_code, error }) => ({ id, claim_token, status, error_code, error })),
      );
      const answered = new Set((response.results ?? []).map((r) => r.id));
      for (const result of response.results ?? []) {
        if (result.result !== "ok" && result.result !== "already_printed") {
          this.logger.info("ack answered", { task: result.id, result: result.result });
        }
      }
      this.outbox.remove(batch.filter((item) => answered.has(item.id)));
      this.failures = 0;
      this.lastError = null;
      return this.outbox.size() === 0;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      this.lastError = error instanceof Error ? error.message : String(error);

      if (apiError && apiError.status === 422) {
        // The server will never accept this batch (bad data). Drop it so other acks can go.
        this.logger.error("server rejected acks, dropping them", { error: this.lastError, count: batch.length });
        this.outbox.remove(batch);
        return this.outbox.size() === 0;
      }

      this.failures++;
      this.outbox.markTried(batch.map((item) => item.id));
      this.logger.warn("ack delivery failed, will retry", { error: this.lastError, pending: this.outbox.size(), failures: this.failures });
      return false;
    } finally {
      this.sending = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || this.sending) {
      return;
    }
    const empty = await this.flushOnce();
    if (this.stopped) {
      return;
    }
    if (!empty) {
      const delay = this.failures === 0 ? 0 : Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(this.failures, 6));
      this.schedule(delay);
    } else {
      // Nothing to send: check again later in case something was added while sending.
      this.schedule(5000);
    }
  }
}
