// flow.js — Simulador del FLUJO REAL del panel web, MULTI-IMPRESORA.
// Modelo: un "slot lógico" (Caja / Cocina / …) apunta a un dispositivo físico.
//   • VARIOS slots pueden apuntar a la MISMA impresora física (para probar con una sola):
//     comparten la conexión BLE; cada slot tiene su rol y su tipo de ticket.
//   • Agregar una impresora pregunta el ROL (no lo adivina).
//   • 1ª vez configura; al regreso "confirma" (chooser filtrado o getDevices sin diálogo).
//
// Realidad honesta: cada dispositivo FÍSICO se empareja una vez (un tap). Repetir el
// mismo dispositivo en otro slot reusa la conexión existente (cero diálogo adicional).

import { EscPos } from './escpos.js';

// En el panel real esto vive en el PERFIL DEL COMERCIO (backend), no en localStorage
// per-dispositivo (que el resetStore en login borra). Aquí localStorage lo simula.
const STORE_KEY = 'plickPrinters';
const TD_KEY = 'plickTicketData';
const CHUNK = 512;
const SERVICES = [
  0x18f0, 0xffe0, 0xff00, 0xae30,
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

const state = {
  printers: [], // slots lógicos: [{ id, label, deviceName, deviceId, ticketType, savedAt }]
  rt: new Map(), // deviceId -> { device, writeChar }  (runtime por dispositivo FÍSICO)
  autoTimer: null,
  folio: 0,
  pendingAssign: null,
  ticketData: {
    business: 'PLICK',
    items: ['2x Tacos al pastor | $60', '1x Horchata | $25'],
    total: '$85',
  },
};

function genId() {
  return 'L' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
}

// --- Persistencia (simula perfil de comercio) -------------------------------
function load() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return (Array.isArray(v) ? v : []).map((p) => ({
      id: p.id || genId(),
      label: p.label || 'Impresora',
      deviceName: p.deviceName || p.name || '(impresora)',
      deviceId: p.deviceId || null, // se re-resuelve al confirmar
      ticketType: p.ticketType || 'normal',
      savedAt: p.savedAt || null,
    }));
  } catch {
    return [];
  }
}
function persist() {
  // No serializamos deviceId runtime que cambie por sesión; lo guardamos como pista.
  localStorage.setItem(STORE_KEY, JSON.stringify(state.printers));
}
function forgetAll() {
  localStorage.removeItem(STORE_KEY);
  state.printers = [];
  state.rt.clear();
  stopAuto();
}

// --- Log --------------------------------------------------------------------
function log(msg, level = 'info') {
  const colors = { info: '#cbd5e1', ok: '#4ade80', warn: '#fbbf24', err: '#f87171', dim: '#64748b' };
  const elx = document.getElementById('log');
  const div = document.createElement('div');
  div.style.color = colors[level] || colors.info;
  div.style.whiteSpace = 'pre-wrap';
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  elx.appendChild(div);
  elx.scrollTop = elx.scrollHeight;
}

// --- BLE helpers ------------------------------------------------------------
async function findWritableChar(server) {
  for (const svc of await server.getPrimaryServices()) {
    for (const ch of await svc.getCharacteristics()) {
      if (ch.properties.write || ch.properties.writeWithoutResponse) return ch;
    }
  }
  return null;
}

