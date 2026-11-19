import { readJsonFile, writeFileAtomic } from "./atomicFile";

/**
 * On-disk memory of every task this device handled in the last 24 hours.
 *
 *   claimed  -> we have the task, nothing sent to the printer yet
 *   sending  -> bytes are being sent RIGHT NOW (if the service restarts in this state,
 *               we do not know if it printed, so it is never printed again automatically)
 *   printed  -> all bytes sent successfully
 *   failed   -> gave up; reason stored
 *
 * Used to make sure a task is NEVER printed twice, even after a crash or restart.
 */
export type JournalState = "claimed" | "sending" | "printed" | "failed";

export interface JournalEntry {
  state: JournalState;
  printerId: number;
  printerName: string;
  documentId: string;
  claimToken: string;
  updatedAt: number;
  createdAt: number;
  errorCode?: string;
  error?: string;
}

interface JournalFile {
  version: 1;
  tasks: Record<string, JournalEntry>;
}

export class Journal {
  private data: JournalFile;

  constructor(
    private readonly file: string,
    private readonly retentionMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    const loaded = readJsonFile<JournalFile>(file, { version: 1, tasks: {} });
    this.data = loaded && typeof loaded.tasks === "object" ? loaded : { version: 1, tasks: {} };
    this.prune();
  }

  get(taskId: string): JournalEntry | undefined {
    return this.data.tasks[taskId];
  }

  update(taskId: string, patch: Partial<JournalEntry> & { state: JournalState }, base?: Omit<JournalEntry, "state" | "updatedAt" | "createdAt">): JournalEntry {
    const existing = this.data.tasks[taskId];
    if (!existing && !base) {
      throw new Error(`Journal entry ${taskId} does not exist`);
    }
    const now = this.now();
    const entry: JournalEntry = {
      ...(existing ?? { ...base!, createdAt: now }),
      ...patch,
      updatedAt: now,
    } as JournalEntry;
    if (patch.state !== "failed") {
      delete entry.errorCode;
      delete entry.error;
    }
    this.data.tasks[taskId] = entry;
    this.save();
    return entry;
  }

  /** Entries in state "sending" (service stopped while printing). */
  uncertain(): Array<[string, JournalEntry]> {
    return Object.entries(this.data.tasks).filter(([, entry]) => entry.state === "sending");
  }

  recent(limit = 50): Array<{ id: string } & JournalEntry> {
    return Object.entries(this.data.tasks)
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  prune(): void {
    const cutoff = this.now() - this.retentionMs;
    let changed = false;
    for (const [id, entry] of Object.entries(this.data.tasks)) {
      // Never forget an uncertain entry until it is resolved.
      if (entry.updatedAt < cutoff && entry.state !== "sending") {
        delete this.data.tasks[id];
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  size(): number {
    return Object.keys(this.data.tasks).length;
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data));
  }
}
