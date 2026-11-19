import fs from "node:fs";
import path from "node:path";
import { decodeEscPos, pageToPng } from "../escpos/decode";
import { PrinterTarget, PrinterTransport, SendContext } from "./types";

/**
 * "Fake printer" mode: nothing is printed. Every job is saved as
 *   <dir>/<YYYY-MM-DD>/<time>_printer-<id>_<task>.bin   (the exact bytes a printer would get)
 *   <dir>/<YYYY-MM-DD>/<time>_printer-<id>_<task>_copy-<n>.png   (what the paper would look like)
 * Use it on a Mac or a test PC without printers.
 */
export class FakeTransport implements PrinterTransport {
  constructor(private readonly dir: string) {}

  async send(target: PrinterTarget, bytes: Buffer, context: SendContext): Promise<void> {
    saveFakePrint(this.dir, `printer-${target.printerId}_${context.taskId.slice(0, 8)}`, bytes);
  }
}

/** Save bytes + PNG previews. Returns the written file paths. */
export function saveFakePrint(dir: string, label: string, bytes: Buffer): string[] {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 23).replace(/[:.]/g, "");
  const folder = path.join(dir, day);
  fs.mkdirSync(folder, { recursive: true });

  const base = path.join(folder, `${time}_${label}`);
  const written = [`${base}.bin`];
  fs.writeFileSync(`${base}.bin`, bytes);

  const decoded = decodeEscPos(bytes);
  decoded.pages.forEach((page, index) => {
    const file = `${base}_copy-${index + 1}.png`;
    fs.writeFileSync(file, pageToPng(page));
    written.push(file);
  });

  return written;
}
