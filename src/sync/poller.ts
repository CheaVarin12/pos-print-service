import { ApiClient, ApiError } from "../api/client";
import { Logger } from "../logger";
import { Dispatcher } from "../queue/dispatcher";
import { TaskFeed } from "./transport";

export interface PollerStatus {
  lastSyncAt: string | null;
  lastSyncOkAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  unauthorized: boolean;
}

/**
 * Calls /api/print/v2/sync every `intervalMs`:
 *  1. sends the tasks still in progress (renews their lease),
 *  2. receives new claimed tasks and hands them to the dispatcher.
 * On errors it waits longer (backoff up to 30 s), so a server outage does not flood the server.
 */
export class Poller implements TaskFeed {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private readonly state: PollerStatus = {
    lastSyncAt: null,
    lastSyncOkAt: null,
    lastError: null,
    consecutiveErrors: 0,
    unauthorized: false,
  };

  constructor(
    private readonly api: Pick<ApiClient, "sync">,
    private readonly dispatcher: Dispatcher,
    private readonly logger: Logger,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  triggerNow(): void {
    if (!this.stopped && !this.running) {
      this.schedule(0);
    }
  }

  status(): PollerStatus {
    return { ...this.state };
  }

  /** One sync. Exposed for tests. */
  async syncOnce(): Promise<void> {
    const startedAt = this.now();
    this.state.lastSyncAt = new Date(startedAt).toISOString();

    const response = await this.api.sync(this.dispatcher.inProgress());
    this.dispatcher.applyLeases(response.leases ?? { renewed: [], lost: [] }, startedAt);
    this.dispatcher.setPrinters(response.printers ?? []);
    this.dispatcher.accept(response.tasks ?? [], startedAt, response.server_time);

    this.state.lastSyncOkAt = new Date(this.now()).toISOString();
    this.state.lastError = null;
    this.state.unauthorized = false;
    if (this.state.consecutiveErrors > 0) {
      this.logger.info("server reachable again", { afterErrors: this.state.consecutiveErrors });
    }
    this.state.consecutiveErrors = 0;
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
    if (this.stopped || this.running) {
      return;
    }
    this.running = true;
    try {
      await this.syncOnce();
    } catch (error) {
      this.state.consecutiveErrors++;
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.state.unauthorized = error instanceof ApiError && error.isUnauthorized;

      // Log the first error and then every 20th, so a long outage does not fill the log.
      if (this.state.consecutiveErrors === 1 || this.state.consecutiveErrors % 20 === 0) {
        this.logger.warn(this.state.unauthorized ? "device token rejected (revoked?). Pair this device again." : "sync failed", {
          error: this.state.lastError,
          consecutiveErrors: this.state.consecutiveErrors,
        });
      }
    } finally {
      this.running = false;
    }

    let delay = this.intervalMs;
    if (this.state.unauthorized) {
      delay = 30000;
    } else if (this.state.consecutiveErrors > 0) {
      delay = Math.min(30000, this.intervalMs * 2 ** Math.min(this.state.consecutiveErrors - 1, 4));
    }
    this.schedule(delay);
  }
}
