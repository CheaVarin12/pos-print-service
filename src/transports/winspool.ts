import { execFile } from "node:child_process";
import { PrintError } from "../errors";
import { PrinterHealth, healthFromSpooler, jobStateFromStatus } from "../escpos/status";
import { PrinterTarget, PrinterTransport, SendContext } from "./types";

/**
 * USB printers on Windows: RAW bytes through the Windows print spooler (winspool.drv), called with koffi.
 * Works with any ESC/POS printer that is installed in Windows (Epson, Xprinter, "Generic / Text Only"...).
 * No printer sharing is needed.
 *
 * Steps for one job:
 *   1. Open the printer by its Windows name and check the spooler status (offline/paused -> do not send).
 *   2. StartDoc("RAW") -> WritePrinter(all bytes) -> EndDoc.
 *   3. Watch the job in the Windows queue until it is gone (= printed). If Windows reports a problem
 *      before printing started, the job is DELETED from the queue (so it never prints hours later)
 *      and a retryable error is returned.
 */
export interface WinspoolOptions {
  /** How long to watch the job after sending. 0 = do not watch (trust the spooler). */
  waitForJobMs: number;
  pollMs?: number;
}

const ERROR_INVALID_PRINTER_NAME = 1801;
const JOB_CONTROL_DELETE = 5;

type Fn = (...args: any[]) => any;

interface WinspoolApi {
  OpenPrinterW: Fn;
  ClosePrinter: Fn;
  StartDocPrinterW: Fn;
  StartPagePrinter: Fn;
  EndPagePrinter: Fn;
  EndDocPrinter: Fn;
  AbortPrinter: Fn;
  WritePrinter: Fn;
  GetPrinterW: Fn;
  GetJobW: Fn;
  SetJobW: Fn;
  GetLastError: Fn;
}

let cachedApi: WinspoolApi | null = null;

function loadApi(): WinspoolApi {
  if (process.platform !== "win32") {
    throw new PrintError("USB_NOT_SUPPORTED", "USB printers can only be used on Windows.", false);
  }
  if (cachedApi) {
    return cachedApi;
  }
  // Loaded only on Windows, so tests on a Mac never need the native module.
  const koffi = require("koffi");
  const winspool = koffi.load("winspool.drv");
  const kernel32 = koffi.load("kernel32.dll");

  koffi.pointer("FMP_HANDLE", koffi.opaque());
  koffi.struct("FMP_DOC_INFO_1W", { pDocName: "str16", pOutputFile: "str16", pDatatype: "str16" });

  cachedApi = {
    OpenPrinterW: winspool.func("bool __stdcall OpenPrinterW(str16 pPrinterName, _Out_ FMP_HANDLE *phPrinter, void *pDefault)"),
    ClosePrinter: winspool.func("bool __stdcall ClosePrinter(FMP_HANDLE hPrinter)"),
    StartDocPrinterW: winspool.func("uint32_t __stdcall StartDocPrinterW(FMP_HANDLE hPrinter, uint32_t Level, FMP_DOC_INFO_1W *pDocInfo)"),
    StartPagePrinter: winspool.func("bool __stdcall StartPagePrinter(FMP_HANDLE hPrinter)"),
    EndPagePrinter: winspool.func("bool __stdcall EndPagePrinter(FMP_HANDLE hPrinter)"),
    EndDocPrinter: winspool.func("bool __stdcall EndDocPrinter(FMP_HANDLE hPrinter)"),
    AbortPrinter: winspool.func("bool __stdcall AbortPrinter(FMP_HANDLE hPrinter)"),
    WritePrinter: winspool.func("bool __stdcall WritePrinter(FMP_HANDLE hPrinter, const void *pBuf, uint32_t cbBuf, _Out_ uint32_t *pcWritten)"),
    GetPrinterW: winspool.func("bool __stdcall GetPrinterW(FMP_HANDLE hPrinter, uint32_t Level, _Out_ uint8_t *pPrinter, uint32_t cbBuf, _Out_ uint32_t *pcbNeeded)"),
    GetJobW: winspool.func("bool __stdcall GetJobW(FMP_HANDLE hPrinter, uint32_t JobId, uint32_t Level, _Out_ uint8_t *pJob, uint32_t cbBuf, _Out_ uint32_t *pcbNeeded)"),
    SetJobW: winspool.func("bool __stdcall SetJobW(FMP_HANDLE hPrinter, uint32_t JobId, uint32_t Level, void *pJob, uint32_t Command)"),
    GetLastError: kernel32.func("uint32_t __stdcall GetLastError()"),
  };
  return cachedApi;
}

