import crypto from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiTask } from "../src/api/types";
import { defaultConfig } from "../src/config";
import { ContentCache } from "../src/content/cache";
import { PrintError } from "../src/errors";
import { decodeEscPos } from "../src/escpos/decode";
import { MemoryLogger } from "../src/logger";
import { appPaths } from "../src/paths";
import { Dispatcher } from "../src/queue/dispatcher";
import { AckOutbox } from "../src/store/ackOutbox";
import { Journal } from "../src/store/journal";
import { RecordingTransport, makePng, printer, tempDir, waitFor } from "./helpers";

const png = makePng(576, 50);
const sha = crypto.createHash("sha256").update(png).digest("hex");

function task(printerId: number, extra: Partial<ApiTask> = {}, documentId = "doc-1"): ApiTask {
  return {
    id: crypto.randomUUID(),
    claim_token: crypto.randomUUID(),
    job_type: "receipt",
    copies: 1,
    attempt: 1,
    max_attempts: 3,
    lease_expires_at: new Date(Date.now() + 120000).toISOString(),
    printer: printer(printerId),
    document: { id: documentId, kind: "receipt", width: 576, height: 50, sha256: sha, content_url: `https://x.test/api/print/v2/documents/${documentId}/content` },
    ...extra,
  };
}

function setup(options: { sleepMs?: number } = {}) {
  const dir = tempDir();
  const paths = appPaths(dir);
  const config = { ...defaultConfig(paths), retryDelaysSec: [5, 15, 30, 60] };
  const transport = new RecordingTransport();
  const journal = new Journal(path.join(dir, "journal.json"));
  const outbox = new AckOutbox(path.join(dir, "outbox.json"));
  let downloads = 0;
  const content = new ContentCache({
    downloadContent: async () => {
      downloads++;
      await new Promise((r) => setTimeout(r, 20));
      return png;
    },
  });
  const logger = new MemoryLogger();
  const dispatcher = new Dispatcher({
    config,
    transport,
    content,
    journal,
    outbox,
    logger,
    // Retry waits are shortened for tests (real: 5, 15, 30, 60 s).
    sleep: (_ms, _signal) => new Promise((r) => setTimeout(r, options.sleepMs ?? 5)),
  });
  return { dispatcher, transport, journal, outbox, logger, downloads: () => downloads };
}

const now = () => Date.now();
const serverTime = () => new Date().toISOString();

