// spike.js — lógica de los 5 escenarios de validación.
// Objetivo: responder empíricamente si una impresora térmica BT es usable desde el
// navegador (Web Bluetooth BLE), y comparar Web Serial / WebUSB como alternativas.

import { buildTestTicket, buildTicketWithNielsEncoder } from './escpos.js';

// --- UUIDs GATT conocidos de impresoras térmicas (iterar en este orden) -----
// service -> característica de escritura esperada (informativo; igual auto-detectamos).
const KNOWN_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Goojprt/Zjiang/Munbyn/POS-58 BLE (más común)
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // MTP-2/3 (ISSC/Microchip)
  '0000ae30-0000-1000-8000-00805f9b34fb', // CAT / mini-printers
  '0000ff00-0000-1000-8000-00805f9b34fb', // PeriPage / FoMemo
  '0000ffe0-0000-1000-8000-00805f9b34fb', // módulos BLE genéricos (HM-10/JDY)
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Nordic-UART-like
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service
];

const CHUNK_SIZE = 512; // GATT: trocear escrituras largas

// --- Estado del spike -------------------------------------------------------
const state = {
  bleDevice: null,
  bleWriteChar: null,
  serialPort: null,
  usbDevice: null,
  usbEndpoint: null,
};

// --- Logging ----------------------------------------------------------------
const logEl = () => document.getElementById('log');
function log(msg, level = 'info') {
  const time = new Date().toLocaleTimeString();
  const colors = { info: '#cbd5e1', ok: '#4ade80', warn: '#fbbf24', err: '#f87171', dim: '#64748b' };
  const div = document.createElement('div');
  div.style.color = colors[level] || colors.info;
  div.style.whiteSpace = 'pre-wrap';
  div.textContent = `[${time}] ${msg}`;
  logEl().appendChild(div);
  logEl().scrollTop = logEl().scrollHeight;
  // eslint-disable-next-line no-console
  console.log(msg);
}
function clearLog() {
  logEl().innerHTML = '';
}
function hr() {
  log('────────────────────────────────', 'dim');
}

function supportReport() {
  const has = (x) => (x ? 'sí' : 'NO');
  log(`isSecureContext: ${has(window.isSecureContext)}`, window.isSecureContext ? 'ok' : 'err');
  log(`navigator.bluetooth: ${has('bluetooth' in navigator)}`, 'bluetooth' in navigator ? 'ok' : 'err');
  log(`navigator.serial:    ${has('serial' in navigator)}`, 'serial' in navigator ? 'ok' : 'warn');
  log(`navigator.usb:       ${has('usb' in navigator)}`, 'usb' in navigator ? 'ok' : 'warn');
  log(`getDevices():        ${has(navigator.bluetooth && navigator.bluetooth.getDevices)}`, 'dim');
  if (!window.isSecureContext) {
    log('⚠ Contexto NO seguro. En localhost funciona; por IP de LAN necesitas el flag', 'err');
    log('  chrome://flags/#unsafely-treat-insecure-origin-as-secure → agrega este origen.', 'err');
  }
  hr();
}

