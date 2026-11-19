import { AckItem } from "../api/types";
import { readJsonFile, writeFileAtomic } from "./atomicFile";

/**
 * Acks waiting to be delivered to the server. Saved on disk, so a restart or a network
 * outage never loses a "printed" result (losing it could cause a second print).
 */
export interface OutboxItem extends AckItem {
  queuedAt: number;
  tries: number;
}

interface OutboxFile {
  version: 1;
  items: OutboxItem[];
}

export class AckOutbox {
  private items: OutboxItem[];

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    const loaded = readJsonFile<OutboxFile>(file, { version: 1, items: [] });
    this.items = Array.isArray(loaded?.items) ? loaded.items : [];
  }

  /**
   * Add or replace the ack for a task. A "printed" ack is never replaced by a "failed" one.
   */
  add(item: AckItem): void {
    const index = this.items.findIndex((existing) => existing.id === item.id);
    if (index >= 0) {
      const existing = this.items[index];
      if (existing.status === "printed" && item.status === "failed") {
        return;
      }
      this.items[index] = { ...item, queuedAt: existing.queuedAt, tries: existing.tries };
    } else {
      this.items.push({ ...item, queuedAt: this.now(), tries: 0 });
    }
    this.save();
  }

  list(limit = 100): OutboxItem[] {
    return this.items.slice(0, limit);
  }

  all(): OutboxItem[] {
    return [...this.items];
  }

  /** Remove delivered acks. Only removes the exact claim (a newer ack for the same task stays). */
  remove(delivered: Array<{ id: string; claim_token: string }>): void {
    const keys = new Set(delivered.map((d) => `${d.id}|${d.claim_token}`));
    const before = this.items.length;
    this.items = this.items.filter((item) => !keys.has(`${item.id}|${item.claim_token}`));
    if (this.items.length !== before) {
      this.save();
    }
  }

  markTried(ids: string[]): void {
    const set = new Set(ids);
    for (const item of this.items) {
      if (set.has(item.id)) {
        item.tries++;
      }
    }
    this.save();
  }

  size(): number {
    return this.items.length;
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, items: this.items } satisfies OutboxFile));
  }
}
