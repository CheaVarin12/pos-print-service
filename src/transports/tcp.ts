import net from "node:net";
import { PrintError, fromSocketError } from "../errors";
import { statusRequest } from "../escpos/commands";
import { PrinterHealth, healthFromStatusBytes } from "../escpos/status";
import { PrinterTarget, PrinterTransport, SendContext } from "./types";

export interface TcpOptions {
  connectTimeoutMs: number;
  /** Max time with no progress while sending (printer busy, paper out, cable pulled...). */
  writeTimeoutMs: number;
  /** After sending, wait this long for the printer to close the connection. */
  closeGraceMs?: number;
  /**
   * Before sending a job, ask the printer for its status (DLE EOT 2 and 4) on the same connection.
   * Paper out / cover open -> nothing is sent and a clear, retryable error is returned.
   * A printer that does not answer is printed to normally.
   */
  statusCheck?: boolean;
  statusTimeoutMs?: number;
}

/**
 * Network printer on raw TCP port 9100 (JetDirect), used by Epson and Xprinter LAN printers.
 */
export class TcpTransport implements PrinterTransport {
  constructor(private readonly options: TcpOptions) {}

  async send(target: PrinterTarget, bytes: Buffer, _context: SendContext): Promise<void> {
    if (!target.host) {
      throw new PrintError("NO_PRINTER_ADDRESS", `Printer "${target.name}" has no IP address. Set it in Printer List.`, false);
    }
    await sendTcp(target.host, target.port, bytes, this.options);
  }
}

export function sendTcp(host: string, port: number, bytes: Buffer, options: TcpOptions): Promise<void> {
  const label = `${host}:${port}`;
  const closeGraceMs = options.closeGraceMs ?? 2000;
  const statusTimeoutMs = options.statusTimeoutMs ?? 1500;

  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let connected = false;
    let writeStarted = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let closeTimer: NodeJS.Timeout | null = null;
    let statusTimer: NodeJS.Timeout | null = null;
    let statusReplies: number[] | null = null;

    const bytesSent = () => (writeStarted ? Math.max(1, socket.bytesWritten) : 0);

    const finish = (error?: PrintError) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of [connectTimer, closeTimer, statusTimer]) {
        if (timer) clearTimeout(timer);
      }
      socket.removeAllListeners();
      socket.on("error", () => undefined); // ignore late errors after we are done
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const startJob = () => {
      if (settled || writeStarted) {
        return;
      }
      if (statusTimer) clearTimeout(statusTimer);
      statusReplies = null;
      writeStarted = true;
      // end() = write everything, then close our side. 'finish' = all data handed to the OS.
      socket.end(bytes);
    };

    socket.setNoDelay(true);

    connectTimer = setTimeout(() => {
      finish(new PrintError("CONNECT_TIMEOUT", `No answer from printer ${label} after ${options.connectTimeoutMs / 1000}s. Is it on and on the same network?`, true));
    }, options.connectTimeoutMs);

    socket.once("connect", () => {
      connected = true;
      if (connectTimer) clearTimeout(connectTimer);

      // Inactivity timeout while sending: the printer stopped taking data.
      socket.setTimeout(options.writeTimeoutMs);
      socket.on("timeout", () => {
        if (!writeStarted) {
          return; // status phase has its own timer
        }
        finish(
          new PrintError(
            "WRITE_TIMEOUT",
            `Printer ${label} stopped receiving data for ${options.writeTimeoutMs / 1000}s (paper out, cover open or busy?). Part of the receipt may have printed. Check it and press Reprint if needed.`,
            false,
            bytesSent(),
          ),
        );
      });

      if (options.statusCheck) {
        statusReplies = [];
        socket.write(Buffer.concat([statusRequest(2), statusRequest(4)]));
        statusTimer = setTimeout(startJob, statusTimeoutMs); // no answer: print anyway
      } else {
        startJob();
      }
    });

    socket.on("data", (chunk: Buffer) => {
      if (!statusReplies || writeStarted) {
        return; // printers may send status bytes later; ignore
      }
      statusReplies.push(...chunk);
      if (statusReplies.length < 2) {
        return;
      }
      const health = healthFromStatusBytes({ n2: statusReplies[0], n4: statusReplies[1] });
      if (!health.online) {
        const code = health.code === "COVER_OPEN" ? "COVER_OPEN" : health.code === "PAPER_OUT" ? "PAPER_OUT" : "PRINTER_ERROR";
        // Nothing of the receipt was sent: safe to retry later.
        finish(new PrintError(code, `Printer ${label}: ${health.message}`, true));
        return;
      }
      startJob();
    });

    socket.once("finish", () => {
      // All bytes are sent. Give the printer a moment to close its side, then we are done.
      socket.setTimeout(0);
      closeTimer = setTimeout(() => finish(), closeGraceMs);
    });

    socket.once("close", () => {
      if (settled) {
        return;
      }
      if (!connected || !writeStarted) {
        finish(new PrintError("PRINTER_OFFLINE", `Connection to printer ${label} closed before it was ready.`, true));
        return;
      }
      if (socket.writableFinished) {
        finish();
        return;
      }
      finish(fromSocketError(new Error("connection closed by printer"), label, bytesSent()));
    });

    socket.on("error", (error) => {
      finish(fromSocketError(error, label, connected ? bytesSent() : 0));
    });

    socket.connect({ host, port });
  });
}

/**
 * Health check for the heartbeat: connect, ask DLE EOT 1, 2 and 4, close. Prints nothing.
 */
export function probeTcpStatus(host: string, port: number, options: { connectTimeoutMs: number; statusTimeoutMs?: number }): Promise<PrinterHealth> {
  const statusTimeoutMs = options.statusTimeoutMs ?? 1500;

  return new Promise<PrinterHealth>((resolve) => {
    const socket = new net.Socket();
    const replies: number[] = [];
    let done = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (health: PrinterHealth) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(health);
    };

    timer = setTimeout(
      () => finish({ online: false, code: "UNREACHABLE", message: `No answer from ${host}:${port}. Is the printer on and on the same network?` }),
      options.connectTimeoutMs,
    );

    socket.once("connect", () => {
      if (timer) clearTimeout(timer);
      socket.write(Buffer.concat([statusRequest(1), statusRequest(2), statusRequest(4)]));
      timer = setTimeout(() => finish(healthFromStatusBytes({ n1: replies[0], n2: replies[1], n4: replies[2] })), statusTimeoutMs);
    });
    socket.on("data", (chunk: Buffer) => {
      replies.push(...chunk);
      if (replies.length >= 3) {
        finish(healthFromStatusBytes({ n1: replies[0], n2: replies[1], n4: replies[2] }));
      }
    });
    socket.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish({
        online: false,
        code: "UNREACHABLE",
        message: code === "ECONNREFUSED" ? `Printer ${host}:${port} refused the connection (busy or off?).` : `Cannot reach ${host}:${port} (${code ?? error.message}).`,
      });
    });

    socket.connect({ host, port });
  });
}
