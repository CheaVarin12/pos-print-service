import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/logger";
import { UpdateInfo, Updater, compareVersions } from "../src/update";
import { APP_VERSION } from "../src/version";
import { tempDir } from "./helpers";

const setupBytes = Buffer.from("MZ fake installer");
const setupSha = crypto.createHash("sha256").update(setupBytes).digest("hex");

function makeUpdater(info: UpdateInfo, options: { idle?: boolean; enabled?: boolean; platform?: NodeJS.Platform; bytes?: Buffer } = {}) {
  const dir = tempDir();
  const installs: string[] = [];
  let downloads = 0;
  const updater = new Updater({ checkUpdate: async () => info }, new MemoryLogger(), {
    enabled: options.enabled ?? true,
    checkIntervalHours: 6,
    dataDir: dir,
    isIdle: () => options.idle ?? true,
    platform: options.platform ?? "win32",
    fetchImpl: (async () => {
      downloads++;
      return new Response(options.bytes ?? setupBytes, { status: 200 });
    }) as unknown as typeof fetch,
    runInstaller: async (setupPath) => void installs.push(setupPath),
  });
  return { updater, installs, dir, downloads: () => downloads };
}

const newer = "99.0.0";

describe("auto-update", () => {
  it("compares versions correctly", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
  });

  it("downloads, checks the sha256 and starts the installer for a newer version", async () => {
    const { updater, installs } = makeUpdater({ update_available: true, version: newer, url: "https://example.test/Setup.exe", sha256: setupSha });
    expect(await updater.checkOnce()).toContain(`installing ${newer}`);
    expect(installs).toHaveLength(1);
    expect(fs.readFileSync(installs[0])).toEqual(setupBytes);
  });

  it("never runs a file with a wrong checksum", async () => {
    const { updater, installs } = makeUpdater({ update_available: true, version: newer, url: "https://example.test/Setup.exe", sha256: "a".repeat(64) });
    expect(await updater.checkOnce()).toContain("checksum mismatch");
    expect(installs).toHaveLength(0);
  });

  it("does nothing when the server version is not newer", async () => {
    const { updater, downloads } = makeUpdater({ update_available: true, version: APP_VERSION, url: "https://example.test/Setup.exe", sha256: setupSha });
    expect(await updater.checkOnce()).toContain("not newer");
    expect(downloads()).toBe(0);
  });

  it("waits while printing is in progress", async () => {
    const { updater, installs } = makeUpdater({ update_available: true, version: newer, url: "https://example.test/Setup.exe", sha256: setupSha }, { idle: false });
    expect(await updater.checkOnce()).toContain("waits until printing is finished");
    expect(installs).toHaveLength(0);
    await updater.stop();
  });

  it("refuses http URLs, respects the off switch, and does not install on a Mac", async () => {
    expect(await makeUpdater({ update_available: true, version: newer, url: "http://example.test/Setup.exe", sha256: setupSha }).updater.checkOnce()).toContain("not https");
    expect(await makeUpdater({ update_available: true, version: newer, url: "https://x.test/S.exe", sha256: setupSha }, { enabled: false }).updater.checkOnce()).toContain("turned off");
    expect(await makeUpdater({ update_available: true, version: newer, url: "https://x.test/S.exe", sha256: setupSha }, { platform: "darwin" }).updater.checkOnce()).toContain("only on Windows");
  });

  it("tries the same version only once per day", async () => {
    const { updater, installs } = makeUpdater({ update_available: true, version: newer, url: "https://example.test/Setup.exe", sha256: "b".repeat(64) });
    await updater.checkOnce(); // fails (checksum)
    expect(await updater.checkOnce()).toContain("already tried");
    expect(installs).toHaveLength(0);
  });
});