/** Pointer size: 8 on 64-bit Windows, 4 on 32-bit. Used to read fixed fields after the string pointers. */
const PTR = process.arch === "ia32" ? 4 : 8;

/** PRINTER_INFO_2W: 13 pointers, then Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, cJobs. */
const PI2_ATTRIBUTES = 13 * PTR;
const PI2_STATUS = 13 * PTR + 5 * 4;
const PI2_JOBS = 13 * PTR + 6 * 4;

/** JOB_INFO_1W: JobId (DWORD, padded to pointer size), 6 pointers, then Status, Priority, Position, TotalPages, PagesPrinted. */
const JI1_STATUS = PTR + 6 * PTR;
const JI1_PAGES_PRINTED = JI1_STATUS + 4 * 4;

export class WinspoolTransport implements PrinterTransport {
  constructor(private readonly options: WinspoolOptions) {}

  async send(target: PrinterTarget, bytes: Buffer, context: SendContext): Promise<void> {
    const api = loadApi();
    const name = target.windowsName ?? target.name;
    const handle = await openPrinter(api, name);

    let jobId = 0;
    let written = 0;
    try {
      const health = readSpoolerHealth(api, handle);
      if (health && !health.online) {
        throw new PrintError("USB_PRINTER_OFFLINE", `Printer "${name}": ${health.message}`, true);
      }

      jobId = api.StartDocPrinterW(handle, 1, { pDocName: `FoodMonsterPrint ${context.taskId.slice(0, 8)}`, pOutputFile: null, pDatatype: "RAW" });
      if (!jobId) {
        throw new PrintError("SPOOLER_ERROR", `Windows could not start a print job on "${name}" (error ${api.GetLastError()}).`, true);
      }
      api.StartPagePrinter(handle);

      while (written < bytes.length) {
        const chunk = bytes.subarray(written, Math.min(bytes.length, written + 65536));
        const out = [0];
        if (!api.WritePrinter(handle, chunk, chunk.length, out) || out[0] === 0) {
          const code = api.GetLastError();
          api.AbortPrinter(handle); // delete the unfinished job
          jobId = 0;
          throw new PrintError(
            written === 0 ? "SPOOLER_ERROR" : "PARTIAL_WRITE",
            `Windows stopped taking data for "${name}" (error ${code}).${written > 0 ? " Part of the receipt may have printed. Check it and press Reprint if needed." : ""}`,
            written === 0,
            written,
          );
        }
        written += out[0];
      }

      api.EndPagePrinter(handle);
      if (!api.EndDocPrinter(handle)) {
        throw new PrintError("SPOOLER_ERROR", `Windows could not finish the print job on "${name}" (error ${api.GetLastError()}).`, false, written);
      }

      if (this.options.waitForJobMs > 0) {
        await this.waitForJob(api, handle, jobId, name, written);
      }
    } finally {
      api.ClosePrinter(handle);
    }
  }

  /** Spooler health of a USB printer (heartbeat). */
  async health(target: PrinterTarget): Promise<PrinterHealth> {
    const api = loadApi();
    const name = target.windowsName ?? target.name;
    let handle: unknown;
    try {
      handle = await openPrinter(api, name);
    } catch (error) {
      return { online: false, code: "NOT_FOUND", message: error instanceof Error ? error.message : String(error) };
    }
    try {
      return readSpoolerHealth(api, handle) ?? { online: true, code: "UNKNOWN", message: "Windows did not report a status." };
    } finally {
      api.ClosePrinter(handle);
    }
  }

