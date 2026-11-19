import { PNG } from "pngjs";
import { DLE, ESC, GS } from "./commands";

/**
 * Turns ESC/POS bytes back into pictures: one page per cut.
 * Used by the fake printer (to save a preview PNG) and by tests.
 * Understands only the commands FoodMonsterPrint sends; other bytes are skipped.
 */
export interface DecodedPage {
  width: number;
  height: number;
  /** One byte per pixel: 1 = black, 0 = white. */
  pixels: Uint8Array;
  feedLines: number;
}

export interface DecodeResult {
  pages: DecodedPage[];
  cuts: number;
  unknownBytes: number;
}

interface Block {
  width: number;
  height: number;
  data: Buffer;
  widthBytes: number;
}

export function decodeEscPos(bytes: Buffer): DecodeResult {
  const pages: DecodedPage[] = [];
  let blocks: Block[] = [];
  let feed = 0;
  let cuts = 0;
  let unknownBytes = 0;

  const finishPage = () => {
    if (blocks.length === 0 && feed === 0) {
      return;
    }
    pages.push(blocksToPage(blocks, feed));
    blocks = [];
    feed = 0;
  };

  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];

    if (b === ESC && bytes[i + 1] === 0x40) { // ESC @
      i += 2;
    } else if (b === ESC && bytes[i + 1] === 0x61) { // ESC a n
      i += 3;
    } else if (b === ESC && bytes[i + 1] === 0x64) { // ESC d n
      feed += bytes[i + 2] ?? 0;
      i += 3;
    } else if (b === GS && bytes[i + 1] === 0x56) { // GS V m [n]
      const m = bytes[i + 2];
      i += m === 0x41 || m === 0x42 || m === 65 || m === 66 ? 4 : 3;
      cuts++;
      finishPage();
    } else if (b === GS && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) { // GS v 0
      const widthBytes = bytes[i + 4] | (bytes[i + 5] << 8);
      const height = bytes[i + 6] | (bytes[i + 7] << 8);
      const start = i + 8;
      const length = widthBytes * height;
      blocks.push({ width: widthBytes * 8, height, widthBytes, data: bytes.subarray(start, start + length) });
      i = start + length;
    } else if (b === DLE && bytes[i + 1] === 0x04) { // DLE EOT n
      i += 3;
    } else {
      unknownBytes++;
      i += 1;
    }
  }
  finishPage();

  return { pages, cuts, unknownBytes };
}

function blocksToPage(blocks: Block[], feedLines: number): DecodedPage {
  const width = blocks.reduce((max, block) => Math.max(max, block.width), 0);
  const height = blocks.reduce((sum, block) => sum + block.height, 0);
  const pixels = new Uint8Array(Math.max(1, width * height));

  let rowOffset = 0;
  for (const block of blocks) {
    for (let y = 0; y < block.height; y++) {
      for (let x = 0; x < block.width; x++) {
        const byte = block.data[y * block.widthBytes + (x >> 3)] ?? 0;
        if (byte & (0x80 >> (x & 7))) {
          pixels[(rowOffset + y) * width + x] = 1;
        }
      }
    }
    rowOffset += block.height;
  }

  return { width, height, pixels, feedLines };
}

/** PNG preview of a decoded page (white background, black dots). */
export function pageToPng(page: DecodedPage): Buffer {
  const width = Math.max(1, page.width);
  const height = Math.max(1, page.height);
  const png = new PNG({ width, height });
  for (let p = 0; p < width * height; p++) {
    const value = page.pixels[p] ? 0 : 255;
    png.data[p * 4] = value;
    png.data[p * 4 + 1] = value;
    png.data[p * 4 + 2] = value;
    png.data[p * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}
