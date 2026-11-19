/**
 * ESC/POS commands used by FoodMonsterPrint. Supported by Epson TM series and Xprinter.
 */
export const ESC = 0x1b;
export const GS = 0x1d;
export const DLE = 0x10;
export const EOT = 0x04;

/** ESC @ — reset the printer to its default settings. */
export const INIT = Buffer.from([ESC, 0x40]);

/** ESC a 0 — left align (the image is already the full paper width). */
export const ALIGN_LEFT = Buffer.from([ESC, 0x61, 0x00]);

/** ESC d n — print and feed n lines. */
export function feedLines(lines: number): Buffer {
  return Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, lines))]);
}

/** GS V 66 0 — feed to the cutter and partial cut. */
export const CUT = Buffer.from([GS, 0x56, 0x42, 0x00]);

/**
 * GS v 0 header — print a raster image block.
 * widthBytes = dots / 8 (72 for 576 dots), heightRows = number of rows in this block.
 */
export function rasterHeader(widthBytes: number, heightRows: number): Buffer {
  return Buffer.from([
    GS, 0x76, 0x30, 0x00,
    widthBytes & 0xff, (widthBytes >> 8) & 0xff,
    heightRows & 0xff, (heightRows >> 8) & 0xff,
  ]);
}

/** DLE EOT n — real-time status request (used in Phase 3). */
export function statusRequest(n: 1 | 2 | 3 | 4): Buffer {
  return Buffer.from([DLE, EOT, n]);
}
