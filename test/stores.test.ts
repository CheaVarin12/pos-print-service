import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AckOutbox } from "../src/store/ackOutbox";
import { Journal } from "../src/store/journal";
import { tempDir } from "./helpers";

const base = { printerId: 1, printerName: "P1", documentId: "doc", claimToken: "t1" };

describe("journal", () => {
  it("survives a restart (data is on disk)", () => {
    const file = path.join(tempDir(), "journal.json");
    const journal = new Journal(file);
    journal.update("task-1", { state: "claimed" }, base);
    journal.update("task-1", { state: "printed" });

    const reloaded = new Journal(file);
    expect(reloaded.get("task-1")?.state).toBe("printed");
  });

  it("forgets entries after 24 hours, but never an uncertain (sending) one", () => {
    let now = 1_000_000;
    const file = path.join(tempDir(), "journal.json");
    const journal = new Journal(file, 24 * 3600 * 1000, () => now);
    journal.update("done", { state: "claimed" }, base);
    journal.update("done", { state: "printed" });
    journal.update("unsure", { state: "claimed" }, base);
    journal.update("unsure", { state: "sending" });

    now += 25 * 3600 * 1000;
    journal.prune();
    expect(journal.get("done")).toBeUndefined();
    expect(journal.get("unsure")?.state).toBe("sending");
  });

  it("starts clean if the file is damaged, and keeps a copy", () => {
    const dir = tempDir();
    const file = path.join(dir, "journal.json");
    fs.writeFileSync(file, "{ broken json");
    const journal = new Journal(file);
    expect(journal.size()).toBe(0);
    expect(fs.readdirSync(dir).some((name) => name.startsWith("journal.json.corrupt-"))).toBe(true);
  });
});

describe("ack outbox", () => {
  it("keeps acks on disk until removed", () => {
    const file = path.join(tempDir(), "outbox.json");
    const outbox = new AckOutbox(file);
    outbox.add({ id: "a", claim_token: "t", status: "printed" });
    outbox.add({ id: "b", claim_token: "t", status: "failed", error: "x" });

    const reloaded = new AckOutbox(file);
    expect(reloaded.size()).toBe(2);
    reloaded.remove([{ id: "a", claim_token: "t" }]);
    expect(new AckOutbox(file).list().map((i) => i.id)).toEqual(["b"]);
  });

  it("never replaces a printed ack with a failed one", () => {
    const outbox = new AckOutbox(path.join(tempDir(), "outbox.json"));
    outbox.add({ id: "a", claim_token: "t", status: "printed" });
    outbox.add({ id: "a", claim_token: "t", status: "failed", error: "late" });
    expect(outbox.list()[0].status).toBe("printed");
  });

  it("only removes the exact claim that was delivered", () => {
    const outbox = new AckOutbox(path.join(tempDir(), "outbox.json"));
    outbox.add({ id: "a", claim_token: "new", status: "printed" });
    outbox.remove([{ id: "a", claim_token: "old" }]);
    expect(outbox.size()).toBe(1);
  });
});
