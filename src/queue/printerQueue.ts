import { ContentCache } from "../content/cache";
import { PrintError, toPrintError } from "../errors";
import { buildPrintJob } from "../escpos/raster";
import { Logger } from "../logger";
import { Journal } from "../store/journal";
import { PrinterTransport } from "../transports/types";
import { PrinterQueueStatus, QueuedTask, SleepFn, TaskResult, defaultSleep } from "./types";

export interface PrinterQueueDeps {
  transport: PrinterTransport;
  content: ContentCache;
  journal: Journal;
  logger: Logger;
  retryDelaysSec: number[];
  feedLines: number;
  chunkRows: number;
  onResult: (item: QueuedTask, result: TaskResult) => void;
  now?: () => number;
  sleep?: SleepFn;
}

/**
 * Jobs for ONE printer, printed one after another (so tickets do not mix on paper).
 * Every printer has its own queue, and all queues run at the same time:
 * an offline printer only blocks its own queue, never the others.
 */
export class PrinterQueue {
  private readonly items: QueuedTask[] = [];
  private running = false;
  private readonly stopController = new AbortController();
  private idleWaiters: Array<() => void> = [];
  private current: QueuedTask | null = null;
  private lastError: PrinterQueueStatus["lastError"] = null;
  private lastPrintedAt: string | null = null;
  private readonly now: () => number;
  private readonly sleep: SleepFn;

  constructor(readonly printerId: number, private name: string, private readonly deps: PrinterQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  enqueue(item: QueuedTask): void {
    this.name = item.target.name;
    this.items.push(item);
    if (!this.running) {
      void this.run();
    }
  }

  status(): PrinterQueueStatus {
    let state: PrinterQueueStatus["state"] = "idle";
    if (this.current?.state === "printing") state = "printing";
    if (this.current?.state === "retrying") state = "retrying";
    return {
      printerId: this.printerId,
      name: this.name,
      state,
      queued: this.items.length + (this.current ? 1 : 0),
      lastError: this.lastError,
      lastPrintedAt: this.lastPrintedAt,
    };
  }

  /** Stop after the current send. Waiting (not started) tasks are abandoned; the server re-gives them. */
  async stop(timeoutMs = 10000): Promise<void> {
    this.stopController.abort();
    if (!this.running) {
      return;
    }
    await Promise.race([
      new Promise<void>((resolve) => this.idleWaiters.push(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;
        this.current = item;
        let result: TaskResult;
        try {
          result = await this.process(item);
        } catch (error) {
          // Should not happen; never let one task kill the queue.
          result = { kind: "failed", error: toPrintError(error) };
        }
        item.state = "done";
        this.current = null;
        this.deps.onResult(item, result);
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  private async process(item: QueuedTask): Promise<TaskResult> {
    const { task, target } = item;
    const log = this.deps.logger;
    const delays = this.deps.retryDelaysSec;

    for (let attempt = 0; ; attempt++) {
      // Rules before sending anything: never print a task that may now belong to another device.
      if (this.stopController.signal.aborted) {
        return { kind: "abandoned", reason: "service stopping" };
      }
      if (item.lost) {
        return { kind: "abandoned", reason: "server gave the task to another device (lease lost)" };
      }
      if (this.now() > item.leaseValidUntil) {
        return { kind: "abandoned", reason: "lease expired (server not reachable); the server will give it out again" };
      }

      item.tries = attempt + 1;
      item.state = "printing";

      try {
        const bitmap = await this.deps.content.getBitmap(task.document!, target.paperWidth);
        const bytes = buildPrintJob(bitmap, {
          copies: task.copies,
          feedLines: this.deps.feedLines,
          chunkRows: this.deps.chunkRows,
        });

        // From here on, bytes may reach the printer. Write it down FIRST.
        this.deps.journal.update(task.id, { state: "sending" });
        await this.deps.transport.send(target, bytes, { taskId: task.id });
        this.deps.journal.update(task.id, { state: "printed" });

        this.lastError = null;
        this.lastPrintedAt = new Date(this.now()).toISOString();
        log.info("printed", { task: task.id, printer: target.name, copies: task.copies, bytes: bytes.length, tries: item.tries });
        return { kind: "printed" };
      } catch (error) {
        const printError = toPrintError(error);
        item.lastError = printError;
        this.lastError = { code: printError.code, message: printError.message, at: new Date(this.now()).toISOString() };

        const canRetry = printError.retryable && printError.bytesSent === 0 && attempt < delays.length;
        // Nothing reached the printer: go back from "sending" to "claimed".
        if (printError.bytesSent === 0 && this.deps.journal.get(task.id)?.state === "sending") {
          this.deps.journal.update(task.id, { state: "claimed" });
        }

        if (!canRetry) {
          this.deps.journal.update(task.id, { state: "failed", errorCode: printError.code, error: printError.message });
          log.warn("print failed", { task: task.id, printer: target.name, code: printError.code, error: printError.message, tries: item.tries });
          return { kind: "failed", error: printError };
        }

        const waitSec = delays[attempt];
        log.warn("print error, will retry", { task: task.id, printer: target.name, code: printError.code, error: printError.message, retryInSec: waitSec });
        item.state = "retrying";
        await this.sleep(waitSec * 1000, this.stopController.signal);
      }
    }
  }
}

export function isPrintError(error: unknown): error is PrintError {
  return error instanceof PrintError;
}
