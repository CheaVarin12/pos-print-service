import net, { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { ContentCache } from "../src/content/cache";
import { PrintError } from "../src/errors";
import { decodeEscPos } from "../src/escpos/decode";
import { healthFromSpooler, healthFromStatusBytes, jobStateFromStatus, JOB_STATUS, SPOOLER_STATUS } from "../src/escpos/status";
import { MemoryLogger } from "../src/logger";
import { appPaths } from "../src/paths";
import { Dispatcher } from "../src/queue/dispatcher";
import { AckOutbox } from "../src/store/ackOutbox";
import { Journal } from "../src/store/journal";
import { Heartbeat } from "../src/sync/heartbeat";
import { TransportRouter } from "../src/transports/factory";
import { probeTcpStatus, sendTcp } from "../src/transports/tcp";
import { WinspoolTransport } from "../src/transports/winspool";
import { RecordingTransport, printer, tempDir } from "./helpers";

type Mode = "ok" | "paper-out" | "cover-open" | "silent";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

/** Minimal ESC/POS printer: answers DLE EOT like a real one and records what it receives. */
async function fakePrinter(mode: Mode): Promise<{ port: number; received: () => Buffer }> {
  const chunks: Buffer[] = [];
  const answer = (n: number) => {
    if (mode === "paper-out") return n === 2 ? 0x32 : n === 4 ? 0x72 : 0x12;
    if (mode === "cover-open") return n === 1 ? 0x1a : n === 2 ? 0x16 : 0x12;
    return 0x12;
  };
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (mode === "silent") return;
      for (let i = 0; i + 2 < chunk.length + 0; i++) {
        if (chunk[i] === 0x10 && chunk[i + 1] === 0x04) socket.write(Buffer.from([answer(chunk[i + 2])]));
      }
    });
    socket.on("end", () => socket.end());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, received: () => Buffer.concat(chunks) };
}

const tcpOptions = { connectTimeoutMs: 1000, writeTimeoutMs: 2000, closeGraceMs: 100, statusCheck: true, statusTimeoutMs: 300 };
const job = Buffer.concat([Buffer.from([0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, 1, 0, 1, 0, 0xff]), Buffer.from([0x1d, 0x56, 0x42, 0x00])]);

describe("ESC/POS status bytes", () => {
  it("reads paper out, cover open, offline and near end", () => {
    expect(healthFromStatusBytes({ n1: 0x12, n2: 0x12, n4: 0x12 })).toMatchObject({ online: true, code: "OK" });
    expect(healthFromStatusBytes({ n2: 0x32, n4: 0x72 })).toMatchObject({ online: false, code: "PAPER_OUT" });
    expect(healthFromStatusBytes({ n1: 0x1a, n2: 0x16 })).toMatchObject({ online: false, code: "COVER_OPEN" });
    expect(healthFromStatusBytes({ n1: 0x1a, n2: 0x12, n4: 0x12 })).toMatchObject({ online: false, code: "OFFLINE" });
    expect(healthFromStatusBytes({ n4: 0x1e })).toMatchObject({ online: true, code: "PAPER_NEAR_END" });
    expect(healthFromStatusBytes({ n2: 0x52 })).toMatchObject({ online: false, code: "PRINTER_ERROR" });
  });

  it("ignores bytes that are not status bytes (other data from the printer)", () => {
    expect(healthFromStatusBytes({ n1: 0xff, n2: 0x00 })).toMatchObject({ online: true, code: "NO_STATUS" });
  });
});

describe("Windows spooler status", () => {
  it("maps spooler flags to plain-English health", () => {
    expect(healthFromSpooler(0, 0, 0)).toMatchObject({ online: true, code: "OK" });
    expect(healthFromSpooler(SPOOLER_STATUS.OFFLINE, 0, 0)).toMatchObject({ online: false, code: "OFFLINE" });
    expect(healthFromSpooler(SPOOLER_STATUS.PAPER_OUT, 0, 0)).toMatchObject({ online: false, code: "PAPER_OUT" });
    expect(healthFromSpooler(SPOOLER_STATUS.PAUSED, 0, 0)).toMatchObject({ online: false, code: "OFFLINE" });
    expect(healthFromSpooler(0, 0x400, 0).message).toContain("Use Printer Offline");
    expect(healthFromSpooler(0, 0, 3).message).toContain("3 job(s)");
  });

  it("maps job flags", () => {
    expect(jobStateFromStatus(0).state).toBe("waiting");
    expect(jobStateFromStatus(JOB_STATUS.SPOOLING).state).toBe("waiting");
    expect(jobStateFromStatus(JOB_STATUS.PRINTING).state).toBe("printing");
    expect(jobStateFromStatus(JOB_STATUS.PRINTED).state).toBe("done");
    expect(jobStateFromStatus(JOB_STATUS.OFFLINE | JOB_STATUS.SPOOLING).state).toBe("problem");
    expect(jobStateFromStatus(JOB_STATUS.PAPEROUT).state).toBe("problem");
  });
});