async function writeChunked(ch, bytes) {
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.slice(i, i + CHUNK);
    if (ch.writeValueWithoutResponse && ch.properties.writeWithoutResponse && !ch.properties.write) {
      await ch.writeValueWithoutResponse(part);
    } else {
      await ch.writeValue(part);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function rtFor(profile) {
  return profile.deviceId ? state.rt.get(profile.deviceId) : null;
}
function isConnected(profile) {
  const r = rtFor(profile);
  return !!(r && r.device.gatt.connected && r.writeChar);
}

// Conecta un dispositivo físico y lo registra por su deviceId (compartido entre slots).
async function attachDevice(device) {
  device.addEventListener('gattserverdisconnected', () => {
    log(`Una impresora física se desconectó (${device.name || device.id}).`, 'warn');
    render();
  });
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const writeChar = await findWritableChar(server);
  if (!writeChar) throw new Error('Conectada pero sin característica escribible.');
  state.rt.set(device.id, { device, writeChar });
  return device.id;
}

async function ensureReady(profile) {
  const r = rtFor(profile);
  if (!r) throw new Error('Sin conexión. Confirma esta impresora primero.');
  if (!r.device.gatt.connected) {
    log(`Reconectando "${profile.label}" en silencio…`, 'dim');
    await attachDevice(r.device);
    log(`"${profile.label}" reconectada.`, 'ok');
  }
  return state.rt.get(profile.deviceId).writeChar;
}

// --- Datos del ticket (simulados, editables) --------------------------------
function loadTicketData() {
  try {
    const v = JSON.parse(localStorage.getItem(TD_KEY) || 'null');
    if (v && typeof v === 'object') state.ticketData = { ...state.ticketData, ...v };
  } catch {}
}
function persistTicketData() {
  localStorage.setItem(TD_KEY, JSON.stringify(state.ticketData));
}

// --- Ticket etiquetado (usa los datos editables; prueba el ruteo a cada slot) -
function buildLabeledTicket(label, ticketType, folio) {
  const d = state.ticketData;
  const t = new EscPos().align(1).size(3).bold(true).line(d.business || 'PLICK').size(0).bold(false);
  t.line(ticketType === 'simplified' ? '** COMANDA **' : 'Ticket de venta');
  t.line(`Impresora: ${label}`).feed(1).align(0).line(`Pedido #${folio}`);
  for (const raw of d.items || []) {
    const [name, price] = String(raw).split('|').map((s) => s.trim());
    if (!name) continue;
    if (ticketType === 'simplified') t.line(name); // comanda: sin precios
    else t.line(price ? `${name}  ${price}` : name);
  }
  if (ticketType !== 'simplified' && d.total) t.line(`TOTAL  ${d.total}`);
  t.feed(1).align(1).line('* * *').feed(3).cut();
  return t.encode();
}

// --- Agregar (permite la MISMA impresora física en varios slots) ------------
async function addPrinter() {
  log('Agregar impresora: elige una en la lista. Puedes elegir la misma para otro rol.', 'info');
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: SERVICES,
    });
    const profile = {
      id: genId(),
      label: null,
      deviceName: device.name || '(impresora)',
      deviceId: device.id || null,
      ticketType: null,
      savedAt: new Date().toISOString(),
    };
    // Si ese dispositivo físico ya está conectado (otro slot), reusar la conexión.
    if (device.id && state.rt.get(device.id)?.device?.gatt?.connected) {
      log('Esa impresora física ya estaba conectada → reuso su conexión para el nuevo rol.', 'dim');
    } else {
      await attachDevice(device);
    }
    state.pendingAssign = profile;
    log(`Conectada "${profile.deviceName}". ¿Para qué la usarás?`, 'info');
    render();
  } catch (e) {
    if (e.name === 'NotFoundError') log('Cancelado.', 'warn');
    else log(`Error: ${e.message}`, 'err');
  }
}

// --- Asignar rol (el usuario decide; de aquí salen nombre + tipo de ticket) --
function assignRole(label, ticketType) {
  const p = state.pendingAssign;
  if (!p) return;
  p.label = label;
  p.ticketType = ticketType;
  state.printers.push(p);
  state.pendingAssign = null;
  persist();
  const dupe = state.printers.filter((x) => x.deviceId && x.deviceId === p.deviceId).length > 1;
  log(`✔ "${label}" lista${dupe ? ' (misma impresora física que otro rol)' : ''}.`, 'ok');
  render();
}
function cancelAssign() {
  const p = state.pendingAssign;
  if (p && p.deviceId) {
    const sharedByOther = state.printers.some((x) => x.deviceId === p.deviceId);
    if (!sharedByOther) {
      const r = state.rt.get(p.deviceId);
      if (r && r.device.gatt.connected) r.device.gatt.disconnect();
      state.rt.delete(p.deviceId);
    }
  }
  state.pendingAssign = null;
  log('Cancelado.', 'warn');
  render();
}

