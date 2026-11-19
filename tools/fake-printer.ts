/**
 * Fake network printer for testing on a Mac (no real printer needed).
 *
 *   npm run fake-printer -- --port 9101 --out ./.data/fake-printer-9101
 *   npm run fake-printer -- --port 9102 --mode offline     (accepts nothing: connection refused)
 *   npm run fake-printer -- --port 9103 --mode hang        (accepts, never reads: write timeout)
 *   npm run fake-printer -- --port 9104 --mode drop        (closes after a few bytes: partial write)
 *
 * In "normal" mode every received job is saved as .bin plus one .png per cut (what the paper
 * would look like). Point a printer to it with config.json "printerOverrides":
 *   "printerOverrides": { "12": { "ip": "127.0.0.1", "port": 9101 } }
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { decodeEscPos } from "../src/escpos/decode";
import { saveFakePrint } from "../src/transports/fake";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(arg("port", "9100"));
const out = path.resolve(arg("out", `./.data/fake-printer-${port}`));
const mode = arg("mode", "normal") as "normal" | "offline" | "hang" | "drop";

if (mode === "offline") {
  console.log(`Mode "offline": nothing listens on port ${port}, so connections are refused. Press Ctrl+C to stop.`);
  setInterval(() => undefined, 1 << 30);
} else {
  fs.mkdirSync(out, { recursive: true });
  let jobNumber = 0;

  const server = net.createServer((socket) => {
    const id = ++jobNumber;
    const from = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[job ${id}] connection from ${from}`);

    if (mode === "hang") {
      socket.pause(); // never read: the sender's buffers fill up and it times out
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (mode === "drop" && received > 200) {
        console.log(`[job ${id}] dropping connection after ${received} bytes (simulated cable pull)`);
        socket.destroy();
      }
    });
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) {
        console.log(`[job ${id}] closed, no data`);
        return;
      }
      const decoded = decodeEscPos(bytes);
      const files = saveFakePrint(out, `job-${id}`, bytes);
      console.log(`[job ${id}] ${bytes.length} bytes, ${decoded.pages.length} page(s), ${decoded.cuts} cut(s), unknown bytes: ${decoded.unknownBytes}`);
      files.forEach((file) => console.log(`         ${file}`));
    });
    socket.on("error", (error) => console.log(`[job ${id}] socket error: ${error.message}`));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Fake printer (${mode}) listening on port ${port}. Saving to ${out}`);
  });
}
