# web-bluetooth-receipt-printer-spike

A throwaway **spike** to evaluate printing ESC/POS receipts to Bluetooth thermal
printers **straight from the browser** — no desktop app, no drivers — using
[Project Fugu](https://developer.chrome.com/docs/capabilities) web APIs
(Web Bluetooth, with Web Serial / WebUSB as alternatives).

> Goal: find out whether a web POS panel can replace an Electron desktop print
> app. Short answer from this spike: **yes for printing itself**, but persistent
> "pair once and forget" still needs help (see *Findings*).

## What's inside

Two static, build-free pages served over `localhost` (Web Bluetooth requires a
secure context — `localhost` qualifies; over a LAN IP you need a Chrome flag, see below):

| File | What it is |
|---|---|
| `flow.html` / `flow.js` | **Real-flow simulator** — multi-printer (Caja/Cocina), role assignment, save & re-confirm, manual print per printer, editable ticket data, auto-print simulation |
| `index.html` / `spike.js` | **Technical playground** — 5 scenarios: BLE-vs-SPP diagnosis, ESC/POS print, gesture-less auto-reconnect, Web Serial, WebUSB |
| `escpos.js` | Minimal self-contained ESC/POS encoder (+ optional NielsLeenheer `@point-of-sale/receipt-printer-encoder` via CDN) |
| `serve.sh` | Serves the folder on `0.0.0.0:8099` (localhost + LAN) |

## Run it

### On your computer (Chrome or Edge)

```bash
./serve.sh            # → http://localhost:8099
```

Open **http://localhost:8099/flow.html** (the simulator) or **/index.html** (the playground).

### On an Android phone/tablet (same Wi‑Fi)

`serve.sh` prints a LAN URL (e.g. `http://192.168.0.171:8099`). Web Bluetooth over
a plain‑HTTP LAN IP is **not** a secure context, so enable it once in the device's Chrome:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Add the exact origin (e.g. `http://192.168.0.171:8099`), set **Enabled**, relaunch Chrome.

## Findings (the honest part)

- ✅ **Printing works.** Generic BLE thermal printers (tested: a `PT-220` /
  Goojprt-class, service `0x18F0` / char `0x2AF1`) print ESC/POS fine from the browser.
- ✅ **Auto-print works** within a live session — once connected, printing on an
  event needs no user gesture; reconnect-on-sleep is gesture-less too.
- ⚠️ **Persistence is the catch.** `navigator.bluetooth.getDevices()` (remembering a
  device across reloads/sessions) is behind `chrome://flags/#enable-web-bluetooth-new-permissions-backend`
  and **not on by default** — so without it, the chooser reappears after a reload.
  The simulator works around this by saving the printer and showing a **filtered
  "confirm today's printer"** step instead of a cold re-pair.
- ❌ **Not a universal Electron replacement.** Web Bluetooth is **BLE/GATT only**
  (no Bluetooth Classic/SPP), Chromium-only (no iOS/Safari/Firefox), and browsers
  can't open raw TCP sockets (no network/IP printers). For "pair once, zero
  friction" on a fixed POS, a thin native wrapper (Capacitor) or a local print
  agent is more robust.

## Tech notes

- **Filtering the chooser:** `requestDevice({ filters: [{ namePrefix, services }] })`
  narrows the dialog to the target printer, but a single device still requires one
  tap (security by design — no auto-select, no enterprise policy bypass).
- **Multiple printers:** you can hold several BLE connections at once and route each
  job (full ticket → Caja, kitchen comanda → Cocina). One pairing per physical device.
- **Web Serial / WebUSB** *do* persist permissions across sessions without a flag —
  relevant for USB printers on desktop.

## Status

Experimental / proof-of-concept. Not production code. Built as a spike; expect rough edges.
