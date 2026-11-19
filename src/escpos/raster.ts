import { PNG } from "pngjs";
import { PrintError } from "../errors";
import { ALIGN_LEFT, CUT, INIT, feedLines, rasterHeader } from "./commands";

/**
 * A black & white image packed 8 pixels per byte (bit 1 = black dot), as the printer wants it.
 */
export interface MonoBitmap {
  width: number;
  height: number;
  bytesPerRow: number;
  data: Buffer;
}

/**
 * Decode a PNG and make it exactly `printerWidth` dots wide:
 *  - narrower image: white is added on the right;
 *  - wider image: the right side is cut off (the server already checks the width, so this is rare).
 * Empty white rows at the bottom are removed (saves paper; we feed before cutting anyway).
 */
export function pngToBitmap(png: Buffer, printerWidth: number): MonoBitmap {
  let image: PNG;
  try {
    image = PNG.sync.read(png);
  } catch (error) {
    throw new PrintError("BAD_IMAGE", `The receipt image could not be read: ${(error as Error).message}`, false);
  }
  if (image.width <= 0 || image.height <= 0) {
    throw new PrintError("BAD_IMAGE", "The receipt image is empty.", false);
  }

  const width = printerWidth;
  const bytesPerRow = Math.ceil(width / 8);
  const copyWidth = Math.min(image.width, width);
  const data = Buffer.alloc(bytesPerRow * image.height);
  let lastInkRow = -1;

  for (let y = 0; y < image.height; y++) {
    let rowHasInk = false;
    for (let x = 0; x < copyWidth; x++) {
      const i = (y * image.width + x) * 4;
      const alpha = image.data[i + 3];
      // Transparent counts as white. Luminance < 128 = black.
      const luminance = image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114;
      if (alpha >= 128 && luminance < 128) {
        data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
        rowHasInk = true;
      }
    }
    if (rowHasInk) {
      lastInkRow = y;
    }
  }

  const height = Math.max(1, lastInkRow + 1);
  return { width, height, bytesPerRow, data: data.subarray(0, bytesPerRow * height) };
}

/**
 * Split the bitmap into GS v 0 blocks of at most `chunkRows` rows.
 * Small blocks are safer: some printers (cheap Xprinter models) have a small receive buffer.
 */
export function bitmapToRaster(bitmap: MonoBitmap, chunkRows: number): Buffer {
  const parts: Buffer[] = [];
  for (let start = 0; start < bitmap.height; start += chunkRows) {
    const rows = Math.min(chunkRows, bitmap.height - start);
    parts.push(rasterHeader(bitmap.bytesPerRow, rows));
    parts.push(bitmap.data.subarray(start * bitmap.bytesPerRow, (start + rows) * bitmap.bytesPerRow));
  }
  return Buffer.concat(parts);
}

export interface PrintJobOptions {
  copies: number;
  feedLines: number;
  chunkRows: number;
}

/**
 * Full byte stream for one task: for each copy -> reset, image, feed, cut.
 */
export function buildPrintJob(bitmap: MonoBitmap, options: PrintJobOptions): Buffer {
  const raster = bitmapToRaster(bitmap, options.chunkRows);
  const oneCopy = Buffer.concat([INIT, ALIGN_LEFT, raster, feedLines(options.feedLines), CUT]);
  const copies = Math.max(1, Math.min(10, Math.floor(options.copies || 1)));

  return Buffer.concat(Array.from({ length: copies }, () => oneCopy));
}
