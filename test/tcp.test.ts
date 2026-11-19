import net from "node:net";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PrintError } from "../src/errors";
import { sendTcp } from "../src/transports/tcp";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

async function listen(handler: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    handler(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const port = await listen(() => undefined);
  await new Promise((r) => servers.pop()!.close(() => r(undefined)));
  return port;
}

const options = { connectTimeoutMs: 1000, writeTimeoutMs: 800, closeGraceMs: 200 };

describe("tcp transport", () => {
  it("sends all bytes to the printer", async () => {
    const received: Buffer[] = [];
    const done = new Promise<void>((resolve) => {
      void listen((socket) => {
        socket.on("data", (c) => received.push(c));
        socket.on("end", () => {
          socket.end();
          resolve();
        });
      }).then((port) => sendTcp("127.0.0.1", port, Buffer.alloc(100000, 7), options));
    });
    await done;
    expect(Buffer.concat(received).length).toBe(100000);
  });

  it("connection refused -> CONN_REFUSED, retryable, nothing sent", async () => {
    const port = await freePort();
    const error = await sendTcp("127.0.0.1", port, Buffer.from("x"), options).catch((e) => e);
    expect(error).toBeInstanceOf(PrintError);
    expect(error.code).toBe("CONN_REFUSED");
    expect(error.retryable).toBe(true);
    expect(error.bytesSent).toBe(0);
  });

  it("no answer -> CONNECT_TIMEOUT within the timeout", async () => {
    const started = Date.now();
    // 10.255.255.1 is not routable: the connect hangs until our timeout.
    const error = await sendTcp("10.255.255.1", 9100, Buffer.from("x"), { ...options, connectTimeoutMs: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(PrintError);
    expect(["CONNECT_TIMEOUT", "HOST_UNREACHABLE"]).toContain(error.code);
    expect(error.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("printer stops reading -> WRITE_TIMEOUT, NOT retryable (part may have printed)", async () => {
    const port = await listen((socket) => socket.pause());
    const error = await sendTcp("127.0.0.1", port, Buffer.alloc(64 * 1024 * 1024, 1), options).catch((e) => e);
    expect(error).toBeInstanceOf(PrintError);
    expect(error.code).toBe("WRITE_TIMEOUT");
    expect(error.retryable).toBe(false);
    expect(error.bytesSent).toBeGreaterThan(0);
  });

  it("printer drops the connection while printing -> not retryable", async () => {
    const port = await listen((socket) => {
      socket.once("data", () => socket.resetAndDestroy?.() ?? socket.destroy());
    });
    const error = await sendTcp("127.0.0.1", port, Buffer.alloc(32 * 1024 * 1024, 1), options).catch((e) => e);
    expect(error).toBeInstanceOf(PrintError);
    expect(error.retryable).toBe(false);
    expect(error.bytesSent).toBeGreaterThan(0);
  });
});
