import net, { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/logger";
import { StatusProvider, StatusServer } from "../src/status/server";

let server: StatusServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function provider(status: Record<string, unknown>) {
  const calls = { unpair: 0, pair: [] as string[] };
  const p: StatusProvider = {
    status: () => status,
    pair: async (code) => void calls.pair.push(code),
    unpair: async () => void calls.unpair++,
  };
  return { p, calls };
}

const revoked = {
  version: "0.4.1",
  serverUrl: "https://staging.example",
  device: { name: "DESKTOP-1", branchId: null },
  sync: { lastError: "HTTP 401: Unknown or revoked print device token.", unauthorized: true },
  printers: [],
  recentJobs: [],
};

describe("status page", () => {
  it("shows the revoked message and the Remove pairing button", async () => {
    const port = await freePort();
    const { p } = provider(revoked);
    server = new StatusServer(port, p, new MemoryLogger());
    await server.listen();

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain("This PC was removed (revoked) in admin");
    expect(html).toContain("Remove pairing (pair again)");
    expect(html).toContain("(all branches)");
  });

  it("Remove pairing button calls unpair and comes back to the page", async () => {
    const port = await freePort();
    const { p, calls } = provider(revoked);
    server = new StatusServer(port, p, new MemoryLogger());
    await server.listen();

    const response = await fetch(`http://127.0.0.1:${port}/unpair`, {
      method: "POST",
      headers: { Origin: `http://127.0.0.1:${port}` },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain("Pairing removed");
    expect(calls.unpair).toBe(1);
  });

  it("another website cannot unpair this PC", async () => {
    const port = await freePort();
    const { p, calls } = provider(revoked);
    server = new StatusServer(port, p, new MemoryLogger());
    await server.listen();

    const response = await fetch(`http://127.0.0.1:${port}/unpair`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(calls.unpair).toBe(0);
  });
});
