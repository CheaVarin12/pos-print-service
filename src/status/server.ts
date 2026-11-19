import http from "node:http";
import { Logger } from "../logger";

/**
 * Local status page: http://127.0.0.1:9123  (only this PC can open it).
 *   GET  /            -> HTML page (service, server connection, printers, last jobs, pairing form)
 *   GET  /api/status  -> the same data as JSON
 *   POST /pair        -> pair this device with a code (form field "code")
 *
 * Binding the port also makes sure only ONE copy of the service runs.
 */
export interface StatusProvider {
  status(): Record<string, unknown>;
  pair(code: string): Promise<void>;
}

export class StatusServer {
  private server: http.Server | null = null;

  constructor(
    private readonly port: number,
    private readonly provider: StatusProvider,
    private readonly logger: Logger,
  ) {}

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.logger.error("status page error", { error: String(error) });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          }
          res.end("Internal error");
        });
      });
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Block other websites (DNS rebinding / cross-site posts): only our own host names are allowed.
    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!allowedHosts.includes(String(req.headers.host ?? ""))) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(this.provider.status(), null, 2));
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(this.provider.status(), url.searchParams.get("msg")));
      return;
    }

    if (req.method === "POST" && url.pathname === "/pair") {
      const origin = req.headers.origin;
      if (origin && !allowedHosts.map((h) => `http://${h}`).includes(origin)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readBody(req, 4096);
      const code = new URLSearchParams(body).get("code") ?? "";
      let message: string;
      try {
        await this.provider.pair(code);
        message = "Paired successfully.";
      } catch (error) {
        message = `Pairing failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      res.writeHead(303, { Location: `/?msg=${encodeURIComponent(message)}` });
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(s: any, msg: string | null): string {
  const paired = !!s.device;
  const printers: any[] = s.printers ?? [];
  const jobs: any[] = s.recentJobs ?? [];
  const syncOk = s.sync?.lastError ? false : !!s.sync?.lastSyncOkAt;

  const printerRows = printers
    .map(
      (p) => `<tr>
        <td>${esc(p.name)} <small>#${esc(p.id)}</small></td>
        <td>${esc(p.connection)}${p.ip ? " " + esc(p.ip) + ":" + esc(p.port) : ""}</td>
        <td>${esc(p.paperWidth)} dots</td>
        <td><span class="dot ${p.queue?.lastError ? "red" : "green"}"></span>${esc(p.queue?.state ?? "idle")} (${esc(p.queue?.queued ?? 0)} waiting)</td>
        <td>${p.queue?.lastError ? esc(p.queue.lastError.code + ": " + p.queue.lastError.message) : ""}</td>
        <td>${esc(p.queue?.lastPrintedAt ?? "")}</td>
      </tr>`,
    )
    .join("");

  const jobRows = jobs
    .map(
      (j) => `<tr>
        <td>${esc(new Date(j.updatedAt).toLocaleString())}</td>
        <td>${esc(j.printerName)}</td>
        <td class="${j.state === "failed" ? "bad" : j.state === "printed" ? "good" : ""}">${esc(j.state)}</td>
        <td>${esc(j.errorCode ? j.errorCode + ": " + j.error : "")}</td>
        <td><small>${esc(j.id)}</small></td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${paired ? '<meta http-equiv="refresh" content="5">' : ""}
<title>FoodMonsterPrint</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #f6f7f9; color: #1d2330; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  h2 { font-size: 16px; margin: 20px 0 8px; }
  .card { background: #fff; border: 1px solid #dde1e7; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .green { background: #1a9b4b; } .red { background: #d23a3a; }
  .good { color: #1a7a3e; font-weight: 600; } .bad { color: #c02d2d; font-weight: 600; }
  .msg { padding: 10px 12px; border-radius: 6px; background: #fff7d6; border: 1px solid #ecd78a; margin-bottom: 12px; }
  input[type=text] { font-size: 18px; padding: 6px 10px; letter-spacing: 2px; text-transform: uppercase; width: 12em; }
  button { font-size: 16px; padding: 7px 14px; }
  small { color: #6b7280; }
</style></head><body>
<h1>FoodMonsterPrint <small>v${esc(s.version)}</small></h1>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<div class="card">
  <div><span class="dot ${paired && syncOk ? "green" : "red"}"></span>
  ${paired ? `Paired as <b>${esc(s.device.name)}</b> (branch #${esc(s.device.branchId)})` : "<b>Not paired yet</b>"} — server ${esc(s.serverUrl)}</div>
  <div><small>Mode: ${esc(s.printerMode)} · last sync OK: ${esc(s.sync?.lastSyncOkAt ?? "never")} ·
  acks waiting: ${esc(s.acks?.pending ?? 0)} · data folder: ${esc(s.dataDir)}</small></div>
  ${s.sync?.lastError ? `<div class="bad">Server problem: ${esc(s.sync.lastError)}</div>` : ""}
  ${s.problem ? `<div class="bad">${esc(s.problem)}</div>` : ""}
</div>
${
  paired
    ? ""
    : `<div class="card"><h2>Pair this computer</h2>
  <p>Create a pairing code in admin (Print Devices) and type it here.</p>
  <form method="post" action="/pair"><input type="text" name="code" autocomplete="off" required maxlength="20">
  <button type="submit">Pair</button></form></div>`
}
<h2>Printers</h2>
<div class="card"><table><tr><th>Printer</th><th>Connection</th><th>Paper</th><th>Status</th><th>Last error</th><th>Last printed</th></tr>
${printerRows || '<tr><td colspan="6"><small>No printers yet (they appear after the first sync).</small></td></tr>'}</table></div>
<h2>Last jobs</h2>
<div class="card"><table><tr><th>Time</th><th>Printer</th><th>Result</th><th>Error</th><th>Task</th></tr>
${jobRows || '<tr><td colspan="5"><small>No jobs yet.</small></td></tr>'}</table></div>
</body></html>`;
}
