import fs from "node:fs";
import path from "node:path";

/**
 * Write a file so it is never half-written: write a temp file, flush it to disk, then rename.
 * If the PC loses power during the write, the old file is still complete.
 * On Windows, antivirus can lock files for a moment (EPERM/EBUSY), so the rename is retried.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;

  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 10) {
        sleepSync(20 * attempt);
        continue;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw error;
    }
  }
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return fallback;
    }
    // A broken file must not stop the service. Keep a copy for debugging and start clean.
    try {
      fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // ignore
    }
    return fallback;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
