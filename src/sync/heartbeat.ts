import os from "node:os";
import { ApiClient } from "../api/client";
import { HeartbeatPrinter } from "../api/types";
import { AppConfig } from "../config";
import { PrinterHealth } from "../escpos/status";
import { Logger } from "../logger";
import { Dispatcher } from "../queue/dispatcher";
import { PrinterHealthChecker, resolveTarget } from "../transports/factory";
import { APP_VERSION } from "../version";

export interface PrinterHealthReport extends PrinterHealth {
  printerId: number;
  checkedAt: string;
}

/**
 * Every 30 s: check each printer this device may use and send the result to the server
 * (POST /api/print/v2/heartbeat). Admin and POS show it as green/red dots.
 *
 * A printer that is busy printing for us is NOT probed (we never disturb a running job);
 * its last print result is reported instead.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;
  private readonly results = new Map<number, PrinterHealthReport>();
  private lastSentAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly api: Pick<ApiClient, "heartbeat">,
    private readonly dispatcher: Dispatcher,
    private readonly checker: Pick<PrinterHealthChecker, "check">,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly extra: () => Record<string, unknown> = () => ({}),
  ) {}

  start(firstDelayMs = 5000): void {
    this.stopped = false;
    this.schedule(firstDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  health(printerId: number): PrinterHealthReport | null {
    return this.results.get(printerId) ?? null;
  }

  status(): { lastSentAt: string | null; lastError: string | null } {
    return { lastSentAt: this.lastSentAt, lastError: this.lastError };
  }

  /** One heartbeat. Exposed for tests. */
  async beatOnce(): Promise<HeartbeatPrinter[]> {
    const queues = new Map(this.dispatcher.queueStatuses().map((q) => [q.printerId, q]));
    const printers = this.dispatcher.knownPrinters();

    const reports = await Promise.all(
      printers.map(async (printer): Promise<HeartbeatPrinter> => {
        const target = resolveTarget(printer, this.config);
        const queue = queues.get(printer.id);
        let health: PrinterHealth;

        if (queue && queue.state !== "idle") {
          health = queue.lastError
            ? { online: false, code: "PRINTER_ERROR", message: `${queue.lastError.code}: ${queue.lastError.message}` }
            : { online: true, code: "OK", message: `Printing (${queue.queued} waiting)` };
        } else {
          try {
            health = await this.checker.check(target);
          } catch (error) {
            health = { online: false, code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };
          }
        }

        const previous = this.results.get(printer.id);
        if (previous && previous.online !== health.online) {
          this.logger.info(health.online ? "printer back online" : "printer offline", { printer: target.name, code: health.code, message: health.message });
        }
        this.results.set(printer.id, { ...health, printerId: printer.id, checkedAt: new Date().toISOString() });

        return { id: printer.id, online: health.online, status_code: health.code, message: health.message.slice(0, 250) };
      }),
    );

    await this.api.heartbeat({
      app_version: APP_VERSION,
      os_info: `${os.type()} ${os.release()} ${os.arch()}`,
      printers: reports,
      ...this.extra(),
    });
    this.lastSentAt = new Date().toISOString();
    this.lastError = null;

    return reports;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      await this.beatOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError) {
        this.logger.warn("heartbeat failed", { error: message });
      }
      this.lastError = message;
    } finally {
      this.running = false;
    }
    this.schedule(this.config.heartbeat.intervalMs);
  }
}
