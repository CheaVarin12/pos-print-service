#!/usr/bin/env node
/**
 * Builds the Windows package of FoodMonsterPrint.
 *
 *   node scripts/build-windows.mjs
 *
 * 1. Compiles TypeScript (npm run build).
 * 2. Creates build/win/ :
 *      FoodMonsterPrint.exe   WinSW 2.12.0 (service wrapper, official release, sha256 checked)
 *      FoodMonsterPrint.xml   service definition
 *      node/node.exe          official Node.js 24 LTS for Windows x64 (sha256 checked)
 *      app/dist/...           our compiled code
 *      app/node_modules/      pngjs + koffi (Windows x64 binary only)
 *      fmp.cmd                command line: fmp status | fmp pair CODE | fmp test-print --ip ...
 * 3. On Windows, if Inno Setup is installed, builds build/installer/FoodMonsterPrint-Setup-<version>.exe
 *    and prints its sha256 (put it in the Laravel .env for auto-update).
 *
 * Why not a single .exe (pkg / Node SEA)? Packed executables are often flagged by antivirus on shop PCs,
 * and the native USB module (koffi) cannot be embedded easily. The official, signed node.exe is safer.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "24.22.2";
const NODE_ZIP_SHA256 = "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2";
const WINSW_URL = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";
const WINSW_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "win");
const cache = path.join(root, "build", "cache");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const isWindows = process.platform === "win32";

function step(message) {
  console.log(`\n== ${message}`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(url, file, expectedSha) {
  if (fs.existsSync(file) && sha256(file) === expectedSha) {
    console.log(`cached: ${path.basename(file)}`);
    return;
  }
  console.log(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(file);
  if (actual !== expectedSha) {
    fs.unlinkSync(file);
    throw new Error(`Checksum mismatch for ${url}\n expected ${expectedSha}\n got      ${actual}`);
  }
}

function copy(from, to, filter) {
  fs.cpSync(from, to, { recursive: true, filter });
}

async function main() {
  step(`FoodMonsterPrint ${pkg.version}`);

  step("compile TypeScript");
  execFileSync(isWindows ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: isWindows });

  step(`clean ${path.relative(root, out)}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "app"), { recursive: true });
  fs.mkdirSync(path.join(out, "node"), { recursive: true });

  step("app files");
  copy(path.join(root, "dist"), path.join(out, "app", "dist"), (src) => !src.endsWith(".map"));
  fs.writeFileSync(
    path.join(out, "app", "package.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, private: true, main: "dist/src/index.js" }, null, 2) + "\n",
  );
  copy(path.join(root, "node_modules", "pngjs"), path.join(out, "app", "node_modules", "pngjs"));

  const koffiSrc = path.join(root, "node_modules", "koffi");
  const koffiOut = path.join(out, "app", "node_modules", "koffi");
  fs.mkdirSync(koffiOut, { recursive: true });
  for (const file of ["package.json", "index.js", "indirect.js", "index.d.ts", "LICENSE.txt"]) {
    if (fs.existsSync(path.join(koffiSrc, file))) fs.copyFileSync(path.join(koffiSrc, file), path.join(koffiOut, file));
  }
  copy(path.join(koffiSrc, "build", "koffi", "win32_x64"), path.join(koffiOut, "build", "koffi", "win32_x64"));

  step(`Node.js ${NODE_VERSION} (win-x64)`);
  const nodeZip = path.join(cache, `node-v${NODE_VERSION}-win-x64.zip`);
  await download(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`, nodeZip, NODE_ZIP_SHA256);
  const extractDir = path.join(cache, `node-v${NODE_VERSION}-extract`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const inner = `node-v${NODE_VERSION}-win-x64`;
  execFileSync("tar", ["-xf", nodeZip, "-C", extractDir, `${inner}/node.exe`, `${inner}/LICENSE`], { stdio: "inherit" });
  fs.copyFileSync(path.join(extractDir, inner, "node.exe"), path.join(out, "node", "node.exe"));
  fs.copyFileSync(path.join(extractDir, inner, "LICENSE"), path.join(out, "node", "LICENSE"));

  step("WinSW 2.12.0 (service wrapper)");
  const winsw = path.join(cache, "WinSW-x64-2.12.0.exe");
  await download(WINSW_URL, winsw, WINSW_SHA256);
  fs.copyFileSync(winsw, path.join(out, "FoodMonsterPrint.exe"));
  fs.copyFileSync(path.join(root, "packaging", "winsw", "FoodMonsterPrint.xml"), path.join(out, "FoodMonsterPrint.xml"));

  step("helper files");
  fs.writeFileSync(path.join(out, "fmp.cmd"), '@echo off\r\n"%~dp0node\\node.exe" "%~dp0app\\dist\\src\\index.js" %*\r\n');
  fs.copyFileSync(path.join(root, "config.example.json"), path.join(out, "config.example.json"));
  fs.writeFileSync(path.join(out, "VERSION.txt"), `${pkg.version}\r\n`);
  fs.writeFileSync(
    path.join(out, "THIRD_PARTY_NOTICES.txt"),
    [
      "FoodMonsterPrint includes:",
      `- Node.js ${NODE_VERSION} (MIT and others, see node\\LICENSE) https://nodejs.org`,
      "- WinSW 2.12.0 (MIT License) https://github.com/winsw/winsw - FoodMonsterPrint.exe",
      "- koffi (MIT License) https://koffi.dev - app\\node_modules\\koffi\\LICENSE.txt",
      "- pngjs (MIT License) https://github.com/pngjs/pngjs - app\\node_modules\\pngjs\\LICENSE",
      "",
    ].join("\r\n"),
  );

  step("installer");
  const iscc = findIscc();
  if (!iscc) {
    console.log(
      isWindows
        ? "Inno Setup (ISCC.exe) not found. Install Inno Setup 6.3+ or set ISCC=C:\\path\\ISCC.exe, then run this script again."
        : "Not on Windows: build/win/ is ready. Build the Setup.exe on Windows (or with the GitHub Actions workflow).",
    );
    return;
  }
  execFileSync(iscc, [`/DAppVersion=${pkg.version}`, path.join(root, "packaging", "inno", "FoodMonsterPrint.iss")], { stdio: "inherit" });
  const setup = path.join(root, "build", "installer", `FoodMonsterPrint-Setup-${pkg.version}.exe`);
  console.log(`\nInstaller: ${setup}`);
  console.log(`SHA256:    ${sha256(setup)}`);
  console.log("For auto-update, upload the installer to an https URL and set in Laravel .env:");
  console.log(`  PRINT_V2_LATEST_VERSION=${pkg.version}`);
  console.log("  PRINT_V2_UPDATE_URL=https://.../FoodMonsterPrint-Setup-" + pkg.version + ".exe");
  console.log(`  PRINT_V2_UPDATE_SHA256=${sha256(setup)}`);
}

function findIscc() {
  if (process.env.ISCC && fs.existsSync(process.env.ISCC)) return process.env.ISCC;
  if (!isWindows) return null;
  for (const candidate of [
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

main().catch((error) => {
  console.error(`\nBUILD FAILED: ${error.message}`);
  process.exit(1);
});
