# FoodMonsterPrint

The Windows print service for FoodMonster POS (Print Service v2). It replaces `bridge.php`.

It polls Laravel (`/api/print/v2/sync`) for print tasks, prints the receipt image to each printer as ESC/POS raster, and reports the result (`/api/print/v2/ack`). The server side is documented in `little-duckling-api/docs/PRINT_SERVICE_V2.md`.

## How it works

```
Poller (every 2.5 s) ── sync ──> Laravel: renews leases of tasks in progress, gets new tasks
   │
Dispatcher ──> one queue PER PRINTER (all printers in parallel)
   │              └─ download image once (sha256 check) → ESC/POS raster → TCP 9100 / fake file
   │              └─ retry after 5, 15, 30, 60 s if nothing reached the printer
Journal (disk) + Ack outbox (disk) ──> AckSender ──> Laravel (retries until delivered)
```

### Rules that stop double prints
1. Every task is written to `journal.json` as `claimed → sending → printed/failed`. A task that is already `printed` is never printed again; it is only acked.
2. If the service stops while a task is `sending`, the result is unknown. It is reported as **failed (UNCERTAIN_RESTART)** and is **never reprinted automatically**. Staff press Reprint if needed.
3. If the connection breaks **after** bytes were sent (`PARTIAL_WRITE`, `WRITE_TIMEOUT`), there is **no automatic retry**.
4. Acks are kept in `ack-outbox.json` until the server answers. The task's lease is renewed until the ack is delivered, so the server never gives a printed task to another PC.
5. A task is not started if its lease may have expired (server unreachable for more than about 1.5 minutes) or if the server says another device took it.

## Files (data folder)

The data folder is `C:\ProgramData\FoodMonsterPrint\` on Windows and `~/.foodmonsterprint` on Mac. You can change it with `FMP_DATA_DIR`.

| File | What |
|---|---|
| `config.json` | settings (created with defaults on first run; see `config.example.json`) |
| `device.json` | device token from pairing (secret, never logged) |
| `journal.json` | tasks of the last 24 h and their state |
| `ack-outbox.json` | results not yet delivered to the server |
| `logs/service-YYYY-MM-DD.log` | JSON logs, kept 14 days |
| `fake-prints/` | output in `"printerMode": "fake"` |

## Commands

```bash
foodmonsterprint run                      # start the service (default)
foodmonsterprint pair <CODE>              # pair with a code from: php artisan print:pairing-code <branch>
foodmonsterprint unpair
foodmonsterprint status                   # JSON status of the running service
foodmonsterprint test-print --ip 192.168.1.50 [--port 9100] [--width 576]   # direct test, no server
foodmonsterprint test-print --fake        # writes a test pattern to fake-prints/
```

Status page (on this PC only): **http://127.0.0.1:9123**. It shows the printers with their health, the last jobs and errors, and has a pairing form.

## Printers

### Network printers (Epson / Xprinter LAN)
- They use raw TCP port 9100: 5 s connect timeout, 15 s write timeout.
- **Status check before each job** (`tcp.statusCheck`, on by default): the service asks the printer `DLE EOT 2` and `DLE EOT 4` on the same connection.
  - Paper out or cover open: **nothing is sent**. The error is `PAPER_OUT` / `COVER_OPEN` and the service retries later.
  - A printer that does not answer within 1.5 s is printed to normally.

### USB printers (Windows only)
- The Windows printer must be installed (any driver: Epson, Xprinter, or "Generic / Text Only").
- **The printer name in admin Printer List must be exactly the Windows printer name.** If it is different, set it on this PC:
  `"printerOverrides": { "5": { "windowsPrinter": "XP-80C" } }`
- The service sends RAW ESC/POS bytes through the Windows spooler (no printer sharing needed) and then **watches the Windows job** (`usb.waitForJobMs`, 30 s):
  - The job leaves the queue: printed.
  - Windows reports offline, paper out or an error before printing started: the job is **deleted from the queue**, so it can never print hours later. The service then retries, or reports the reason.
  - The job did not start within 30 s: it is deleted and the service retries.
- If the printer name is wrong, the error lists the printers that are installed in Windows.
- Bind a USB printer to its laptop in admin (Printer List → Device), so other laptops never get its jobs.

### Heartbeat
Every 30 s the service sends the health of each printer to the server (`OK`, `PAPER_OUT`, `COVER_OPEN`, `OFFLINE`, `UNREACHABLE`, `NO_STATUS`...). POS and admin show it as green/red dots. A printer that is busy printing is not probed.

## Development on a Mac

```bash
npm install
npm test                 # raster, TCP timeouts, status checks, journal/outbox, queues, heartbeat, end-to-end with a mock server
npm run build            # -> dist/
```

### Try it against staging with fake printers
```bash
export FMP_DATA_DIR=$PWD/.data
# 1. config: point printers to fake printers on this Mac (printer ids from Printer List)
cat > .data/config.json <<'JSON'
{ "serverUrl": "https://staging.foodmonster.asia", "deviceName": "Mac test",
  "printerOverrides": { "1": { "ip": "127.0.0.1", "port": 9101 }, "2": { "ip": "127.0.0.1", "port": 9102 } } }
