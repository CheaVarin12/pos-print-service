export interface PrinterTarget {
  printerId: number;
  name: string;
  connection: "network" | "usb";
  host: string | null;
  port: number;
  paperWidth: number;
}

export interface SendContext {
  taskId: string;
}

/**
 * Sends raw ESC/POS bytes to one printer.
 * Must throw a PrintError. If any byte may have reached the printer, the error must NOT be retryable.
 */
export interface PrinterTransport {
  send(target: PrinterTarget, bytes: Buffer, context: SendContext): Promise<void>;
}
