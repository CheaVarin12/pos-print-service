import { ApiPrinter } from "../api/types";
import { AppConfig } from "../config";
import { PrintError } from "../errors";
import { PrinterHealth } from "../escpos/status";
import { FakeTransport } from "./fake";
import { TcpTransport, probeTcpStatus } from "./tcp";
import { PrinterTarget, PrinterTransport, SendContext } from "./types";
import { WinspoolTransport } from "./winspool";

/**
 * Picks how to talk to a printer:
 *  - printerMode "fake": save to files (every printer)
 *  - network printer: raw TCP 9100
 *  - USB printer: Windows spooler (RAW)
 */
export class TransportRouter implements PrinterTransport {
  private readonly tcp: TcpTransport;
  private readonly fake: FakeTransport;
  private readonly usb: PrinterTransport;

  constructor(private readonly config: AppConfig, usb?: PrinterTransport) {
    this.tcp = new TcpTransport(config.tcp);
    this.fake = new FakeTransport(config.fakeOutputDir);
    this.usb = usb ?? (process.platform === "win32" ? new WinspoolTransport(config.usb) : new UsbOnlyOnWindows());
  }

  send(target: PrinterTarget, bytes: Buffer, context: SendContext): Promise<void> {
    if (this.config.printerMode === "fake") {
      return this.fake.send(target, bytes, context);
    }
    if (target.connection === "usb") {
      return this.usb.send(target, bytes, context);
    }
    return this.tcp.send(target, bytes, context);
  }
}

/**
 * Reads printer health for the heartbeat and the status page. Never prints anything.
 */
export class PrinterHealthChecker {
  private readonly winspool: WinspoolTransport | null;

  constructor(private readonly config: AppConfig) {
    this.winspool = process.platform === "win32" ? new WinspoolTransport(config.usb) : null;
  }

  async check(target: PrinterTarget): Promise<PrinterHealth> {
    if (this.config.printerMode === "fake") {
      return { online: true, code: "OK", message: "Fake printer mode" };
    }
    if (target.connection === "usb") {
      if (!this.winspool) {
        return { online: false, code: "UNKNOWN", message: "USB printers can only be checked on Windows." };
      }
      return this.winspool.health(target);
    }
    if (!target.host) {
      return { online: false, code: "NOT_FOUND", message: "No IP address set in Printer List." };
    }
    if (!this.config.heartbeat.probeNetworkPrinters) {
      return { online: true, code: "UNKNOWN", message: "Status check is turned off." };
    }
    return probeTcpStatus(target.host, target.port, {
      connectTimeoutMs: Math.min(this.config.tcp.connectTimeoutMs, 3000),
      statusTimeoutMs: this.config.tcp.statusTimeoutMs,
    });
  }
}

/** Server printer -> where to send, with config.printerOverrides applied. */
export function resolveTarget(printer: ApiPrinter, config: AppConfig): PrinterTarget {
  const override = config.printerOverrides[String(printer.id)] ?? {};
  const host = override.ip ?? printer.ip ?? null;

  return {
    printerId: printer.id,
    name: printer.name ?? `#${printer.id}`,
    // An override with an IP turns any printer into a network printer (handy for testing).
    connection: override.ip ? "network" : printer.connection,
    host: host && host.trim() !== "" ? host.trim() : null,
    port: override.port ?? printer.port ?? 9100,
    paperWidth: printer.paper_width || 576,
    windowsName: override.windowsPrinter?.trim() || null,
  };
}

class UsbOnlyOnWindows implements PrinterTransport {
  async send(target: PrinterTarget): Promise<void> {
    throw new PrintError(
      "USB_NOT_SUPPORTED",
      `Printer "${target.name}" is a USB printer. USB printers work only when FoodMonsterPrint runs on Windows (use printerMode "fake" or printerOverrides to test on a Mac).`,
      false,
    );
  }
}