describe("dispatcher + printer queues", () => {
  it("an offline printer does NOT block other printers", async () => {
    const { dispatcher, transport, outbox } = setup({ sleepMs: 60 });
    transport.failures.set(1, () => new PrintError("CONN_REFUSED", "refused", true));

    const offline = task(1);
    const kitchen = task(2);
    const bar = task(3);
    dispatcher.accept([offline, kitchen, bar], now(), serverTime());

    // Kitchen and bar print while printer 1 is still retrying.
    await waitFor(() => transport.sent.length === 2, 2000, "two printers printed");
    expect(transport.sent.map((s) => s.printerId).sort()).toEqual([2, 3]);
    expect(outbox.list().find((a) => a.id === offline.id)).toBeUndefined();

    // Printer 1: 1 try + 4 retries, then a failed ack with the real reason.
    await waitFor(() => outbox.list().some((a) => a.id === offline.id), 3000, "failed ack");
    expect(transport.attemptsFor(1)).toBe(5);
    expect(outbox.list().find((a) => a.id === offline.id)).toMatchObject({ status: "failed", error_code: "CONN_REFUSED" });
  });

  it("retries a temporary error and then prints", async () => {
    const { dispatcher, transport, outbox, journal } = setup();
    transport.failures.set(1, (attempt) => (attempt <= 2 ? new PrintError("CONNECT_TIMEOUT", "timeout", true) : null));
    const t = task(1);
    dispatcher.accept([t], now(), serverTime());

    await waitFor(() => outbox.size() === 1);
    expect(transport.attemptsFor(1)).toBe(3);
    expect(outbox.list()[0]).toMatchObject({ id: t.id, status: "printed", claim_token: t.claim_token });
    expect(journal.get(t.id)?.state).toBe("printed");
  });

  it("never retries after a partial write (could print twice)", async () => {
    const { dispatcher, transport, outbox, journal } = setup();
    transport.failures.set(1, () => new PrintError("PARTIAL_WRITE", "cable pulled", false, 500));
    const t = task(1);
    dispatcher.accept([t], now(), serverTime());

    await waitFor(() => outbox.size() === 1);
    expect(transport.attemptsFor(1)).toBe(1);
    expect(outbox.list()[0]).toMatchObject({ status: "failed", error_code: "PARTIAL_WRITE" });
    expect(journal.get(t.id)?.state).toBe("failed");
  });

  it("downloads the image once for several printers and prints copies", async () => {
    const { dispatcher, transport, downloads } = setup();
    dispatcher.accept([task(1, { copies: 2 }), task(2), task(3)], now(), serverTime());

    await waitFor(() => transport.sent.length === 3);
    expect(downloads()).toBe(1);
    const toPrinter1 = transport.sent.find((s) => s.printerId === 1)!;
    expect(decodeEscPos(toPrinter1.bytes).cuts).toBe(2);
  });

  it("a task already printed before (ack was lost) is acked, not printed again", async () => {
    const { dispatcher, transport, journal, outbox } = setup();
    const t = task(1);
    journal.update(t.id, { state: "claimed" }, { printerId: 1, printerName: "P1", documentId: "doc-1", claimToken: "old" });
    journal.update(t.id, { state: "printed" });

    dispatcher.accept([t], now(), serverTime());
    await new Promise((r) => setTimeout(r, 100));

    expect(transport.sent).toHaveLength(0);
    expect(outbox.list()[0]).toMatchObject({ id: t.id, status: "printed", claim_token: t.claim_token });
  });

  it("after a crash while printing, the task is reported as uncertain and not printed again", async () => {
    const { dispatcher, transport, journal, outbox } = setup();
    journal.update("crashed-task", { state: "claimed" }, { printerId: 1, printerName: "P1", documentId: "doc-1", claimToken: "tok" });
    journal.update("crashed-task", { state: "sending" });

    expect(dispatcher.resolveUncertainOnStartup()).toBe(1);
    expect(outbox.list()[0]).toMatchObject({ id: "crashed-task", claim_token: "tok", status: "failed", error_code: "UNCERTAIN_RESTART" });

    // The server gives it again: still not printed.
    dispatcher.accept([task(1, { id: "crashed-task" })], now(), serverTime());
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.sent).toHaveLength(0);
  });

  it("does not start a task whose lease was lost to another device", async () => {
    const { dispatcher, transport, outbox } = setup();
    transport.delayMs = 150; // printer 1 busy with the first task
    const first = task(1);
    const second = task(1);
    dispatcher.accept([first, second], now(), serverTime());
    dispatcher.applyLeases({ renewed: [], lost: [second.id] }, now());

    await waitFor(() => outbox.size() === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(transport.sent.map((s) => s.taskId)).toEqual([first.id]);
    expect(outbox.list().map((a) => a.id)).toEqual([first.id]); // no ack for the abandoned task
  });

  it("does not start printing when the lease may have expired (server unreachable)", async () => {
    const { dispatcher, transport } = setup();
    // Synced 3 minutes ago, lease 120 s: too late to start.
    const syncedAt = now() - 180000;
    const stale = task(1, { lease_expires_at: new Date(syncedAt + 120000).toISOString() });
    dispatcher.accept([stale], syncedAt, new Date(syncedAt).toISOString());
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.sent).toHaveLength(0);
  });

  it("keeps renewing the lease until the ack is delivered", async () => {
    const { dispatcher, outbox } = setup();
    const t = task(1);
    dispatcher.accept([t], now(), serverTime());
    await waitFor(() => outbox.size() === 1);

    expect(dispatcher.inProgress()).toEqual([{ id: t.id, claim_token: t.claim_token }]);
    outbox.remove([{ id: t.id, claim_token: t.claim_token }]);
    expect(dispatcher.inProgress()).toEqual([]);
  });
});