// --- Confirmar UNA (regreso) ------------------------------------------------
async function confirm(profile) {
  log(`Confirmando "${profile.label}" (${profile.deviceName})…`, 'info');
  // Si la misma impresora física ya está conectada por otro slot, reusar.
  for (const [devId, r] of state.rt) {
    if (r.device.gatt.connected && (devId === profile.deviceId || r.device.name === profile.deviceName)) {
      profile.deviceId = devId;
      persist();
      log(`"${profile.label}" usa una impresora ya conectada → sin diálogo.`, 'ok');
      render();
      return true;
    }
  }
  // Camino ideal: getDevices() → sin diálogo (si el flag está activo).
  try {
    if (navigator.bluetooth.getDevices) {
      const known = await navigator.bluetooth.getDevices();
      const m = known.find((d) => d.id === profile.deviceId) || known.find((d) => d.name === profile.deviceName);
      if (m) {
        await attachDevice(m);
        profile.deviceId = m.id;
        persist();
        log(`🎉 "${profile.label}" reconectada SIN diálogo.`, 'ok');
        render();
        return true;
      }
    }
  } catch (e) {
    log(`getDevices falló (${e.message}).`, 'dim');
  }
  // Fallback: chooser FILTRADO por el nombre guardado → solo aparece la suya.
  try {
    const prefix = (profile.deviceName || '').split('_')[0] || profile.deviceName || 'Printer';
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: prefix }],
      optionalServices: SERVICES,
    });
    await attachDevice(device);
    profile.deviceId = device.id;
    profile.deviceName = device.name || profile.deviceName;
    persist();
    log(`✔ "${profile.label}" confirmada y conectada.`, 'ok');
    render();
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') log(`"${profile.label}": confirmación cancelada.`, 'warn');
    else log(`Error: ${e.message}`, 'err');
    return false;
  }
}

// Resuelve (sin diálogo) los slots cuyo dispositivo físico YA está conectado.
function resolveShared() {
  for (const p of state.printers) {
    if (isConnected(p)) continue;
    for (const [devId, r] of state.rt) {
      if (r.device.gatt.connected && (devId === p.deviceId || r.device.name === p.deviceName)) {
        p.deviceId = devId;
        break;
      }
    }
  }
}

async function confirmAll() {
  resolveShared(); // reusar conexiones físicas ya abiertas
  let pending = state.printers.filter((p) => !isConnected(p));
  if (!pending.length) {
    persist();
    render();
    log('Todas ya están conectadas.', 'ok');
    return;
  }

  // Con getDevices(): pre-pass silencioso (consume el gesto, pero no hace falta chooser).
  if (navigator.bluetooth.getDevices) {
    try {
      const known = await navigator.bluetooth.getDevices();
      for (const p of pending) {
        if (isConnected(p)) continue;
        const m = known.find((d) => d.id === p.deviceId) || known.find((d) => d.name === p.deviceName);
        if (m) {
          await attachDevice(m);
          p.deviceId = m.id;
        }
      }
    } catch {}
    resolveShared();
    pending = state.printers.filter((p) => !isConnected(p));
    persist();
    render();
    if (pending.length) {
      log(`Confirma tocando cada una: ${[...new Set(pending.map((p) => p.label))].join(', ')}.`, 'warn');
    } else {
      log('✔ Todas conectadas sin diálogo.', 'ok');
    }
    return;
  }

  // Sin getDevices(): abrir UN chooser dentro del gesto para el primer dispositivo físico.
  // Todos los slots que usen ESE mismo dispositivo quedan confirmados de una.
  const firstName = pending[0].deviceName;
  try {
    const prefix = (firstName || '').split('_')[0] || firstName || 'Printer';
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: prefix }],
      optionalServices: SERVICES,
    });
    await attachDevice(device);
    for (const p of state.printers) {
      if (!isConnected(p) && (p.deviceName === device.name || p.deviceName === firstName)) {
        p.deviceId = device.id;
      }
    }
    persist();
    render();
  } catch (e) {
    if (e.name === 'NotFoundError') log('Confirmación cancelada.', 'warn');
    else log(`Error: ${e.message}`, 'err');
    render();
    return;
  }

  const rest = state.printers.filter((p) => !isConnected(p));
  if (rest.length) {
    log(`Falta otra impresora física: ${[...new Set(rest.map((p) => p.label))].join(', ')} → toca "Confirmar" en cada una.`, 'warn');
  } else {
    log('✔ Todas conectadas.', 'ok');
  }
}

// Muestra el aviso de que falta el flag para reconectar sin diálogo.
function showFlagBanner() {
  const b = document.getElementById('flag-banner');
  if (b) b.style.display = 'block';
}