  private async waitForJob(api: WinspoolApi, handle: unknown, jobId: number, name: string, written: number): Promise<void> {
    const pollMs = this.options.pollMs ?? 250;
    const deadline = Date.now() + this.options.waitForJobMs;
    let sawPrinting = false;

    while (Date.now() < deadline) {
      const job = readJob(api, handle, jobId);
      if (!job) {
        return; // the job left the queue: it was printed
      }
      const state = jobStateFromStatus(job.status);
      if (state.state === "done") {
        return;
      }
      if (state.state === "printing" || job.pagesPrinted > 0) {
        sawPrinting = true;
      }
      if (state.state === "problem") {
        api.SetJobW(handle, jobId, 0, null, JOB_CONTROL_DELETE);
        if (sawPrinting) {
          throw new PrintError("PARTIAL_WRITE", `Printer "${name}": ${state.reason} It stopped while printing. Check the paper and press Reprint if needed.`, false, written);
        }
        // Nothing printed yet and the job is deleted: safe to try again later.
        throw new PrintError("USB_PRINTER_OFFLINE", `Printer "${name}": ${state.reason}`, true);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (sawPrinting) {
      // Still printing after the wait (very long receipt): it is going out, count it as printed.
      return;
    }
    // Never started: delete it so it cannot print by surprise later, then retry.
    api.SetJobW(handle, jobId, 0, null, JOB_CONTROL_DELETE);
    throw new PrintError(
      "USB_PRINTER_OFFLINE",
      `Printer "${name}" did not start printing within ${Math.round(this.options.waitForJobMs / 1000)}s (off, unplugged or out of paper?). The job was removed from the Windows queue.`,
      true,
    );
  }
}

async function openPrinter(api: WinspoolApi, name: string): Promise<unknown> {
  const out = [null];
  if (api.OpenPrinterW(name, out, null) && out[0]) {
    return out[0];
  }
  const code = api.GetLastError();
  const installed = await listWindowsPrinters().catch(() => [] as string[]);
  const hint = installed.length ? ` Installed printers: ${installed.join(", ")}.` : "";
  if (code === ERROR_INVALID_PRINTER_NAME || installed.length > 0) {
    throw new PrintError(
      "USB_PRINTER_NOT_FOUND",
      `Windows printer "${name}" was not found. The printer name in Printer List must be exactly the Windows printer name (or set printerOverrides.windowsPrinter).${hint}`,
      false,
    );
  }
  throw new PrintError("SPOOLER_ERROR", `Cannot open Windows printer "${name}" (error ${code}). Is the Print Spooler service running?`, true);
}

function readSpoolerHealth(api: WinspoolApi, handle: unknown): PrinterHealth | null {
  let buffer = Buffer.alloc(8192);
  const needed = [0];
  if (!api.GetPrinterW(handle, 2, buffer, buffer.length, needed)) {
    if (needed[0] > buffer.length && needed[0] < 1024 * 1024) {
      buffer = Buffer.alloc(needed[0]);
      if (!api.GetPrinterW(handle, 2, buffer, buffer.length, needed)) {
        return null;
      }
    } else {
      return null;
    }
  }
  return healthFromSpooler(buffer.readUInt32LE(PI2_STATUS), buffer.readUInt32LE(PI2_ATTRIBUTES), buffer.readUInt32LE(PI2_JOBS));
}

function readJob(api: WinspoolApi, handle: unknown, jobId: number): { status: number; pagesPrinted: number } | null {
  let buffer = Buffer.alloc(4096);
  const needed = [0];
  if (!api.GetJobW(handle, jobId, 1, buffer, buffer.length, needed)) {
    if (needed[0] > buffer.length && needed[0] < 1024 * 1024) {
      buffer = Buffer.alloc(needed[0]);
      if (!api.GetJobW(handle, jobId, 1, buffer, buffer.length, needed)) {
        return null;
      }
    } else {
      return null; // job not found = finished
    }
  }
  return { status: buffer.readUInt32LE(JI1_STATUS), pagesPrinted: buffer.readUInt32LE(JI1_PAGES_PRINTED) };
}

let printerListCache: { at: number; names: string[] } | null = null;

/** Names of printers installed in Windows (for error messages and the status page). Cached 60 s. */
export function listWindowsPrinters(): Promise<string[]> {
  if (process.platform !== "win32") {
    return Promise.resolve([]);
  }
  if (printerListCache && Date.now() - printerListCache.at < 60000) {
    return Promise.resolve(printerListCache.names);
  }
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"],
      { timeout: 10000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const names = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        printerListCache = { at: Date.now(), names };
        resolve(names);
      },
    );
  });
}
