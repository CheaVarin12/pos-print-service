/**
 * Printer health, from ESC/POS real-time status (DLE EOT n) for network printers,
 * or from the Windows spooler for USB printers.
 */
export type HealthCode =
  | "OK"
  | "PAPER_NEAR_END"
  | "PAPER_OUT"
  | "COVER_OPEN"
  | "OFFLINE"
  | "PRINTER_ERROR"
  | "NO_STATUS"
  | "UNREACHABLE"
  | "NOT_FOUND"
  | "UNKNOWN";

export interface PrinterHealth {
  /** Can it print right now? (PAPER_NEAR_END and NO_STATUS still count as online.) */
  online: boolean;
  code: HealthCode;
  message: string;
}

/** A real status byte always has bit 1 and bit 4 set, and bits 0 and 7 clear. */
export function isStatusByte(byte: number | undefined): byte is number {
  return byte !== undefined && (byte & 0x93) === 0x12;
}

/**
 * Combine the answers to DLE EOT 1 (printer), 2 (offline cause) and 4 (paper sensor).
 * Missing or invalid answers are ignored (many printers answer only some of them).
 */
export function healthFromStatusBytes(answers: { n1?: number; n2?: number; n4?: number }): PrinterHealth {
  const n1 = isStatusByte(answers.n1) ? answers.n1 : undefined;
  const n2 = isStatusByte(answers.n2) ? answers.n2 : undefined;
  const n4 = isStatusByte(answers.n4) ? answers.n4 : undefined;

  if (n1 === undefined && n2 === undefined && n4 === undefined) {
    return { online: true, code: "NO_STATUS", message: "Printer is reachable but does not report its status." };
  }
  if (n2 !== undefined && n2 & 0x04) {
    return { online: false, code: "COVER_OPEN", message: "Printer cover is open. Close the cover." };
  }
  if ((n4 !== undefined && (n4 & 0x60) === 0x60) || (n2 !== undefined && n2 & 0x20)) {
    return { online: false, code: "PAPER_OUT", message: "Printer is out of paper. Put in a new paper roll." };
  }
  if (n2 !== undefined && n2 & 0x40) {
    return { online: false, code: "PRINTER_ERROR", message: "Printer reports an error (cutter jam or head too hot?). Turn it off and on." };
  }
  if (n1 !== undefined && n1 & 0x08) {
    return { online: false, code: "OFFLINE", message: "Printer is offline (paper feed button pressed or error)." };
  }
  if (n4 !== undefined && (n4 & 0x0c) === 0x0c) {
    return { online: true, code: "PAPER_NEAR_END", message: "Paper is almost finished." };
  }
  return { online: true, code: "OK", message: "Ready" };
}

/** Windows spooler PRINTER_INFO status flags (winspool.h). */
export const SPOOLER_STATUS = {
  PAUSED: 0x1,
  ERROR: 0x2,
  PENDING_DELETION: 0x4,
  PAPER_JAM: 0x8,
  PAPER_OUT: 0x10,
  PAPER_PROBLEM: 0x40,
  OFFLINE: 0x80,
  NOT_AVAILABLE: 0x1000,
  USER_INTERVENTION: 0x100000,
  DOOR_OPEN: 0x400000,
} as const;

export const PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x400;

/**
 * Spooler status of a USB printer. Note: many USB thermal drivers do not report problems,
 * so "OK" here only means Windows sees no problem.
 */
export function healthFromSpooler(status: number, attributes: number, jobsInQueue: number): PrinterHealth {
  const s = SPOOLER_STATUS;
  if (attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) {
    return { online: false, code: "OFFLINE", message: 'Windows is set to "Use Printer Offline". Turn it off in the printer queue.' };
  }
  if (status & s.PAUSED) {
    return { online: false, code: "OFFLINE", message: "The Windows printer queue is paused. Resume it." };
  }
  if (status & s.DOOR_OPEN) {
    return { online: false, code: "COVER_OPEN", message: "Printer cover is open." };
  }
  if (status & (s.PAPER_OUT | s.PAPER_PROBLEM | s.PAPER_JAM)) {
    return { online: false, code: "PAPER_OUT", message: "Printer has a paper problem (out of paper or jam)." };
  }
  if (status & (s.OFFLINE | s.NOT_AVAILABLE)) {
    return { online: false, code: "OFFLINE", message: "Printer is offline or not connected (check the USB cable and power)." };
  }
  if (status & (s.ERROR | s.USER_INTERVENTION | s.PENDING_DELETION)) {
    return { online: false, code: "PRINTER_ERROR", message: "Windows reports a printer error. Open the printer queue to see it." };
  }
  const queueNote = jobsInQueue > 0 ? ` (${jobsInQueue} job(s) in the Windows queue)` : "";
  return { online: true, code: "OK", message: `Ready${queueNote}` };
}

/** Windows JOB_INFO status flags (winspool.h). */
export const JOB_STATUS = {
  PAUSED: 0x1,
  ERROR: 0x2,
  DELETING: 0x4,
  SPOOLING: 0x8,
  PRINTING: 0x10,
  OFFLINE: 0x20,
  PAPEROUT: 0x40,
  PRINTED: 0x80,
  DELETED: 0x100,
  BLOCKED_DEVQ: 0x200,
  USER_INTERVENTION: 0x400,
  COMPLETE: 0x1000,
} as const;

export type JobState = "done" | "waiting" | "printing" | "problem";

export function jobStateFromStatus(status: number): { state: JobState; reason: string } {
  const j = JOB_STATUS;
  if (status & (j.PRINTED | j.COMPLETE)) return { state: "done", reason: "printed" };
  if (status & j.PAPEROUT) return { state: "problem", reason: "Printer is out of paper." };
  if (status & j.OFFLINE) return { state: "problem", reason: "Printer is offline (check USB cable and power)." };
  if (status & (j.ERROR | j.BLOCKED_DEVQ | j.USER_INTERVENTION)) return { state: "problem", reason: "Windows reports an error for this print job." };
  if (status & j.PAUSED) return { state: "problem", reason: "The print job is paused in Windows." };
  if (status & j.PRINTING) return { state: "printing", reason: "printing" };
  return { state: "waiting", reason: "waiting in the Windows queue" };
}
