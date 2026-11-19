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

Status page (on this PC only): **http://127.0.0.1:9123**. It shows the printers, the last jobs and errors, and has a pairing form.

## Development on a Mac

```bash
npm install
npm test                 # 31 tests: raster, TCP timeouts, journal/outbox, queues, end-to-end with a mock server
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
#   other modes: --mode offline (refused), --mode drop (cable pulled -> PARTIAL_WRITE)
# 3. pair + run
npm run dev -- pair <CODE>
npm run dev -- run
# 4. on the server: php artisan print:test-job <branch> --count=3   (or click Print in the POS)
```

Instead of overrides, you can set `"printerMode": "fake"` to save every job in `.data/fake-prints/`.

To test a real network printer from the Mac: `npm run dev -- test-print --ip <printer IP>`.

## What must be tested on a Windows laptop

- Paths in `C:\ProgramData\FoodMonsterPrint` and file locking by antivirus (the code retries renames).
- Real Epson / Xprinter network printers: speed, cut, and long receipts (chunks of 255 rows).
- Stopping with Ctrl+C or as a service (Phase 4).
- **USB printers: Phase 3.** In this version a USB printer fails with the clear error `USB_NOT_SUPPORTED`.
# pos-print-service
