import fs from "node:fs";
import path from "node:path";

/**
 * Small logger: one JSON line per event, one file per day (service-YYYY-MM-DD.log),
 * files older than `keepDays` are deleted. Also prints to the console (visible when run by hand;
 * WinSW also captures it).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface FileLoggerOptions {
  dir: string;
  keepDays?: number;
  level?: LogLevel;
  console?: boolean;
}

export class FileLogger implements Logger {
  private currentDay = "";
  private stream: fs.WriteStream | null = null;
  private readonly keepDays: number;
  private readonly minLevel: number;
  private readonly toConsole: boolean;

  constructor(private readonly options: FileLoggerOptions) {
    this.keepDays = options.keepDays ?? 14;
    this.minLevel = LEVELS[options.level ?? "info"];
    this.toConsole = options.console ?? true;
    fs.mkdirSync(options.dir, { recursive: true });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write("error", message, data);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      this.stream.end(() => resolve());
      this.stream = null;
    });
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < this.minLevel) {
      return;
    }
    const now = new Date();
    const line = JSON.stringify({ time: now.toISOString(), level, msg: message, ...(data ?? {}) });

    try {
      this.rotateIfNeeded(now);
      this.stream?.write(line + "\n");
    } catch {
      // Logging must never crash the service.
    }

    if (this.toConsole) {
      const text = `${now.toISOString()} ${level.toUpperCase()} ${message}${data ? " " + JSON.stringify(data) : ""}`;
      if (level === "error" || level === "warn") {
        console.error(text);
      } else {
        console.log(text);
      }
    }
  }

  private rotateIfNeeded(now: Date): void {
    const day = localDay(now);
    if (day === this.currentDay && this.stream) {
      return;
    }
    this.stream?.end();
    this.currentDay = day;
    this.stream = fs.createWriteStream(path.join(this.options.dir, `service-${day}.log`), { flags: "a" });
    this.deleteOldFiles(now);
  }

  private deleteOldFiles(now: Date): void {
    const cutoff = now.getTime() - this.keepDays * 24 * 60 * 60 * 1000;
    for (const name of safeReadDir(this.options.dir)) {
      const match = /^service-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!match) {
        continue;
      }
      const fileDay = new Date(`${match[1]}T00:00:00`).getTime();
      if (fileDay < cutoff) {
        try {
          fs.unlinkSync(path.join(this.options.dir, name));
        } catch {
          // ignore
        }
      }
    }
  }
}

/** Logger that keeps lines in memory (tests). */
export class MemoryLogger implements Logger {
  readonly lines: Array<{ level: LogLevel; message: string; data?: Record<string, unknown> }> = [];
  debug(message: string, data?: Record<string, unknown>): void {
    this.lines.push({ level: "debug", message, data });
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.lines.push({ level: "info", message, data });
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.lines.push({ level: "warn", message, data });
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.lines.push({ level: "error", message, data });
  }
}

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
