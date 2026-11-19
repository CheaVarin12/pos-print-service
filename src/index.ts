#!/usr/bin/env node
import fs from "node:fs";
import { App } from "./app";
import { ConfigError, loadConfig, loadDevice } from "./config";
import { buildPrintJob, MonoBitmap } from "./escpos/raster";
import { appPaths } from "./paths";
import { pairDevice } from "./pairing";
import { saveFakePrint } from "./transports/fake";
import { sendTcp } from "./transports/tcp";
import { APP_VERSION } from "./version";

const HELP = `FoodMonsterPrint ${APP_VERSION}

Usage:
  foodmonsterprint run                    Start the print service (default)
  foodmonsterprint pair <CODE>            Pair this PC with a code from admin
  foodmonsterprint unpair                 Forget the device token (pair again after)
  foodmonsterprint status                 Show the status of the running service
  foodmonsterprint test-print --ip <IP> [--port 9100] [--width 576] [--fake]
                                          Print a test pattern directly (no server needed)

Data folder: set FMP_DATA_DIR to change it (default: C:\\ProgramData\\FoodMonsterPrint on Windows).
`;

async function main(argv: string[]): Promise<number> {
  const [command = "run", ...rest] = argv;
  const paths = appPaths();

  switch (command) {
    case "run":
      return run(paths);
    case "pair":
      return pair(paths, rest[0]);
    case "unpair":
      return unpair(paths);
    case "status":
      return status(paths);
    case "test-print":
      return testPrint(paths, rest);
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "--version":
    case "-v":
      console.log(APP_VERSION);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function run(paths: ReturnType<typeof appPaths>): Promise<number> {
  const app = new App(paths);

  process.on("uncaughtException", (error) => {
    app.logger.error("uncaught exception, exiting (the Windows service will restart us)", { error: error.stack ?? String(error) });
    setTimeout(() => process.exit(1), 200);
  });
  process.on("unhandledRejection", (reason) => {
    app.logger.error("unhandled promise rejection, exiting", { error: reason instanceof Error ? reason.stack : String(reason) });
    setTimeout(() => process.exit(1), 200);
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.logger.info(`received ${signal}`);
    const force = setTimeout(() => process.exit(0), 15000);
    await app.stop();
    clearTimeout(force);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGBREAK", () => void shutdown("SIGBREAK")); // Windows Ctrl+Break / service stop

  await app.start();
  return new Promise<number>(() => undefined); // run until a signal
}

async function pair(paths: ReturnType<typeof appPaths>, code: string | undefined): Promise<number> {
  if (!code) {
    console.error("Usage: foodmonsterprint pair <CODE>");
    return 2;
  }
  const config = loadConfig(paths);

  // If the service is running, let it pair (it starts printing at once).
  const running = await fetchLocal(config.statusPort, "/api/status");
  if (running) {
    const response = await fetch(`http://127.0.0.1:${config.statusPort}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }).toString(),
      redirect: "manual",
    });
    const location = decodeURIComponent((response.headers.get("location") ?? "").replace(/^\/\?msg=/, ""));
    console.log(location || `HTTP ${response.status}`);
    return location.startsWith("Paired") ? 0 : 1;
  }

  if (loadDevice(paths)) {
    console.error("This device is already paired. Run 'foodmonsterprint unpair' first.");
    return 1;
  }
  const device = await pairDevice(paths, config, code);
  console.log(`Paired as "${device.name}" for branch #${device.branchId} on ${device.serverUrl}.`);
  return 0;
}

function unpair(paths: ReturnType<typeof appPaths>): number {
  try {
    fs.unlinkSync(paths.device);
    console.log("Device token removed. Restart the service and pair again.");
  } catch {
    console.log("This device was not paired.");
  }
  return 0;
}

async function status(paths: ReturnType<typeof appPaths>): Promise<number> {
  const config = loadConfig(paths);
  const data = await fetchLocal(config.statusPort, "/api/status");
  if (!data) {
    console.error(`FoodMonsterPrint is not running (nothing on http://127.0.0.1:${config.statusPort}).`);
    return 1;
  }
  console.log(JSON.stringify(data, null, 2));
  return 0;
}

async function testPrint(paths: ReturnType<typeof appPaths>, args: string[]): Promise<number> {
  const option = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const fake = args.includes("--fake");
  const ip = option("ip");
  const port = Number(option("port") ?? 9100);
  const width = Number(option("width") ?? 576);
  if (!fake && !ip) {
    console.error("Usage: foodmonsterprint test-print --ip <IP> [--port 9100] [--width 576] [--fake]");
    return 2;
  }

  const config = loadConfig(paths);
  const bytes = buildPrintJob(testPattern(width), { copies: 1, feedLines: config.feedLines, chunkRows: config.rasterChunkRows });

  if (fake) {
    const files = saveFakePrint(config.fakeOutputDir, "test-print", bytes);
    console.log("Saved:\n  " + files.join("\n  "));
    return 0;
  }
  await sendTcp(ip!, port, bytes, config.tcp);
  console.log(`Sent ${bytes.length} bytes to ${ip}:${port}. A box with a ruler should print; the right edge must be complete.`);
  return 0;
}

/** Border box + ruler + diagonal: shows if the full paper width prints. */
function testPattern(width: number): MonoBitmap {
  const height = 200;
  const bytesPerRow = Math.ceil(width / 8);
  const data = Buffer.alloc(bytesPerRow * height);
  const set = (x: number, y: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
  };
  for (let x = 0; x < width; x++) {
    for (let t = 0; t < 3; t++) {
      set(x, t);
      set(x, height - 1 - t);
    }
    if (x % 8 === 0) for (let y = 120; y < (x % 64 === 0 ? 170 : 145); y++) set(x, y);
  }
  for (let y = 0; y < height; y++) {
    for (let t = 0; t < 3; t++) {
      set(t, y);
      set(width - 1 - t, y);
    }
    set(Math.round((y / height) * (width - 1)), y);
  }
  return { width, height, bytesPerRow, data };
}

async function fetchLocal(port: number, path: string): Promise<unknown | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (error) => {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  },
);