// Reconecta en segundo plano cuando la impresora "aparece" en el aire (despierta /
// vuelve a rango). Mismo patrón que el escenario 3 del playground (spike.js).
function watchAndReconnect(device) {
  if (!device.watchAdvertisements) return;
  const onAdv = async () => {
    device.removeEventListener('advertisementreceived', onAdv);
    try {
      await attachDevice(device);
      for (const p of state.printers) {
        if (p.deviceId === device.id || p.deviceName === device.name) p.deviceId = device.id;
      }
      resolveShared();
      persist();
      log(`🔄 "${device.name || device.id}" apareció → reconectada sin diálogo.`, 'ok');
      render();
    } catch (e) {
      log(`Reconexión falló: ${e.message}`, 'err');
    }
  };
  device.addEventListener('advertisementreceived', onAdv, { once: true });
  device.watchAdvertisements().catch((e) => {
    device.removeEventListener('advertisementreceived', onAdv);
    log(`watchAdvertisements no disponible (${e.message}).`, 'dim');
  });
}

// Reconexión SILENCIOSA al cargar la página. Nunca llama requestDevice() (eso exigiría
// un gesto del usuario), así que es seguro dispararla en el arranque.
async function autoReconnect() {
  resolveShared(); // reusar conexiones físicas ya abiertas
  let pending = state.printers.filter((p) => !isConnected(p));
  if (!pending.length) return;

  if (!navigator.bluetooth?.getDevices) {
    showFlagBanner();
    log('Reconexión automática no disponible (activa el flag). Usa "Confirmar".', 'warn');
    return;
  }

  let known = [];
  try {
    known = await navigator.bluetooth.getDevices();
  } catch (e) {
    log(`getDevices falló (${e.message}).`, 'dim');
    return;
  }

  // Una sola conexión por dispositivo FÍSICO (varios slots pueden compartirlo).
  const seen = new Set();
  for (const p of pending) {
    const m = known.find((d) => d.id === p.deviceId) || known.find((d) => d.name === p.deviceName);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    try {
      await attachDevice(m); // gatt.connect() SIN gesto (impresora encendida y en rango)
      p.deviceId = m.id;
    } catch {
      watchAndReconnect(m); // dormida/fuera de rango → reconecta sola al despertar
    }
  }
  resolveShared();
  persist();
  render();

  const rest = state.printers.filter((p) => !isConnected(p));
  if (!rest.length) log('🎉 Todas reconectadas sin diálogo.', 'ok');
  else log(`Reconectando en segundo plano: ${[...new Set(rest.map((p) => p.label))].join(', ')}…`, 'dim');
}

async function manualPrint(profile) {
  try {
    const ch = await ensureReady(profile);
    state.folio += 1;
    await writeChunked(ch, buildLabeledTicket(profile.label, profile.ticketType, state.folio));
    log(`🖨️ Impreso en "${profile.label}" (${profile.ticketType === 'simplified' ? 'comanda' : 'ticket'}) #${state.folio}.`, 'ok');
  } catch (e) {
    log(`Error imprimiendo en "${profile.label}": ${e.message}`, 'err');
  }
}

function renamePrinter(profile) {
  const v = prompt('Nombre para esta impresora (ej. Caja, Cocina):', profile.label);
  if (v && v.trim()) {
    profile.label = v.trim();
    persist();
    render();
  }
}

// Suelta la conexión BLE (sin borrar el perfil) → la impresora queda libre para
// conectarse en OTRO equipo (ej. tu Mac). Si otros slots comparten el dispositivo
// físico, también se sueltan (es el mismo aparato).
function disconnectPrinter(profile) {
  const r = rtFor(profile);
  if (r && r.device.gatt.connected) r.device.gatt.disconnect();
  if (profile.deviceId) state.rt.delete(profile.deviceId);
  log(`"${profile.label}" desconectada de este equipo. Libre para emparejar en otro.`, 'warn');
  render();
}

// Suelta TODAS las conexiones físicas (sin borrar perfiles) → libera la(s)
// impresora(s) para emparejar en otro equipo. Botón global, siempre visible.
function disconnectAll() {
  let n = 0;
  for (const [, r] of state.rt) {
    if (r.device.gatt.connected) {
      r.device.gatt.disconnect();
      n += 1;
    }
  }
  state.rt.clear();
  stopAuto();
  log(n ? `🔌 ${n} impresora(s) desconectada(s). Libres para otro equipo.` : 'No había conexiones activas.', 'warn');
  render();
}