// ===========================================================================
// ESCENARIO 1 — Diagnóstico BLE vs SPP + volcado de servicios GATT
// ===========================================================================
async function scenarioDiagnose() {
  hr();
  log('ESCENARIO 1 — Diagnóstico BLE / volcado GATT', 'info');
  if (!('bluetooth' in navigator)) {
    log('Web Bluetooth no disponible en este navegador.', 'err');
    return;
  }
  try {
    log('Abriendo chooser (acceptAllDevices)… elige tu impresora.', 'info');
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: KNOWN_SERVICES,
    });
    state.bleDevice = device;
    log(`Dispositivo elegido: "${device.name || '(sin nombre)'}" id=${device.id}`, 'ok');
    log('→ Apareció en el chooser ⇒ ES BLE (no SPP-only). Buena señal.', 'ok');

    device.addEventListener('gattserverdisconnected', () =>
      log('GATT desconectado.', 'warn')
    );

    log('Conectando GATT…', 'info');
    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();
    log(`Servicios primarios encontrados: ${services.length}`, 'info');

    let firstWritable = null;
    for (const svc of services) {
      log(`• service ${svc.uuid}`, 'info');
      let chars = [];
      try {
        chars = await svc.getCharacteristics();
      } catch (e) {
        log(`    (no se pudieron leer características: ${e.message})`, 'warn');
        continue;
      }
      for (const ch of chars) {
        const p = ch.properties;
        const flags = [
          p.write && 'write',
          p.writeWithoutResponse && 'writeNoResp',
          p.read && 'read',
          p.notify && 'notify',
          p.indicate && 'indicate',
        ]
          .filter(Boolean)
          .join(', ');
        const writable = p.write || p.writeWithoutResponse;
        log(`    └ char ${ch.uuid} [${flags}]`, writable ? 'ok' : 'dim');
        if (writable && !firstWritable) firstWritable = ch;
      }
    }

    if (firstWritable) {
      state.bleWriteChar = firstWritable;
      log(`✔ Característica escribible detectada: ${firstWritable.service.uuid} / ${firstWritable.uuid}`, 'ok');
      log('Listo para "Imprimir ESC/POS".', 'ok');
    } else {
      log('✘ No se encontró característica escribible. ¿Servicios ocultos? Revisa nRF Connect.', 'err');
    }
  } catch (e) {
    if (e.name === 'NotFoundError') {
      log('Chooser cancelado o ningún dispositivo. Si tu impresora NO aparece aquí pero', 'warn');
      log('SÍ está en los ajustes Bluetooth del SO ⇒ es Bluetooth CLÁSICO/SPP ⇒', 'warn');
      log('Web Bluetooth NO sirve para ese hardware (necesitarías Capacitor nativo).', 'err');
    } else {
      log(`Error: ${e.name}: ${e.message}`, 'err');
    }
  }
}

// ===========================================================================
// ESCENARIO 2 — Imprimir ticket ESC/POS por BLE
// ===========================================================================
async function writeBleChunked(bytes) {
  const ch = state.bleWriteChar;
  const useNoResp = ch.properties.writeWithoutResponse && !ch.properties.write;
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.slice(i, i + CHUNK_SIZE);
    if (useNoResp && ch.writeValueWithoutResponse) {
      await ch.writeValueWithoutResponse(chunk);
    } else if (ch.writeValueWithResponse) {
      await ch.writeValueWithResponse(chunk).catch(() => ch.writeValue(chunk));
    } else {
      await ch.writeValue(chunk);
    }
    await new Promise((r) => setTimeout(r, 20)); // respiro entre chunks
  }
}

async function scenarioPrint(useNiels = false) {
  hr();
  log(`ESCENARIO 2 — Imprimir ESC/POS (${useNiels ? 'encoder Niels' : 'encoder propio'})`, 'info');
  if (!state.bleWriteChar) {
    log('No hay característica BLE. Corre "Diagnóstico" primero.', 'err');
    return;
  }
  try {
    let bytes;
    if (useNiels) {
      log('Cargando @point-of-sale/receipt-printer-encoder vía CDN…', 'info');
      bytes = await buildTicketWithNielsEncoder();
    } else {
      bytes = buildTestTicket();
    }
    log(`Enviando ${bytes.length} bytes en chunks de ${CHUNK_SIZE}…`, 'info');
    await writeBleChunked(bytes);
    log('✔ Enviado. ¿Salió el ticket? Toma foto para la matriz de resultados.', 'ok');
  } catch (e) {
    log(`Error imprimiendo: ${e.name}: ${e.message}`, 'err');
    if (useNiels) log('Si falló el CDN, prueba el botón "Imprimir (encoder propio)".', 'warn');
  }
}