JSON
# 2. fake printers (each in its own terminal)
npm run fake-printer -- --port 9101                  # works, saves .bin + .png per receipt
npm run fake-printer -- --port 9102 --mode hang      # never reads -> WRITE_TIMEOUT
#   other modes: --mode offline (refused), --mode drop (cable pulled -> PARTIAL_WRITE),
#                --mode paper-out, --mode cover-open (status check stops the job), --mode silent (no status answers)
# 3. pair + run
npm run dev -- pair <CODE>
npm run dev -- run
# 4. on the server: php artisan print:test-job <branch> --count=3   (or click Print in the POS)
```

Instead of overrides, you can set `"printerMode": "fake"` to save every job in `.data/fake-prints/`.

To test a real network printer from the Mac: `npm run dev -- test-print --ip <printer IP>`.

## Windows package (Setup.exe)

```bash
node scripts/build-windows.mjs      # build/win/ (+ build/installer/FoodMonsterPrint-Setup-<version>.exe on Windows with Inno Setup 6.3+)
```
On a Mac only `build/win/` is made. The `.exe` is built on Windows, or with the GitHub Actions workflow `.github/workflows/windows-build.yml` ("Run workflow", or push a tag `v0.4.0`), which uploads the installer as an artifact.

**What gets installed** (in `C:\Program Files\FoodMonsterPrint\`):

| File | What |
|---|---|
| `FoodMonsterPrint.exe` + `.xml` | WinSW 2.12 service wrapper: automatic start; restart after a crash (5 s / 10 s / 30 s) |
| `node\node.exe` | official Node.js 24 LTS (sha256 checked at build time) |
| `app\` | FoodMonsterPrint code + pngjs + koffi (Windows x64) |
| `fmp.cmd` | command line, run as Administrator: `fmp status`, `fmp pair CODE`, `fmp test-print --ip 192.168.1.50` |

- The service runs as **LocalSystem** for all users and starts when Windows starts.
- The data folder `C:\ProgramData\FoodMonsterPrint` is readable only by SYSTEM and Administrators, because it holds the device token.

**Installer:**
- **First install** asks for the server (Production / Staging / other) and writes `config.json`. Then it opens the status page so you can pair the PC.
- **Silent install:** `Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /SERVER=https://admin.foodmonster.asia`
- **Upgrade:** stops and removes the old service, replaces the files, installs and starts the new service. `config.json`, the token, the journal and the outbox are kept. Installing an older Setup.exe works the same way (this is the rollback).
- **Uninstall:** stops and removes the service. It asks before deleting the settings and logs (default: keep them).

**Auto-update:**
- Every 6 hours the service asks Laravel `GET /api/print/v2/update`.
- A **higher** version is downloaded (https), its sha256 is checked, and it is installed silently through Windows Task Scheduler. This happens only when nothing is printing.
- Turn it off per PC with `"update": { "enabled": false }` in `config.json`.

**Not signed:** the installer has no code-signing certificate, so Windows SmartScreen shows "Windows protected your PC". Click "More info" → "Run anyway". A certificate (about 200-400 USD per year) removes this.

## What must be tested on a Windows laptop

- Paths in `C:\ProgramData\FoodMonsterPrint` and file locking by antivirus (the code retries renames).
- Real Epson / Xprinter network printers: speed, cut, and long receipts (chunks of 255 rows).
- Stopping with Ctrl+C or as a service (Phase 4).
- **USB printers** (the Windows spooler calls cannot run on a Mac): printing, job watching, offline / paper-out detection, a wrong printer name.
# pos-print-service
