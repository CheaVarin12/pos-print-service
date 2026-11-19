import crypto from "node:crypto";
import os from "node:os";
import { ApiClient } from "./api/client";
import { AppConfig, DeviceIdentity, saveDevice } from "./config";
import { AppPaths } from "./paths";
import { APP_VERSION } from "./version";

/**
 * Exchange a pairing code (from Laravel admin / `php artisan print:pairing-code`) for a device token.
 * The token is saved in device.json. It is never printed in logs.
 */
export async function pairDevice(
  paths: AppPaths,
  config: AppConfig,
  code: string,
  fetchImpl?: typeof fetch,
): Promise<DeviceIdentity> {
  const api = new ApiClient({ serverUrl: config.serverUrl, timeoutMs: config.httpTimeoutMs, fetchImpl });
  const response = await api.pair({
    code: code.trim(),
    device_name: config.deviceName,
    machine_id: machineId(),
    app_version: APP_VERSION,
    os_info: osInfo(),
  });

  const device: DeviceIdentity = {
    token: response.token,
    deviceId: response.device.id,
    branchId: response.device.branch_id,
    shopId: response.device.shop_id,
    name: response.device.name,
    serverUrl: config.serverUrl,
    pairedAt: new Date().toISOString(),
  };
  saveDevice(paths, device);

  return device;
}

/** Stable id for this PC (hostname + first network card), hashed. */
export function machineId(): string {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((nic) => nic && !nic.internal && nic.mac && nic.mac !== "00:00:00:00:00:00")
    .map((nic) => nic!.mac)
    .sort();
  return crypto.createHash("sha256").update(`${os.hostname()}|${macs[0] ?? ""}`).digest("hex").slice(0, 32);
}

export function osInfo(): string {
  return `${os.type()} ${os.release()} ${os.arch()}; node ${process.version}`;
}
