import { ApiClient } from "./api/client";
import { AppConfig, DeviceIdentity, loadConfig, loadDevice } from "./config";
import { ContentCache } from "./content/cache";
import { FileLogger, Logger } from "./logger";
import { pairDevice } from "./pairing";
import { AppPaths } from "./paths";
import { Dispatcher } from "./queue/dispatcher";
import { SleepFn } from "./queue/types";
import { StatusServer } from "./status/server";
import { AckOutbox } from "./store/ackOutbox";
import { Journal } from "./store/journal";
import { AckSender } from "./sync/ackSender";
import { Poller } from "./sync/poller";
import { TransportRouter, resolveTarget } from "./transports/factory";
import { PrinterTransport } from "./transports/types";
import { APP_VERSION } from "./version";

export interface AppOptions {
  /** For tests: replace parts. */
  fetchImpl?: typeof fetch;
  transport?: PrinterTransport;
  logger?: Logger;
  sleep?: SleepFn;
  /** Do not open the status port (tests). */
  noStatusServer?: boolean;
}

/**
 * Puts all parts together:
 *   Poller (sync) -> Dispatcher -> one PrinterQueue per printer -> transport (TCP / fake)
 *   results -> Journal (disk) + AckOutbox (disk) -> AckSender -> server
 */
export class App {
  readonly config: AppConfig;
  readonly logger: Logger;
  private readonly journal: Journal;
  private readonly outbox: AckOutbox;
  private device: DeviceIdentity | null;
  private problem: string | null = null;
  private statusServer: StatusServer | null = null;
  private dispatcher: Dispatcher | null = null;
  private poller: Poller | null = null;
  private ackSender: AckSender | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly paths: AppPaths, private readonly options: AppOptions = {}) {
    this.config = loadConfig(paths);
    this.logger = options.logger ?? new FileLogger({ dir: paths.logs, keepDays: 14, level: this.config.logLevel });
    this.journal = new Journal(paths.journal);
    this.outbox = new AckOutbox(paths.outbox);
    this.device = loadDevice(paths);

    if (this.device && this.device.serverUrl.replace(/\/+$/, "") !== this.config.serverUrl.replace(/\/+$/, "")) {
      this.problem = `This device was paired with ${this.device.serverUrl}, but config.json now says ${this.config.serverUrl}. Pair again.`;
      this.device = null;
    }
  }

  async start(): Promise<void> {
    this.logger.info("FoodMonsterPrint starting", {
      version: APP_VERSION,
      dataDir: this.paths.root,
      server: this.config.serverUrl,
      printerMode: this.config.printerMode,
    });

    if (!this.options.noStatusServer) {
      this.statusServer = new StatusServer(this.config.statusPort, this, this.logger);
      try {
        await this.statusServer.listen();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          throw new Error(`Port ${this.config.statusPort} is in use. Is FoodMonsterPrint already running?`);
        }
        throw error;
      }
      this.logger.info(`status page: http://127.0.0.1:${this.config.statusPort}`);
    }

    this.pruneTimer = setInterval(() => this.journal.prune(), 60 * 60 * 1000);
    this.pruneTimer.unref();

    if (this.device) {
      this.startWorkers(this.device);
    } else {
      this.logger.warn(this.problem ?? `Not paired. Open http://127.0.0.1:${this.config.statusPort} or run: foodmonsterprint pair <CODE>`);
    }
  }

  async stop(): Promise<void> {
    this.logger.info("FoodMonsterPrint stopping");
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    await this.poller?.stop();
    await this.dispatcher?.stop();
    await this.ackSender?.stop();
    await this.statusServer?.close();
    if (this.logger instanceof FileLogger) {
      await this.logger.close();
    }
  }

  /** Called from the status page form or the CLI. */
  async pair(code: string): Promise<void> {
    if (this.device) {
      throw new Error("This device is already paired. Run 'foodmonsterprint unpair' first.");
    }
    if (!/^[A-Za-z0-9-\s]{4,20}$/.test(code.trim())) {
      throw new Error("Please type the code shown in admin.");
    }
    const device = await pairDevice(this.paths, this.config, code, this.options.fetchImpl);
    this.logger.info("paired", { deviceId: device.deviceId, branchId: device.branchId, name: device.name });
    this.device = device;
    this.problem = null;
    this.startWorkers(device);
  }

  status(): Record<string, unknown> {
    const queues = new Map((this.dispatcher?.queueStatuses() ?? []).map((q) => [q.printerId, q]));
    const printers = (this.dispatcher?.knownPrinters() ?? []).map((printer) => {
      const target = resolveTarget(printer, this.config);
      return {
        id: printer.id,
        name: target.name,
        connection: target.connection,
        ip: target.host,
        port: target.port,
        paperWidth: target.paperWidth,
        queue: queues.get(printer.id) ?? null,
      };
    });
    // Queues for printers not in the list any more (e.g. removed in admin) are still shown.
    for (const [printerId, queue] of queues) {
      if (!printers.some((p) => p.id === printerId)) {
        printers.push({ id: printerId, name: queue.name, connection: "network", ip: null, port: 9100, paperWidth: 0, queue });
      }
    }

    return {
      app: "FoodMonsterPrint",
      version: APP_VERSION,
      startedAt: this.startedAt,
      dataDir: this.paths.root,
      serverUrl: this.config.serverUrl,
      printerMode: this.config.printerMode,
      problem: this.problem,
      device: this.device ? { id: this.device.deviceId, name: this.device.name, branchId: this.device.branchId, pairedAt: this.device.pairedAt } : null,
      sync: this.poller?.status() ?? null,
      acks: this.ackSender?.status() ?? { pending: this.outbox.size(), lastError: null },
      activeTasks: this.dispatcher?.activeCount() ?? 0,
      printers,
      recentJobs: this.journal.recent(50),
    };
  }

  /** For tests. */
  internals() {
    return { journal: this.journal, outbox: this.outbox, dispatcher: this.dispatcher, poller: this.poller, ackSender: this.ackSender };
  }

  private startWorkers(device: DeviceIdentity): void {
    const api = new ApiClient({
      serverUrl: this.config.serverUrl,
      token: device.token,
      timeoutMs: this.config.httpTimeoutMs,
      fetchImpl: this.options.fetchImpl,
    });

    this.ackSender = new AckSender(api, this.outbox, this.logger);
    this.dispatcher = new Dispatcher({
      config: this.config,
      transport: this.options.transport ?? new TransportRouter(this.config),
      content: new ContentCache(api),
      journal: this.journal,
      outbox: this.outbox,
      logger: this.logger,
      onAckQueued: () => this.ackSender?.kick(),
      sleep: this.options.sleep,
    });
    this.poller = new Poller(api, this.dispatcher, this.logger, this.config.pollIntervalMs);

    const uncertain = this.dispatcher.resolveUncertainOnStartup();
    if (uncertain > 0) {
      this.logger.warn(`${uncertain} task(s) were printing when the service stopped; reported as failed (no automatic reprint).`);
    }

    this.ackSender.start();
    this.poller.start();
    this.logger.info("connected", { deviceId: device.deviceId, branchId: device.branchId });
  }
}
