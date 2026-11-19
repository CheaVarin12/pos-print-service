import { ApiPrinter } from "../api/types";
import { AppConfig } from "../config";
import { PrintError } from "../errors";
import { FakeTransport } from "./fake";
import { TcpTransport } from "./tcp";
import { PrinterTarget, PrinterTransport, SendContext } from "./types";

/**
 * Picks how to talk to a printer:
 *  - printerMode "fake": save to files (every printer)
 *  - network printer: raw TCP 9100
 *  - USB printer: Windows spooler (added in Phase 3)
 */
export class TransportRouter implements PrinterTransport {
  private readonly tcp: TcpTransport;
  private readonly fake: FakeTransport;

  constructor(private readonly config: AppConfig, private readonly usb: PrinterTransport = new UsbNotSupportedYet()) {
    this.tcp = new TcpTransport(config.tcp);
    this.fake = new FakeTransport(config.fakeOutputDir);
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
  };
}

class UsbNotSupportedYet implements PrinterTransport {
  async send(target: PrinterTarget): Promise<void> {
    throw new PrintError(
      "USB_NOT_SUPPORTED",
      `Printer "${target.name}" is a USB printer. USB printing comes in the next version of FoodMonsterPrint.`,
      false,
    );
  }
}
