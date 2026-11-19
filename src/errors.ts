/**
 * Print errors with a code (for the server/admin) and a plain-English message (for staff).
 *
 * retryable:  safe to try again (nothing was sent to the printer yet).
 * partial:    some bytes were already sent -> NEVER retry automatically (could print twice).
 */
export type PrintErrorCode =
  | "CONNECT_TIMEOUT"
  | "CONN_REFUSED"
  | "HOST_UNREACHABLE"
  | "PRINTER_OFFLINE"
  | "WRITE_TIMEOUT"
  | "PARTIAL_WRITE"
  | "CONTENT_DOWNLOAD_FAILED"
  | "CONTENT_CHECKSUM"
  | "BAD_IMAGE"
  | "NO_PRINTER_ADDRESS"
  | "USB_NOT_SUPPORTED"
  | "USB_PRINTER_NOT_FOUND"
  | "USB_PRINTER_OFFLINE"
  | "SPOOLER_ERROR"
  | "PAPER_OUT"
  | "COVER_OPEN"
  | "PRINTER_ERROR"
  | "UNCERTAIN_RESTART"
  | "PRINT_FAILED";

export class PrintError extends Error {
  constructor(
    readonly code: PrintErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly bytesSent = 0,
  ) {
    super(message);
    this.name = "PrintError";
  }
}

/**
 * Turn a socket error into a PrintError with a clear message.
 */
export function fromSocketError(error: unknown, target: string, bytesSent: number): PrintError {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  const raw = error instanceof Error ? error.message : String(error);

  if (bytesSent > 0) {
    return new PrintError(
      "PARTIAL_WRITE",
      `Connection to printer ${target} broke while printing (${raw}). Part of the receipt may have printed. Check the paper and press Reprint if needed.`,
      false,
      bytesSent,
    );
  }

  switch (code) {
    case "ECONNREFUSED":
      return new PrintError("CONN_REFUSED", `Printer ${target} refused the connection. Is it on? Is another program using it?`, true);
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EHOSTDOWN":
      return new PrintError("HOST_UNREACHABLE", `Printer ${target} cannot be reached. Check the network cable and the printer IP.`, true);
    case "ETIMEDOUT":
      return new PrintError("CONNECT_TIMEOUT", `No answer from printer ${target}. Is it on and on the same network?`, true);
    case "ECONNRESET":
    case "EPIPE":
      return new PrintError("PRINTER_OFFLINE", `Printer ${target} closed the connection (${raw}).`, true);
    default:
      return new PrintError("PRINTER_OFFLINE", `Cannot print to ${target}: ${raw}`, true);
  }
}

export function toPrintError(error: unknown): PrintError {
  if (error instanceof PrintError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new PrintError("PRINT_FAILED", message, false);
}