// ===========================================================================
// ESCENARIO 3 — Auto-reconnect sin gesto (caso auto-print)
// ===========================================================================
async function scenarioAutoReconnect() {
  hr();
  log('ESCENARIO 3 — Auto-reconnect (getDevices + watchAdvertisements)', 'info');
  if (!navigator.bluetooth.getDevices) {
    log('getDevices() no disponible. Habilita chrome://flags/#enable-experimental-web-platform-features', 'err');
    return;
  }
  try {
    const devices = await navigator.bluetooth.getDevices();
    log(`Dispositivos ya permitidos para este origen: ${devices.length}`, devices.length ? 'ok' : 'warn');
    if (!devices.length) {
      log('Ninguno. Primero empareja una vez con "Diagnóstico" (requiere gesto).', 'warn');
      return;
    }
    const device = devices[0];
    log(`Esperando advertisement de "${device.name || device.id}" (acerca/enciende la impresora)…`, 'info');

    const ac = new AbortController();
    let done = false;
    device.addEventListener(
      'advertisementreceived',
      async () => {
        if (done) return;
        done = true;
        ac.abort();
        log('Advertisement recibido → conectando SIN gesto de usuario…', 'ok');
        try {
          const server = await device.gatt.connect();
          const services = await server.getPrimaryServices();
          let writeChar = null;
          for (const svc of services) {
            for (const ch of await svc.getCharacteristics()) {
              if (ch.properties.write || ch.properties.writeWithoutResponse) {
                writeChar = ch;
                break;
              }
            }
            if (writeChar) break;
          }
          if (!writeChar) {
            log('Conectó pero sin característica escribible.', 'err');
            return;
          }
          state.bleWriteChar = writeChar;
          await writeBleChunked(buildTestTicket());
          log('✔ Auto-print SIN gesto OK. Esto valida el caso "pedido por socket".', 'ok');
        } catch (e) {
          log(`Error en reconexión: ${e.message}`, 'err');
        }
      },
      { once: true }
    );

    await device.watchAdvertisements({ signal: ac.signal });
    log('watchAdvertisements activo…', 'dim');
  } catch (e) {
    log(`Error: ${e.name}: ${e.message}`, 'err');
  }
}

// ===========================================================================
// ESCENARIO 4 — Web Serial (USB/serial)
// ===========================================================================
async function scenarioSerial() {
  hr();
  log('ESCENARIO 4 — Web Serial', 'info');
  if (!('serial' in navigator)) {
    log('Web Serial no disponible (¿Firefox/Safari? solo Chromium).', 'err');
    return;
  }
  try {
    const port = state.serialPort || (await navigator.serial.requestPort());
    state.serialPort = port;
    if (!port.readable) await port.open({ baudRate: 9600 });
    log('Puerto serial abierto. Enviando ticket…', 'info');
    const writer = port.writable.getWriter();
    await writer.write(buildTestTicket());
    writer.releaseLock();
    log('✔ Enviado por Web Serial.', 'ok');
  } catch (e) {
    log(`Error: ${e.name}: ${e.message}`, 'err');
  }
}

// ===========================================================================
// ESCENARIO 5 — WebUSB
// ===========================================================================
async function scenarioUsb() {
  hr();
  log('ESCENARIO 5 — WebUSB', 'info');
  if (!('usb' in navigator)) {
    log('WebUSB no disponible (solo Chromium).', 'err');
    return;
  }
  try {
    const device = await navigator.usb.requestDevice({ filters: [] });
    state.usbDevice = device;
    log(`USB elegido: ${device.productName || '(?)'} VID=${device.vendorId} PID=${device.productId}`, 'ok');
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    // buscar interfaz con endpoint OUT bulk
    let claimed = null;
    let epOut = null;
    for (const iface of device.configuration.interfaces) {
      const alt = iface.alternates[0];
      const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (out) {
        try {
          await device.claimInterface(iface.interfaceNumber);
          claimed = iface.interfaceNumber;
          epOut = out.endpointNumber;
          break;
        } catch (e) {
          log(`Interfaz ${iface.interfaceNumber} reclamada por el SO: ${e.message}`, 'warn');
        }
      }
    }
    if (epOut === null) {
      log('✘ No se pudo reclamar interfaz. El driver del SO (printer-class) la tiene tomada.', 'err');
      log('  Este es el problema conocido de WebUSB con impresoras.', 'err');
      return;
    }
    await device.transferOut(epOut, buildTestTicket());
    log(`✔ Enviado por WebUSB (iface ${claimed}, ep ${epOut}).`, 'ok');
  } catch (e) {
    log(`Error: ${e.name}: ${e.message}`, 'err');
  }
}

