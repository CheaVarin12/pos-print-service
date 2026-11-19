import { ApiTask } from "../api/types";
import { PrintError } from "../errors";
import { PrinterTarget } from "../transports/types";

export interface QueuedTask {
  task: ApiTask;
  target: PrinterTarget;
  claimToken: string;
  /** Local time (ms) until which the server lease is surely valid. Renewed by every sync. */
  leaseValidUntil: number;
  leaseDurationMs: number;
  /** Server says another device may own it now -> must not start printing. */
  lost: boolean;
  state: "queued" | "printing" | "retrying" | "done";
  tries: number;
  lastError?: PrintError;
}

export type TaskResult =
  | { kind: "printed" }
  | { kind: "failed"; error: PrintError }
  /** Not printed and not acked: the server will give it out again (lease lost/expired, or service stopping). */
  | { kind: "abandoned"; reason: string };

export interface PrinterQueueStatus {
  printerId: number;
  name: string;
  state: "idle" | "printing" | "retrying";
  queued: number;
  lastError: { code: string; message: string; at: string } | null;
  lastPrintedAt: string | null;
}

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
