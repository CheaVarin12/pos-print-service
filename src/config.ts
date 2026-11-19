import os from "node:os";
import { AppPaths } from "./paths";
import { readJsonFile, writeFileAtomic } from "./store/atomicFile";

/**
 * config.json — settings the shop/installer can change.
 * device.json — the device token from pairing (kept separate; never logged).
 */
export interface PrinterOverride {
  /** Send this printer's jobs to another address (e.g. a fake printer on your Mac). */
  ip?: string;
  port?: number;
  /** USB printer: the exact Windows printer name, if it differs from the name in Printer List. */
  windowsPrinter?: string;
}

export interface AppConfig {
  serverUrl: string;
  deviceName: string;
  pollIntervalMs: number;
  statusPort: number;
  /** "real" = real printers. "fake" = write every job to files in fakeOutputDir (no printer needed). */
  printerMode: "real" | "fake";
  fakeOutputDir: string;
  printerOverrides: Record<string, PrinterOverride>;
  tcp: {
    connectTimeoutMs: number;
    writeTimeoutMs: number;
    /** Ask the printer for paper/cover status before each job (ESC/POS DLE EOT). */
    statusCheck: boolean;
    statusTimeoutMs: number;
  };
  usb: {
    /** Watch each USB job in the Windows queue until it is printed (0 = do not watch). */
    waitForJobMs: number;
  };
  heartbeat: {
    intervalMs: number;
    /** Open a short TCP connection to network printers to read their status. */
    probeNetworkPrinters: boolean;
  };
  /** Wait times between tries when a printer cannot be reached. 5 tries in total by default. */
  retryDelaysSec: number[];
  rasterChunkRows: number;
  feedLines: number;
  httpTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface DeviceIdentity {
  token: string;
  deviceId: string;
  branchId: number;
  shopId: number | null;
  name: string;
  serverUrl: string;
  pairedAt: string;
}

export function defaultConfig(paths: AppPaths): AppConfig {
  return {
    serverUrl: "https://staging.foodmonster.asia",
    deviceName: os.hostname(),
    pollIntervalMs: 2500,
    statusPort: 9123,
    printerMode: "real",
    fakeOutputDir: paths.fakePrints,
    printerOverrides: {},
    tcp: {
      connectTimeoutMs: 5000,
      writeTimeoutMs: 15000,
      statusCheck: true,
      statusTimeoutMs: 1500,
    },
    usb: {
      waitForJobMs: 30000,
    },
    heartbeat: {
      intervalMs: 30000,
      probeNetworkPrinters: true,
    },
    retryDelaysSec: [5, 15, 30, 60],
    rasterChunkRows: 255,
    feedLines: 4,
    httpTimeoutMs: 15000,
    logLevel: "info",
  };
}

export class ConfigError extends Error {}

/**
 * Load config.json, fill missing values with defaults, and check every value.
 * If the file does not exist, it is created with the defaults so it is easy to edit.
 */
export function loadConfig(paths: AppPaths): AppConfig {
  const defaults = defaultConfig(paths);
  const raw = readJsonFile<Partial<AppConfig> | null>(paths.config, null);

  if (raw === null) {
    writeFileAtomic(paths.config, JSON.stringify(defaults, null, 2) + "\n");
    return defaults;
  }

  const merged: AppConfig = {
    ...defaults,
    ...raw,
    tcp: { ...defaults.tcp, ...(raw.tcp ?? {}) },
    usb: { ...defaults.usb, ...(raw.usb ?? {}) },
    heartbeat: { ...defaults.heartbeat, ...(raw.heartbeat ?? {}) },
    printerOverrides: { ...(raw.printerOverrides ?? {}) },
  };
  validateConfig(merged);

  return merged;
}

export function saveConfig(paths: AppPaths, config: AppConfig): void {
  validateConfig(config);
  writeFileAtomic(paths.config, JSON.stringify(config, null, 2) + "\n");
}

export function validateConfig(config: AppConfig): void {
  const problems: string[] = [];

  let url: URL | null = null;
  try {
    url = new URL(config.serverUrl);
  } catch {
    problems.push(`serverUrl is not a valid URL: ${config.serverUrl}`);
  }
  if (url) {
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    // SSL is required, except for a server on this computer (development).
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      problems.push("serverUrl must start with https:// (http:// is allowed only for localhost).");
    }
  }

  const intIn = (name: string, value: unknown, min: number, max: number) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number between ${min} and ${max} (got ${JSON.stringify(value)}).`);
    }
  };

  intIn("pollIntervalMs", config.pollIntervalMs, 1000, 60000);
  intIn("statusPort", config.statusPort, 1024, 65535);
  intIn("tcp.connectTimeoutMs", config.tcp.connectTimeoutMs, 500, 60000);
  intIn("tcp.writeTimeoutMs", config.tcp.writeTimeoutMs, 1000, 120000);
  intIn("tcp.statusTimeoutMs", config.tcp.statusTimeoutMs, 200, 10000);
  intIn("usb.waitForJobMs", config.usb.waitForJobMs, 0, 300000);
  intIn("heartbeat.intervalMs", config.heartbeat.intervalMs, 10000, 600000);
  intIn("rasterChunkRows", config.rasterChunkRows, 24, 2048);
  intIn("feedLines", config.feedLines, 0, 20);
  intIn("httpTimeoutMs", config.httpTimeoutMs, 1000, 120000);

  if (config.printerMode !== "real" && config.printerMode !== "fake") {
    problems.push('printerMode must be "real" or "fake".');
  }
  if (!Array.isArray(config.retryDelaysSec) || config.retryDelaysSec.some((s) => typeof s !== "number" || s < 0 || s > 600)) {
    problems.push("retryDelaysSec must be a list of seconds between 0 and 600.");
  }
  if (typeof config.deviceName !== "string" || config.deviceName.trim() === "") {
    problems.push("deviceName must not be empty.");
  }
  if (!["debug", "info", "warn", "error"].includes(config.logLevel)) {
    problems.push("logLevel must be debug, info, warn or error.");
  }
  for (const [printerId, override] of Object.entries(config.printerOverrides ?? {})) {
    if (override.port !== undefined) {
      intIn(`printerOverrides.${printerId}.port`, override.port, 1, 65535);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError("Invalid config.json:\n - " + problems.join("\n - "));
  }
}

export function loadDevice(paths: AppPaths): DeviceIdentity | null {
  const device = readJsonFile<DeviceIdentity | null>(paths.device, null);
  if (!device || typeof device.token !== "string" || device.token === "") {
    return null;
  }
  return device;
}

export function saveDevice(paths: AppPaths, device: DeviceIdentity): void {
  writeFileAtomic(paths.device, JSON.stringify(device, null, 2) + "\n");
}
