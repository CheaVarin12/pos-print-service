import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app";
import { saveDevice } from "../src/config";
import { MemoryLogger } from "../src/logger";
import { appPaths } from "../src/paths";
import { writeFileAtomic } from "../src/store/atomicFile";
import { MockServer, RecordingTransport, makePng, printer, tempDir, waitFor } from "./helpers";

/**
 * Whole service against a mock Laravel server: sync -> download -> print -> ack.
 */
describe("end to end", () => {
  let server: MockServer;
  let app: App | null = null;
  let transport: RecordingTransport;
  let dir: string;

  beforeEach(async () => {
    server = new MockServer();
    await server.start();
    server.printers.push(printer(1), printer(2));
    transport = new RecordingTransport();
    dir = tempDir();
  });

  afterEach(async () => {
    await app?.stop();
    app = null;
    await server.stop();
  });

  function startApp(): App {
    const paths = appPaths(dir);
    writeFileAtomic(paths.config, JSON.stringify({ serverUrl: server.url, pollIntervalMs: 1000 }));
    saveDevice(paths, {
      token: server.token,
      deviceId: "dev",
      branchId: 1,
      shopId: 1,
      name: "Test PC",
      serverUrl: server.url,
      pairedAt: new Date().toISOString(),
    });
    app = new App(paths, { transport, logger: new MemoryLogger(), noStatusServer: true, noUpdater: true, sleep: async () => undefined });
    return app;
  }

  it("prints the same receipt on two printers, downloads once, and acks both", async () => {
    const doc = server.addDocument(makePng());
    const a = server.addTask(1, doc);
    const b = server.addTask(2, doc);

    await startApp().start();
    await waitFor(() => server.tasks.get(a)!.status === "printed" && server.tasks.get(b)!.status === "printed", 8000, "both printed");

    expect(transport.sent.map((s) => s.printerId).sort()).toEqual([1, 2]);
    expect(server.contentDownloads).toBe(1);
  });

  it("keeps the ack on disk while the server fails, and delivers it later (no second print)", async () => {
    const doc = server.addDocument();
    const id = server.addTask(1, doc);
    server.failNextAcks = 2;

    await startApp().start();
    await waitFor(() => server.tasks.get(id)!.status === "printed", 10000, "ack delivered after retries");

    expect(server.ackRequests).toBeGreaterThanOrEqual(3);
    expect(transport.sent).toHaveLength(1);
  });

  it("after a restart with an undelivered ack, the task is not printed again", async () => {
    const doc = server.addDocument();
    const id = server.addTask(1, doc);
    server.failNextAcks = 1000; // server never accepts acks during the first run

    await startApp().start();
    await waitFor(() => transport.sent.length === 1, 8000, "first print");
    await app!.stop();
    app = null;
    expect(JSON.parse(fs.readFileSync(appPaths(dir).outbox, "utf8")).items).toHaveLength(1);

    // Server is fine again. Simulate that the lease expired meanwhile: the server re-gives the task.
    server.failNextAcks = 0;
    server.tasks.get(id)!.status = "pending";

    await startApp().start();
    await waitFor(() => server.tasks.get(id)!.status === "printed", 8000, "printed state on server");
    expect(transport.sent).toHaveLength(1); // still only ONE print
  });

  it("reports the real reason when a printer fails", async () => {
    const { PrintError } = await import("../src/errors");
    transport.failures.set(2, () => new PrintError("PARTIAL_WRITE", "Connection to printer broke while printing", false, 10));
    const doc = server.addDocument();
    const id = server.addTask(2, doc);

    await startApp().start();
    await waitFor(() => server.tasks.get(id)!.status === "failed", 8000, "failed on server");
    expect(server.tasks.get(id)!.error).toContain("broke while printing");
  });

  it("Remove pairing then pair again with a new code: prints again, no restart", async () => {
    const doc = server.addDocument();
    const first = server.addTask(1, doc);
    const app = startApp();
    await app.start();
    await waitFor(() => server.tasks.get(first)!.status === "printed", 8000, "first print");

    await app.unpair();
    expect(app.status().device).toBeNull();
    expect(fs.existsSync(appPaths(dir).device)).toBe(false);
    expect(fs.existsSync(appPaths(dir).journal)).toBe(true); // printed history kept

    const second = server.addTask(2, doc);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.tasks.get(second)!.status).toBe("pending"); // not paired: nothing printed

    await app.pair("ABCD2345");
    expect((app.status().device as { name: string }).name).toBe("Test PC");
    await waitFor(() => server.tasks.get(second)!.status === "printed", 8000, "print after pairing again");
    expect(transport.sent).toHaveLength(2);
  });

  it("keeps polling while the server is down and prints when it is back", async () => {
    server.syncDown = true;
    const doc = server.addDocument();
    const id = server.addTask(1, doc);

    await startApp().start();
    await new Promise((r) => setTimeout(r, 1500));
    expect(transport.sent).toHaveLength(0);
    expect((app!.status().sync as { consecutiveErrors: number }).consecutiveErrors).toBeGreaterThan(0);

    server.syncDown = false;
    await waitFor(() => server.tasks.get(id)!.status === "printed", 10000, "printed after server is back");
  });
});
