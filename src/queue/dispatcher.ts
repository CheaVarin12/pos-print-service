import { AckItem, ApiPrinter, ApiTask, InProgressItem } from "../api/types";
import { AppConfig } from "../config";
import { ContentCache } from "../content/cache";
import { Logger } from "../logger";
import { AckOutbox } from "../store/ackOutbox";
import { Journal } from "../store/journal";
import { resolveTarget } from "../transports/factory";
import { PrinterTransport } from "../transports/types";
import { PrinterQueue } from "./printerQueue";
import { PrinterQueueStatus, QueuedTask, SleepFn, TaskResult } from "./types";

export interface DispatcherDeps {
  config: AppConfig;
  transport: PrinterTransport;
  content: ContentCache;
  journal: Journal;
  outbox: AckOutbox;
  logger: Logger;
  onAckQueued?: () => void;
  now?: () => number;
  sleep?: SleepFn;
}

/** Safety margin: stop starting new prints this long before the lease could expire. */
const LEASE_MARGIN_MS = 15000;

/**
 * Receives claimed tasks from the server and gives each one to its printer's queue.
 * It applies the "never print twice" rules using the on-disk journal.
 */
export class Dispatcher {
  private readonly queues = new Map<number, PrinterQueue>();
  private readonly active = new Map<string, QueuedTask>();
  private printers: ApiPrinter[] = [];

  constructor(private readonly deps: DispatcherDeps) {}

  /**
   * Called once at start-up: tasks that were "sending" when the service stopped.
   * We cannot know if they printed, so we never print them again automatically.
   * The server gets a "failed" ack with a clear reason, and staff can press Reprint.
   */
  resolveUncertainOnStartup(): number {
    const uncertain = this.deps.journal.uncertain();
    for (const [taskId, entry] of uncertain) {
      const message = "FoodMonsterPrint restarted while this was printing. It may or may not have printed. Check the printer and press Reprint if needed.";
      this.deps.journal.update(taskId, { state: "failed", errorCode: "UNCERTAIN_RESTART", error: message });
      this.queueAck({ id: taskId, claim_token: entry.claimToken, status: "failed", error_code: "UNCERTAIN_RESTART", error: message });
      this.deps.logger.warn("uncertain task after restart, reported as failed", { task: taskId, printer: entry.printerName });
    }
    return uncertain.length;
  }

  /**
   * New tasks from a sync. `syncStartedAt` = local time when the sync request was sent.
   */
  accept(tasks: ApiTask[], syncStartedAt: number, serverTime: string): void {
    const serverNow = Date.parse(serverTime);

    for (const task of tasks) {
      if (!task.printer || !task.document) {
        this.queueAck({ id: task.id, claim_token: task.claim_token, status: "failed", error_code: "BAD_TASK", error: "Task has no printer or document." });
        continue;
      }

      const leaseDurationMs = computeLeaseDuration(task, serverNow);
      const existing = this.active.get(task.id);
      if (existing) {
        // Still in our queue (maybe printing right now), and the server gave it to us again after a
        // lease loss: keep it, just use the new claim token. The journal state is not changed.
        existing.claimToken = task.claim_token;
        existing.task = task;
        existing.lost = false;
        existing.leaseValidUntil = syncStartedAt + leaseDurationMs - LEASE_MARGIN_MS;
        const current = this.deps.journal.get(task.id);
        if (current) {
          this.deps.journal.update(task.id, { state: current.state, claimToken: task.claim_token });
        }
        continue;
      }

      const previous = this.deps.journal.get(task.id);
      if (previous?.state === "printed") {
        // Already printed, but the server never got our ack. Do NOT print again: just ack.
        this.deps.logger.info("task already printed before, acking only", { task: task.id });
        this.queueAck({ id: task.id, claim_token: task.claim_token, status: "printed" });
        continue;
      }
      if (previous?.state === "sending" || previous?.state === "failed") {
        // Unknown result or already failed (maybe partly printed): report again, never auto-reprint.
        const errorCode = previous.state === "sending" ? "UNCERTAIN_RESTART" : previous.errorCode ?? "PRINT_FAILED";
        const error = previous.state === "sending" ? "Printing was interrupted. Check the printer and press Reprint if needed." : previous.error ?? "Print failed.";
        this.deps.journal.update(task.id, { state: "failed", errorCode, error });
        this.queueAck({ id: task.id, claim_token: task.claim_token, status: "failed", error_code: errorCode, error });
        continue;
      }

      const target = resolveTarget(task.printer, this.deps.config);
      const item: QueuedTask = {
        task,
        target,
        claimToken: task.claim_token,
        leaseDurationMs,
        leaseValidUntil: syncStartedAt + leaseDurationMs - LEASE_MARGIN_MS,
        lost: false,
        state: "queued",
        tries: 0,
      };

      this.deps.journal.update(
        task.id,
        { state: "claimed", claimToken: task.claim_token },
        { printerId: target.printerId, printerName: target.name, documentId: task.document.id, claimToken: task.claim_token },
      );
      this.active.set(task.id, item);
      this.queueFor(target.printerId, target.name).enqueue(item);
      this.deps.logger.info("task received", { task: task.id, printer: target.name, copies: task.copies, attempt: task.attempt });
    }
  }

