import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiClient } from "./api/client";
import { Logger } from "./logger";
import { readJsonFile, writeFileAtomic } from "./store/atomicFile";
import { APP_VERSION } from "./version";

/**
 * Auto-update.
 *
 *  1. Every few hours ask Laravel: GET /api/print/v2/update -> { update_available, version, url, sha256 }.
 *  2. Wait until nothing is printing and no ack is waiting.
 *  3. Download Setup.exe over HTTPS (certificate checked) and check its sha256.
 *  4. Start it through Windows Task Scheduler as SYSTEM:
 *       Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
 *     (A scheduled task is used because the installer stops this service; a child process would be
 *      killed together with the service.) The installer stops the service, replaces the files and
 *      starts the new version. config.json, device.json, journal and outbox are kept.
 *
 * Safety: only a HIGHER version is installed; a wrong checksum is never run; the same version is tried
 * at most once per day.
 */
export interface UpdateInfo {
  update_available: boolean;
  version?: string | null;
  url?: string | null;
  sha256?: string | null;
  notes?: string | null;
}

export interface UpdaterOptions {
  enabled: boolean;
  checkIntervalHours: number;
  dataDir: string;
  /** True when nothing is printing and no ack is waiting. */
  isIdle: () => boolean;
  fetchImpl?: typeof fetch;
  runInstaller?: (setupPath: string, logPath: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

interface UpdateState {
  lastTriedVersion?: string;
  lastTriedAt?: number;
  lastError?: string | null;
}

export class Updater {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private busy = false;
  private lastCheckAt: string | null = null;
  private lastResult: string | null = null;
  private readonly stateFile: string;
  private readonly updatesDir: string;

  constructor(
    private readonly api: Pick<ApiClient, "checkUpdate">,
    private readonly logger: Logger,
    private readonly options: UpdaterOptions,
  ) {
    this.updatesDir = path.join(options.dataDir, "updates");
    this.stateFile = path.join(options.dataDir, "update-state.json");
  }

  start(firstDelayMs = 2 * 60 * 1000): void {
    this.stopped = false;
    this.schedule(firstDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): { enabled: boolean; lastCheckAt: string | null; lastResult: string | null } {
    return { enabled: this.options.enabled, lastCheckAt: this.lastCheckAt, lastResult: this.lastResult };
  }

  /**
   * One check. Returns what happened (for logs and tests).
   */
  async checkOnce(): Promise<string> {
    this.lastCheckAt = new Date().toISOString();
    const info = await this.api.checkUpdate(APP_VERSION);

    if (!info.update_available || !info.version || !info.url || !info.sha256) {
      return this.done("up to date");
    }
    if (compareVersions(info.version, APP_VERSION) <= 0) {
      return this.done(`server offers ${info.version}, not newer than ${APP_VERSION}`);
    }
    if (!this.options.enabled) {
      return this.done(`update ${info.version} available, but auto-update is turned off in config.json`);
    }
    if ((this.options.platform ?? process.platform) !== "win32") {
      return this.done(`update ${info.version} available (installing works only on Windows)`);
    }
    if (!/^https:\/\//i.test(info.url)) {
      return this.done(`refusing update URL that is not https: ${info.url}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(info.sha256)) {
      return this.done("refusing update: invalid sha256 from server");
    }

    const state = readJsonFile<UpdateState>(this.stateFile, {});
    if (state.lastTriedVersion === info.version && state.lastTriedAt && Date.now() - state.lastTriedAt < 24 * 3600 * 1000) {
      return this.done(`update ${info.version} was already tried in the last 24 h (${state.lastError ?? "no error"})`);
    }
    if (!this.options.isIdle()) {
      this.schedule(60 * 1000); // try again in 1 minute
      return this.done(`update ${info.version} waits until printing is finished`);
    }

    writeFileAtomic(this.stateFile, JSON.stringify({ lastTriedVersion: info.version, lastTriedAt: Date.now(), lastError: null } satisfies UpdateState));

    try {
      const setupPath = await this.download(info.url, info.sha256, info.version);
      const logPath = path.join(this.options.dataDir, "logs", `update-${info.version}.log`);
      this.logger.info("installing update", { from: APP_VERSION, to: info.version });
      await (this.options.runInstaller ?? runInstallerViaTaskScheduler)(setupPath, logPath);
      return this.done(`installing ${info.version}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeFileAtomic(this.stateFile, JSON.stringify({ lastTriedVersion: info.version, lastTriedAt: Date.now(), lastError: message } satisfies UpdateState));
      this.logger.error("update failed", { version: info.version, error: message });
      return this.done(`update ${info.version} failed: ${message}`);
    }
  }

  private async download(url: string, sha256: string, version: string): Promise<string> {
    fs.mkdirSync(this.updatesDir, { recursive: true });
    const target = path.join(this.updatesDir, `FoodMonsterPrint-Setup-${version.replace(/[^0-9A-Za-z.-]/g, "")}.exe`);
    const partial = `${target}.part`;

    // No Authorization header: the device token is never sent to the download host.
    const response = await (this.options.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(10 * 60 * 1000), redirect: "follow" });
    if (!response.ok) {
      throw new Error(`download failed: HTTP ${response.status}`);
    }
    if (response.url && !/^https:\/\//i.test(response.url)) {
      throw new Error("download was redirected to a non-https URL");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash.toLowerCase() !== sha256.toLowerCase()) {
      throw new Error(`checksum mismatch (expected ${sha256}, got ${hash}); the file was NOT run`);
    }

    fs.writeFileSync(partial, bytes);
    fs.renameSync(partial, target);
    this.cleanupOldInstallers(target);
    return target;
  }

  private cleanupOldInstallers(keep: string): void {
    for (const name of fs.readdirSync(this.updatesDir)) {
      const file = path.join(this.updatesDir, name);
      if (file !== keep) {
        try {
          fs.unlinkSync(file);
        } catch {
          // ignore
        }
      }
    }
  }

  private done(result: string): string {
    if (result !== this.lastResult) {
      this.logger.info("update check", { result });
    }
    this.lastResult = result;
    return result;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      await this.checkOnce();
    } catch (error) {
      this.done(`check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
    }
    if (!this.timer) {
      this.schedule(Math.max(1, this.options.checkIntervalHours) * 3600 * 1000);
    }
  }
}

/** "0.10.0" > "0.9.3". Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

const TASK_NAME = "FoodMonsterPrint Update";

/**
 * Run the installer as SYSTEM through Task Scheduler, so it keeps running after it stops this service.
 */
export async function runInstallerViaTaskScheduler(setupPath: string, logPath: string): Promise<void> {
  const command = `"${setupPath}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOG="${logPath}"`;
  await exec("schtasks.exe", ["/Create", "/F", "/TN", TASK_NAME, "/SC", "ONCE", "/ST", "23:59", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TR", command]);
  await exec("schtasks.exe", ["/Run", "/TN", TASK_NAME]);
}

function exec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${args[0]} failed: ${stderr || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
