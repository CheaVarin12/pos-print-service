import { describe, expect, it } from "vitest";
import { decodeEscPos } from "../src/escpos/decode";
import { bitmapToRaster, buildPrintJob, pngToBitmap } from "../src/escpos/raster";
import { makePng } from "./helpers";

describe("raster", () => {
  it("packs 576 px into 72 bytes per row with the right bits", () => {
    const bitmap = pngToBitmap(makePng(576, 40), 576);
    expect(bitmap.width).toBe(576);
    expect(bitmap.bytesPerRow).toBe(72);
    expect(bitmap.height).toBe(40);
    // Row 0 is fully black.
    expect(bitmap.data.subarray(0, 72).every((b) => b === 0xff)).toBe(true);
    // Row 10: only the last pixel (x = 575) is black -> last byte = 0b00000001.
    const row10 = bitmap.data.subarray(10 * 72, 11 * 72);
    expect(row10[71]).toBe(0x01);
    expect(row10.subarray(0, 71).every((b) => b === 0)).toBe(true);
  });

  it("pads a narrow image with white and crops a wide one", () => {
    const narrow = pngToBitmap(makePng(560, 10), 576);
    expect(narrow.bytesPerRow).toBe(72);
    expect(narrow.data[5 * 72 + 69]).toBe(0x01); // x = 559 -> byte 69, last bit
    expect(narrow.data[5 * 72 + 71]).toBe(0x00); // padding stays white

    const wide = pngToBitmap(makePng(584, 10), 576);
    expect(wide.bytesPerRow).toBe(72);
    expect(wide.data[2 * 72 + 71]).toBe(0xff); // top bar still full width
    // x = 583 (the only black pixel below the bar) is cut off, so those rows are empty and trimmed.
    expect(wide.height).toBe(4);
  });

  it("removes empty white rows at the bottom", () => {
    const bitmap = pngToBitmap(makePng(576, 40), 576);
    expect(bitmap.height).toBe(40); // last column is black on every row
  });

  it("splits the image into GS v 0 blocks", () => {
    const bitmap = pngToBitmap(makePng(576, 600), 576);
    const raster = bitmapToRaster(bitmap, 255);
    // 600 rows -> 255 + 255 + 90
    expect(raster.length).toBe(3 * 8 + 600 * 72);
    expect([...raster.subarray(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 255, 0]);
  });

  it("builds copies with feed and cut, and decodes back to the same picture", () => {
    const bitmap = pngToBitmap(makePng(576, 300), 576);
    const job = buildPrintJob(bitmap, { copies: 2, feedLines: 4, chunkRows: 128 });
    const decoded = decodeEscPos(job);

    expect(decoded.cuts).toBe(2);
    expect(decoded.pages).toHaveLength(2);
    expect(decoded.unknownBytes).toBe(0);
    for (const page of decoded.pages) {
      expect(page.width).toBe(576);
      expect(page.height).toBe(300);
      expect(page.feedLines).toBe(4);
      expect(page.pixels[0]).toBe(1); // top bar black
      expect(page.pixels[100 * 576 + 575]).toBe(1); // right edge black
      expect(page.pixels[100 * 576 + 10]).toBe(0); // middle white
    }
  });

  it("rejects a broken image with a clear error", () => {
    expect(() => pngToBitmap(Buffer.from("not a png"), 576)).toThrowError(/could not be read/);
  });
});