  /** Apply the lease result of a sync: renewed tasks get more time, lost ones must not start. */
  applyLeases(leases: { renewed: string[]; lost: string[] }, syncStartedAt: number): void {
    for (const id of leases.renewed) {
      const item = this.active.get(id);
      if (item) {
        item.leaseValidUntil = syncStartedAt + item.leaseDurationMs - LEASE_MARGIN_MS;
      }
    }
    for (const id of leases.lost) {
      const item = this.active.get(id);
      if (item && item.state !== "done") {
        item.lost = true;
        this.deps.logger.warn("lease lost", { task: id, state: item.state });
      }
    }
  }

  setPrinters(printers: ApiPrinter[]): void {
    this.printers = printers;
  }

  knownPrinters(): ApiPrinter[] {
    return this.printers;
  }

  /**
   * Tasks to send in the next sync as "in_progress" (renews their lease):
   * waiting/printing tasks AND tasks whose ack is not delivered yet. Keeping the lease until the
   * ack arrives stops the server from giving a printed task to another device.
   */
  inProgress(): InProgressItem[] {
    const items = new Map<string, InProgressItem>();
    for (const [id, item] of this.active) {
      items.set(id, { id, claim_token: item.claimToken });
    }
    for (const ack of this.deps.outbox.all()) {
      if (!items.has(ack.id)) {
        items.set(ack.id, { id: ack.id, claim_token: ack.claim_token });
      }
    }
    return [...items.values()];
  }

  queueStatuses(): PrinterQueueStatus[] {
    return [...this.queues.values()].map((queue) => queue.status());
  }

  activeCount(): number {
    return this.active.size;
  }

  async stop(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.stop()));
  }

  private onResult(item: QueuedTask, result: TaskResult): void {
    const { task } = item;
    this.active.delete(task.id);

    if (result.kind === "printed") {
      this.queueAck({ id: task.id, claim_token: item.claimToken, status: "printed" });
    } else if (result.kind === "failed") {
      this.queueAck({
        id: task.id,
        claim_token: item.claimToken,
        status: "failed",
        error_code: result.error.code,
        error: result.error.message,
      });
    } else {
      // Not printed: nothing to ack. Forget the journal claim so a re-claim prints normally.
      this.deps.logger.warn("task not printed, server will give it out again", { task: task.id, reason: result.reason });
    }
  }

  private queueAck(ack: AckItem): void {
    this.deps.outbox.add(ack);
    this.deps.onAckQueued?.();
  }

  private queueFor(printerId: number, name: string): PrinterQueue {
    let queue = this.queues.get(printerId);
    if (!queue) {
      queue = new PrinterQueue(printerId, name, {
        transport: this.deps.transport,
        content: this.deps.content,
        journal: this.deps.journal,
        logger: this.deps.logger,
        retryDelaysSec: this.deps.config.retryDelaysSec,
        feedLines: this.deps.config.feedLines,
        chunkRows: this.deps.config.rasterChunkRows,
        onResult: (item, result) => this.onResult(item, result),
        now: this.deps.now,
        sleep: this.deps.sleep,
      });
      this.queues.set(printerId, queue);
    }
    return queue;
  }
}

function computeLeaseDuration(task: ApiTask, serverNow: number): number {
  const expires = task.lease_expires_at ? Date.parse(task.lease_expires_at) : NaN;
  if (Number.isFinite(expires) && Number.isFinite(serverNow) && expires > serverNow) {
    return expires - serverNow;
  }
  return 120000;
}
