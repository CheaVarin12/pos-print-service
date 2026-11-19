import net from "node:net";
import { PrintError, fromSocketError } from "../errors";
import { PrinterTarget, PrinterTransport, SendContext } from "./types";

export interface TcpOptions {
  connectTimeoutMs: number;
  /** Max time with no progress while sending (printer busy, paper out, cable pulled...). */
  writeTimeoutMs: number;
  /** After sending, wait this long for the printer to close the connection. */
  closeGraceMs?: number;
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

  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let connected = false;
    let writeStarted = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let closeTimer: NodeJS.Timeout | null = null;

    const bytesSent = () => (writeStarted ? Math.max(1, socket.bytesWritten) : 0);

    const finish = (error?: PrintError) => {
      if (settled) {
        return;
      }
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (closeTimer) clearTimeout(closeTimer);
      socket.removeAllListeners();
      socket.on("error", () => undefined); // ignore late errors after we are done
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
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
        finish(
          new PrintError(
            "WRITE_TIMEOUT",
            `Printer ${label} stopped receiving data for ${options.writeTimeoutMs / 1000}s (paper out, cover open or busy?). Part of the receipt may have printed. Check it and press Reprint if needed.`,
            false,
            bytesSent(),
          ),
        );
      });

      writeStarted = true;
      // end() = write everything, then close our side. 'finish' = all data handed to the OS.
      socket.end(bytes);
    });

    socket.once("finish", () => {
      // All bytes are sent. Give the printer a moment to close its side, then we are done.
      socket.setTimeout(0);
      closeTimer = setTimeout(() => finish(), closeGraceMs);
    });

    socket.on("data", () => undefined); // printers may send status bytes; ignore
    socket.once("close", () => {
      if (settled) {
        return;
      }
      if (!connected) {
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