// ===========================================================================
// AUTO-PRINT — Simulación de pedidos (el caso "socket NEW_ORDER → imprime solo")
// ---------------------------------------------------------------------------
// Clave: el gesto de usuario SOLO se necesita en requestDevice() (emparejar 1 vez).
// Después, reconectar (device.gatt.connect) y escribir NO requieren gesto. Las
// térmicas BLE se DUERMEN entre pedidos → reconectamos antes de cada impresión.
// ===========================================================================
async function findWritableChar(server) {
  for (const svc of await server.getPrimaryServices()) {
    for (const ch of await svc.getCharacteristics()) {
      if (ch.properties.write || ch.properties.writeWithoutResponse) return ch;
    }
  }
  return null;
}

// Garantiza conexión + característica vigentes, reconectando SIN gesto si hace falta.
async function ensureBleReady() {
  const device = state.bleDevice;
  if (!device) {
    throw new Error('Sin dispositivo. Empareja una vez con "Diagnóstico" o "Imprimir".');
  }
  if (!device.gatt.connected) {
    log('Impresora desconectada (¿dormida?). Reconectando SIN gesto…', 'warn');
    const server = await device.gatt.connect();
    state.bleWriteChar = await findWritableChar(server);
    if (!state.bleWriteChar) throw new Error('Reconectó pero sin característica escribible.');
    log('Reconectado.', 'ok');
  }
  return state.bleWriteChar;
}

let autoTimer = null;
let autoCount = 0;

async function autoPrintOnce() {
  const t0 = Date.now();
  try {
    await ensureBleReady();
    autoCount += 1;
    await writeBleChunked(buildTestTicket(autoCount));
    log(`🧾 Pedido simulado #${autoCount} → impreso SIN gesto (${Date.now() - t0}ms)`, 'ok');
  } catch (e) {
    log(`Auto-print #${autoCount + 1} falló: ${e.message}`, 'err');
  }
}

function startAutoSim() {
  if (autoTimer) {
    log('La simulación ya está corriendo.', 'warn');
    return;
  }
  if (!state.bleDevice) {
    log('Primero empareja: corre "Diagnóstico" o "Imprimir" una vez (requiere 1 gesto).', 'err');
    return;
  }
  const secs = Math.max(3, parseInt(document.getElementById('auto-interval').value || '15', 10));
  hr();
  log(`▶ Simulación de pedidos cada ${secs}s. NO toques nada: debe imprimir solo.`, 'info');
  log('  (Si la impresora se duerme, reconecta automáticamente antes de cada ticket.)', 'dim');
  autoPrintOnce(); // primer pedido inmediato
  autoTimer = setInterval(autoPrintOnce, secs * 1000);
}

function stopAutoSim() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    log('⏹ Simulación detenida.', 'warn');
  } else {
    log('No había simulación activa.', 'dim');
  }
}

// --- Wiring -----------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  supportReport();
  const bind = (id, fn) => document.getElementById(id).addEventListener('click', fn);
  bind('btn-diagnose', scenarioDiagnose);
  bind('btn-print', () => scenarioPrint(false));
  bind('btn-print-niels', () => scenarioPrint(true));
  bind('btn-reconnect', scenarioAutoReconnect);
  bind('btn-auto-start', startAutoSim);
  bind('btn-auto-stop', stopAutoSim);
  bind('btn-serial', scenarioSerial);
  bind('btn-usb', scenarioUsb);
  bind('btn-clear', clearLog);
});