function removePrinter(profile) {
  state.printers = state.printers.filter((p) => p !== profile);
  const stillUsed = state.printers.some((p) => p.deviceId && p.deviceId === profile.deviceId);
  if (!stillUsed && profile.deviceId) {
    const r = state.rt.get(profile.deviceId);
    if (r && r.device.gatt.connected) r.device.gatt.disconnect();
    state.rt.delete(profile.deviceId);
  }
  persist();
  log(`"${profile.label}" eliminada.`, 'warn');
  render();
}

function toggleTicketType(profile) {
  profile.ticketType = profile.ticketType === 'simplified' ? 'normal' : 'simplified';
  persist();
  render();
}

// --- Auto-print (pedido → imprime en TODOS los slots conectados) ------------
async function autoTick() {
  const connected = state.printers.filter(isConnected);
  if (!connected.length) {
    log('Pedido entrante pero ninguna impresora conectada.', 'warn');
    return;
  }
  state.folio += 1;
  const f = state.folio;
  for (const p of connected) {
    try {
      await writeChunked(state.rt.get(p.deviceId).writeChar, buildLabeledTicket(p.label, p.ticketType, f));
      log(`🧾 Pedido #${f} → "${p.label}".`, 'ok');
    } catch (e) {
      log(`Pedido #${f} falló en "${p.label}": ${e.message}`, 'err');
    }
  }
}
// Imprime una vez en TODOS los slots conectados (un pedido manual).
async function printAll() {
  const connected = state.printers.filter(isConnected);
  if (!connected.length) {
    log('Ninguna impresora conectada. Confirma al menos una.', 'warn');
    return;
  }
  state.folio += 1;
  const f = state.folio;
  for (const p of connected) {
    try {
      await writeChunked(state.rt.get(p.deviceId).writeChar, buildLabeledTicket(p.label, p.ticketType, f));
      log(`🖨️ Pedido #${f} → "${p.label}".`, 'ok');
    } catch (e) {
      log(`Pedido #${f} falló en "${p.label}": ${e.message}`, 'err');
    }
  }
}

function startAuto() {
  if (state.autoTimer) return;
  const secs = Math.max(3, parseInt(document.getElementById('auto-int')?.value || '15', 10));
  log(`▶ Pedidos automáticos cada ${secs}s → se imprimen en todos los slots. No toques nada.`, 'info');
  autoTick();
  state.autoTimer = setInterval(autoTick, secs * 1000);
  render();
}
function stopAuto() {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
    log('⏹ Detenido.', 'warn');
  }
  render();
}

// --- Render -----------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderCard(profile) {
  const conn = isConnected(profile);
  const card = el('div', 'pcard');

  const top = el('div', 'pcard-top');
  top.appendChild(el('span', 'plabel', profile.label));
  top.appendChild(el('span', 'pname', profile.deviceName));
  top.appendChild(el('span', 'pstatus ' + (conn ? 'on' : 'off'), conn ? '✅ conectada' : '⚪ por confirmar'));
  card.appendChild(top);

  const shares = state.printers.filter((p) => p.deviceId && p.deviceId === profile.deviceId).length > 1;
  card.appendChild(
    el(
      'div',
      'pcard-sub',
      `Imprime: ${profile.ticketType === 'simplified' ? 'Comanda (cocina)' : 'Ticket completo'}` +
        (shares ? ' · comparte impresora física' : '')
    )
  );

  const actions = el('div', 'pcard-actions');
  if (conn) {
    const bp = el('button', 'mini print', '🖨️ Imprimir prueba');
    bp.onclick = () => manualPrint(profile);
    actions.appendChild(bp);
    const bt = el('button', 'mini ghost', '🔁 Tipo');
    bt.onclick = () => toggleTicketType(profile);
    actions.appendChild(bt);
    const bd = el('button', 'mini ghost', '🔌');
    bd.title = 'Desconectar (liberar para otro equipo)';
    bd.onclick = () => disconnectPrinter(profile);
    actions.appendChild(bd);
  } else {
    const bc = el('button', 'mini ok', '✅ Confirmar');
    bc.onclick = () => confirm(profile);
    actions.appendChild(bc);
  }
  const br = el('button', 'mini ghost', '✏️');
  br.title = 'Renombrar';
  br.onclick = () => renamePrinter(profile);
  actions.appendChild(br);
  const bx = el('button', 'mini ghost', '🗑️');
  bx.title = 'Eliminar';
  bx.onclick = () => removePrinter(profile);
  actions.appendChild(bx);
  card.appendChild(actions);

  return card;
}