describe("status check before printing (network)", () => {
  it("prints normally when the printer says OK", async () => {
    const p = await fakePrinter("ok");
    await sendTcp("127.0.0.1", p.port, job, tcpOptions);
    expect(decodeEscPos(p.received()).cuts).toBe(1);
  });

  it("paper out: sends NOTHING and returns a retryable PAPER_OUT error", async () => {
    const p = await fakePrinter("paper-out");
    const error = await sendTcp("127.0.0.1", p.port, job, tcpOptions).catch((e) => e);
    expect(error).toBeInstanceOf(PrintError);
    expect(error.code).toBe("PAPER_OUT");
    expect(error.retryable).toBe(true);
    expect(error.bytesSent).toBe(0);
    expect(decodeEscPos(p.received()).pages).toHaveLength(0);
  });

  it("cover open: sends nothing", async () => {
    const p = await fakePrinter("cover-open");
    const error = await sendTcp("127.0.0.1", p.port, job, tcpOptions).catch((e) => e);
    expect(error.code).toBe("COVER_OPEN");
    expect(decodeEscPos(p.received()).pages).toHaveLength(0);
  });

  it("printer that never answers status still prints (after a short wait)", async () => {
    const p = await fakePrinter("silent");
    await sendTcp("127.0.0.1", p.port, job, tcpOptions);
    expect(decodeEscPos(p.received()).cuts).toBe(1);
  });
});

describe("probe (heartbeat)", () => {
  it("reports OK, paper out, no status and unreachable", async () => {
    const ok = await fakePrinter("ok");
    const paper = await fakePrinter("paper-out");
    const silent = await fakePrinter("silent");
    const options = { connectTimeoutMs: 1000, statusTimeoutMs: 300 };

    expect(await probeTcpStatus("127.0.0.1", ok.port, options)).toMatchObject({ online: true, code: "OK" });
    expect(await probeTcpStatus("127.0.0.1", paper.port, options)).toMatchObject({ online: false, code: "PAPER_OUT" });
    expect(await probeTcpStatus("127.0.0.1", silent.port, options)).toMatchObject({ online: true, code: "NO_STATUS" });

    const closed = await fakePrinter("ok");
    await new Promise((r) => servers.pop()!.close(() => r(undefined)));
    expect(await probeTcpStatus("127.0.0.1", closed.port, options)).toMatchObject({ online: false, code: "UNREACHABLE" });

    // A probe never prints anything.
    expect(decodeEscPos(ok.received()).pages).toHaveLength(0);
  });
});

describe("USB", () => {
  it("on a Mac/Linux a USB printer fails with a clear message (Windows only)", async () => {
    if (process.platform === "win32") return;
    const router = new TransportRouter(defaultConfig(appPaths(tempDir())));
    const error = await router
      .send({ printerId: 1, name: "XP-80C", connection: "usb", host: null, port: 9100, paperWidth: 576, windowsName: null }, job, { taskId: "t" })
      .catch((e) => e);
    expect(error.code).toBe("USB_NOT_SUPPORTED");
    expect(error.retryable).toBe(false);

    const direct = await new WinspoolTransport({ waitForJobMs: 0 })
      .send({ printerId: 1, name: "XP-80C", connection: "usb", host: null, port: 9100, paperWidth: 576, windowsName: null }, job, { taskId: "t" })
      .catch((e) => e);
    expect(direct.code).toBe("USB_NOT_SUPPORTED");
  });
});

describe("heartbeat", () => {
  it("reports every printer, and does not probe a printer that is busy printing", async () => {
    const dir = tempDir();
    const config = defaultConfig(appPaths(dir));
    const transport = new RecordingTransport();
    transport.delayMs = 400; // printer 1 busy
    const dispatcher = new Dispatcher({
      config,
      transport,
      content: new ContentCache({ downloadContent: async () => (await import("./helpers")).makePng() }),
      journal: new Journal(`${dir}/j.json`),
      outbox: new AckOutbox(`${dir}/o.json`),
      logger: new MemoryLogger(),
    });
    dispatcher.setPrinters([printer(1), printer(2, { connection: "usb", ip: null })]);

    const checked: number[] = [];
    const sent: any[] = [];
    const heartbeat = new Heartbeat(
      { heartbeat: async (body) => void sent.push(body) },
      dispatcher,
      { check: async (target) => (checked.push(target.printerId), { online: false, code: "PAPER_OUT", message: "Paper out" }) },
      config,
      new MemoryLogger(),
    );

    const { default: crypto } = await import("node:crypto");
    const png = (await import("./helpers")).makePng();
    dispatcher.accept(
      [{
        id: crypto.randomUUID(), claim_token: "c", job_type: "receipt", copies: 1, attempt: 1, max_attempts: 3,
        lease_expires_at: new Date(Date.now() + 120000).toISOString(), printer: printer(1),
        document: { id: "d", kind: "receipt", width: 576, height: 40, sha256: crypto.createHash("sha256").update(png).digest("hex"), content_url: "https://x.test/c" },
      }],
      Date.now(),
      new Date().toISOString(),
    );
    await new Promise((r) => setTimeout(r, 100));

    const reports = await heartbeat.beatOnce();
    expect(checked).toEqual([2]); // printer 1 is printing: not probed
    expect(reports.find((r) => r.id === 1)).toMatchObject({ online: true });
    expect(reports.find((r) => r.id === 2)).toMatchObject({ online: false, status_code: "PAPER_OUT" });
    expect(sent[0]).toMatchObject({ app_version: expect.any(String), printers: expect.any(Array) });
    expect(heartbeat.health(2)?.code).toBe("PAPER_OUT");
  });
});
