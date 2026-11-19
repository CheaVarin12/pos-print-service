import os from "node:os";
import path from "node:path";
import { APP_NAME } from "./version";

/**
 * Where config, device token, journal, outbox and logs live.
 *  - Windows: C:\ProgramData\FoodMonsterPrint   (shared by all users, works for a Windows service)
 *  - Mac/Linux (development): ~/.foodmonsterprint
 *  - Override with the FMP_DATA_DIR environment variable (used by tests and local runs).
 */
export function dataDir(): string {
  const override = process.env.FMP_DATA_DIR;
  if (override && override.trim() !== "") {
    return path.resolve(override);
  }
  if (process.platform === "win32") {
    const programData = process.env.ProgramData || "C:\\ProgramData";
    return path.join(programData, APP_NAME);
  }
  return path.join(os.homedir(), ".foodmonsterprint");
}

export interface AppPaths {
  root: string;
  config: string;
  device: string;
  journal: string;
  outbox: string;
  logs: string;
  fakePrints: string;
}

export function appPaths(root = dataDir()): AppPaths {
  return {
    root,
    config: path.join(root, "config.json"),
    device: path.join(root, "device.json"),
    journal: path.join(root, "journal.json"),
    outbox: path.join(root, "ack-outbox.json"),
    logs: path.join(root, "logs"),
    fakePrints: path.join(root, "fake-prints"),
  };
}
