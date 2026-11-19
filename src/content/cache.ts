import crypto from "node:crypto";
import { ApiClient, ApiError } from "../api/client";
import { ApiDocument } from "../api/types";
import { PrintError } from "../errors";
import { MonoBitmap, pngToBitmap } from "../escpos/raster";

/**
 * Downloads each print image ONCE and shares it between all printers of that document.
 * Two printers asking at the same time share the same download.
 * The sha256 from the server is checked, so a broken download is never printed.
 */
export class ContentCache {
  private readonly bitmaps = new Map<string, { promise: Promise<MonoBitmap>; at: number }>();

  constructor(
    private readonly api: Pick<ApiClient, "downloadContent">,
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  getBitmap(document: ApiDocument, printerWidth: number): Promise<MonoBitmap> {
    this.cleanup();
    const key = `${document.id}|${printerWidth}`;
    const cached = this.bitmaps.get(key);
    if (cached) {
      return cached.promise;
    }

    const promise = this.download(document).then((png) => pngToBitmap(png, printerWidth));
    this.bitmaps.set(key, { promise, at: this.now() });
    // A failed download must not stay in the cache: the next try downloads again.
    promise.catch(() => this.bitmaps.delete(key));

    return promise;
  }

  size(): number {
    return this.bitmaps.size;
  }

  private async download(document: ApiDocument): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await this.api.downloadContent(document.content_url);
    } catch (error) {
      const temporary = error instanceof ApiError ? error.isTemporary : true;
      const message = error instanceof Error ? error.message : String(error);
      throw new PrintError(
        "CONTENT_DOWNLOAD_FAILED",
        `Could not download the receipt image: ${message}`,
        temporary,
      );
    }

    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (document.sha256 && hash !== document.sha256) {
      throw new PrintError("CONTENT_CHECKSUM", "The downloaded receipt image is damaged (checksum mismatch).", true);
    }

    return bytes;
  }

  private cleanup(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.bitmaps) {
      if (entry.at < cutoff) {
        this.bitmaps.delete(key);
      }
    }
  }
}