function render() {
  // Pantalla de asignación de rol (tras agregar).
  if (state.pendingAssign) {
    document.getElementById('scr-empty').style.display = 'none';
    document.getElementById('scr-panel').style.display = 'none';
    document.getElementById('scr-assign').style.display = 'block';
    document.getElementById('assign-name').textContent = state.pendingAssign.deviceName;
    return;
  }
  document.getElementById('scr-assign').style.display = 'none';

  const hasAny = state.printers.length > 0;
  document.getElementById('scr-empty').style.display = hasAny ? 'none' : 'block';
  document.getElementById('scr-panel').style.display = hasAny ? 'block' : 'none';
  if (!hasAny) return;

  const pending = state.printers.filter((p) => !isConnected(p));
  const title = document.getElementById('panel-title');
  const sub = document.getElementById('panel-sub');
  if (pending.length) {
    title.textContent = '👋 ¡Hola de nuevo!';
    sub.textContent = 'Confirma tus impresoras de hoy. No re-emparejamos nada.';
  } else {
    title.textContent = '✅ Todo listo';
    sub.textContent = state.autoTimer
      ? 'Imprimiendo pedidos automáticamente en cada impresora…'
      : 'Los pedidos se imprimen solos en cada impresora.';
  }

  const list = document.getElementById('printer-list');
  list.innerHTML = '';
  state.printers.forEach((p) => list.appendChild(renderCard(p)));

  document.getElementById('btn-confirm-all').style.display = pending.length > 1 ? 'block' : 'none';
  document.getElementById('auto-status').textContent = state.autoTimer ? '🟢 corriendo' : '';
}

// --- Init -------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  if (!('bluetooth' in navigator)) log('Web Bluetooth no disponible en este navegador.', 'err');
  log(
    navigator.bluetooth?.getDevices
      ? 'getDevices(): disponible → puede reconectar sin diálogo.'
      : 'getDevices(): NO → "Confirmar" abre un chooser filtrado (solo tu impresora).',
    'dim'
  );

  state.printers = load();
  if (state.printers.length) log(`Impresoras guardadas: ${state.printers.map((p) => p.label).join(', ')}.`, 'info');

  // Datos del ticket simulados (editables)
  loadTicketData();
  const tdBiz = document.getElementById('td-business');
  const tdItems = document.getElementById('td-items');
  const tdTotal = document.getElementById('td-total');
  tdBiz.value = state.ticketData.business;
  tdItems.value = (state.ticketData.items || []).join('\n');
  tdTotal.value = state.ticketData.total;
  const syncTD = () => {
    state.ticketData = {
      business: tdBiz.value.trim() || 'PLICK',
      items: tdItems.value.split('\n').map((s) => s.trim()).filter(Boolean),
      total: tdTotal.value.trim(),
    };
    persistTicketData();
  };
  tdBiz.addEventListener('input', syncTD);
  tdItems.addEventListener('input', syncTD);
  tdTotal.addEventListener('input', syncTD);

  document.getElementById('btn-print-all').addEventListener('click', printAll);
  document.getElementById('btn-add-first').addEventListener('click', addPrinter);
  document.getElementById('btn-add').addEventListener('click', addPrinter);
  document.getElementById('btn-role-caja').addEventListener('click', () => assignRole('Caja', 'normal'));
  document.getElementById('btn-role-cocina').addEventListener('click', () => assignRole('Cocina', 'simplified'));
  document.getElementById('btn-role-other').addEventListener('click', () => {
    const v = prompt('Nombre de la impresora (ej. Barra, Mostrador):', 'Impresora');
    if (v && v.trim()) assignRole(v.trim(), 'normal');
  });
  document.getElementById('btn-assign-cancel').addEventListener('click', cancelAssign);
  document.getElementById('btn-confirm-all').addEventListener('click', confirmAll);
  document.getElementById('btn-auto-start').addEventListener('click', startAuto);
  document.getElementById('btn-auto-stop').addEventListener('click', stopAuto);
  document.getElementById('btn-disconnect-all').addEventListener('click', disconnectAll);
  document.getElementById('btn-reload').addEventListener('click', () => location.reload());
  document.getElementById('btn-forget-all').addEventListener('click', () => {
    forgetAll();
    log('Olvidé todas las impresoras (simula equipo nuevo).', 'warn');
    render();
  });

  render();
  autoReconnect(); // reconexión silenciosa al cargar (no usa requestDevice → no necesita gesto)
});
