import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { PNG } from "pngjs";
import { ApiPrinter } from "../src/api/types";
import { PrintError } from "../src/errors";
import { PrinterTarget, PrinterTransport, SendContext } from "../src/transports/types";

export function tempDir(prefix = "fmp-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A PNG with a black bar at the top and a black pixel in the last column. */
export function makePng(width = 576, height = 40): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const black = y < 4 || x === width - 1;
      const i = (y * width + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = black ? 0 : 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

export const noSleep = async () => undefined;

/** A printer that records what it receives, and can be told to fail. */
export class RecordingTransport implements PrinterTransport {
  readonly sent: Array<{ printerId: number; taskId: string; bytes: Buffer }> = [];
  /** printerId -> function that returns an error to throw (or null to succeed) */
  readonly failures = new Map<number, (attempt: number) => PrintError | null>();
  private readonly attempts = new Map<number, number>();
  delayMs = 0;

  async send(target: PrinterTarget, bytes: Buffer, context: SendContext): Promise<void> {
    const attempt = (this.attempts.get(target.printerId) ?? 0) + 1;
    this.attempts.set(target.printerId, attempt);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const failure = this.failures.get(target.printerId)?.(attempt) ?? null;
    if (failure) {
      throw failure;
    }
    this.sent.push({ printerId: target.printerId, taskId: context.taskId, bytes });
  }

  attemptsFor(printerId: number): number {
    return this.attempts.get(printerId) ?? 0;
  }
}

export function printer(id: number, extra: Partial<ApiPrinter> = {}): ApiPrinter {
  return { id, name: `Printer ${id}`, connection: "network", ip: `10.0.0.${id}`, port: 9100, paper_width: 576, ...extra };
}

interface MockTask {
  id: string;
  printerId: number;
  documentId: string;
  copies: number;
  status: "pending" | "printing" | "printed" | "failed";
  claimToken: string | null;
  leaseUntil: number;
  attempts: number;
  error?: string | null;
}

/**
 * Small in-memory copy of the Laravel Print Service v2 API (same claim/lease/ack rules).
 */
export class MockServer {
  readonly tasks = new Map<string, MockTask>();
  readonly documents = new Map<string, Buffer>();
  readonly printers: ApiPrinter[] = [];
  readonly token = "pd_test_token";
  contentDownloads = 0;
  ackRequests = 0;
  /** Make the next N ack requests fail with HTTP 500. */
  failNextAcks = 0;
  readonly heartbeats: any[] = [];
  /** Make sync fail (server down). */
  syncDown = false;
  leaseMs = 120000;
  private server: http.Server | null = null;
  url = "";

  addDocument(png = makePng()): string {
    const id = crypto.randomUUID();
    this.documents.set(id, png);
    return id;
  }

  addTask(printerId: number, documentId: string, copies = 1): string {
    const id = crypto.randomUUID();
    this.tasks.set(id, { id, printerId, documentId, copies, status: "pending", claimToken: null, leaseUntil: 0, attempts: 0 });
    return id;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      send(401, { message: "Unauthorized", error_code: "UNAUTHORIZED" });
      return;
    }
    const body = await new Promise<any>((resolve) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => resolve(text ? JSON.parse(text) : {}));
    });
    const url = req.url ?? "";
    const now = Date.now();

    if (url === "/api/print/v2/sync") {
      if (this.syncDown) {
        send(503, { message: "down" });
        return;
      }
      const renewed: string[] = [];
      const lost: string[] = [];
      for (const item of body.in_progress ?? []) {
        const task = this.tasks.get(item.id);
        if (task && task.status === "printing" && task.claimToken === item.claim_token) {
          task.leaseUntil = now + this.leaseMs;
          renewed.push(item.id);
        } else {
          lost.push(item.id);
        }
      }
      for (const task of this.tasks.values()) {
        if (task.status === "printing" && task.leaseUntil < now) {
          task.status = "pending";
        }
      }
      const claimed = [...this.tasks.values()].filter((t) => t.status === "pending");
      for (const task of claimed) {
        task.status = "printing";
        task.claimToken = crypto.randomUUID();
        task.leaseUntil = now + this.leaseMs;
        task.attempts++;
      }
      send(200, {
        status: "success",
        server_time: new Date(now).toISOString(),
        device: { id: "dev", branch_id: 1 },
        leases: { renewed, lost },
        printers: this.printers,
        tasks: claimed.map((task) => ({
          id: task.id,
          claim_token: task.claimToken,
          job_type: "receipt",
          copies: task.copies,
          attempt: task.attempts,
          max_attempts: 3,
          lease_expires_at: new Date(task.leaseUntil).toISOString(),
          printer: this.printers.find((p) => p.id === task.printerId) ?? null,
          document: {
            id: task.documentId,
            kind: "receipt",
            width: 576,
            height: 40,
            sha256: crypto.createHash("sha256").update(this.documents.get(task.documentId)!).digest("hex"),
            content_url: `${this.url}/api/print/v2/documents/${task.documentId}/content`,
          },
        })),
      });
      return;
    }

    if (url === "/api/print/v2/heartbeat") {
      this.heartbeats.push(body);
      send(200, { status: "success", server_time: new Date().toISOString() });
      return;
    }

    if (url === "/api/print/v2/ack") {
      this.ackRequests++;
      if (this.failNextAcks > 0) {
        this.failNextAcks--;
        send(500, { message: "boom" });
        return;
      }
      const results = (body.acks ?? []).map((ack: any) => {
        const task = this.tasks.get(ack.id);
        if (!task) return { id: ack.id, result: "not_found" };
        if (task.status === "printed") return { id: ack.id, result: "already_printed" };
        if (task.claimToken !== ack.claim_token) return { id: ack.id, result: "stale" };
        if (ack.status === "printed") {
          task.status = "printed";
          return { id: ack.id, result: "ok" };
        }
        if (task.status === "failed") return { id: ack.id, result: "already_failed" };
        task.status = "failed";
        task.error = ack.error;
        return { id: ack.id, result: "ok" };
      });
      send(200, { status: "success", results });
      return;
    }

    const match = /^\/api\/print\/v2\/documents\/([^/]+)\/content$/.exec(url);
    if (match) {
      const png = this.documents.get(match[1]);
      if (!png) {
        send(404, { message: "not found" });
        return;
      }
      this.contentDownloads++;
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
      return;
    }

    send(404, { message: "no route" });
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
