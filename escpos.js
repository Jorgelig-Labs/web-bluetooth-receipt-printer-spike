// escpos.js — encoder ESC/POS mínimo y autocontenido (sin dependencias de red).
// Suficiente para un ticket de prueba: init, texto, alineación, negrita, doble alto,
// código de barras / QR opcionales, feed y corte. Genera un Uint8Array de bytes crudos.
//
// Para producción se recomienda @point-of-sale/receipt-printer-encoder (NielsLeenheer).
// El spike también puede cargar esa lib vía CDN (ver buildTicketWithNielsEncoder abajo)
// para comparar la salida; si el CDN falla, este encoder casero es el fallback.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

// --- Helpers de bytes -------------------------------------------------------
function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Codifica texto. Las térmicas chinas suelen ser CP437/Latin; usamos latin1-ish:
// caracteres no-ASCII se transliteran a '?' para evitar basura en pantalla.
function text(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out[i] = code < 0x80 ? code : 0x3f; // '?'
  }
  return out;
}

// --- Builder fluido ---------------------------------------------------------
export class EscPos {
  constructor() {
    this.chunks = [];
    // ESC @ -> inicializar / reset
    this.chunks.push(new Uint8Array([ESC, 0x40]));
  }

  raw(bytes) {
    this.chunks.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return this;
  }

  // align: 0=izq, 1=centro, 2=der  (ESC a n)
  align(n) {
    return this.raw([ESC, 0x61, n]);
  }

  // bold on/off (ESC E n)
  bold(on) {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  // tamaño: 0=normal, 1=doble alto, 2=doble ancho, 3=doble ambos (GS ! n)
  size(mode) {
    const map = { 0: 0x00, 1: 0x01, 2: 0x10, 3: 0x11 };
    return this.raw([GS, 0x21, map[mode] ?? 0x00]);
  }

  line(str = '') {
    this.raw(text(str));
    this.raw([LF]);
    return this;
  }

  feed(n = 1) {
    return this.raw(new Uint8Array(n).fill(LF));
  }

  // Corte total (GS V 0). Muchas térmicas de bolsillo lo ignoran sin error.
  cut() {
    return this.raw([GS, 0x56, 0x00]);
  }

  encode() {
    return concat(this.chunks);
  }
}

// Ticket de prueba estándar del spike. folio opcional.
export function buildTestTicket(folio) {
  const f = folio ?? Math.floor(1000 + Math.random() * 9000);
  return new EscPos()
    .align(1)
    .size(3)
    .bold(true)
    .line('PLICK')
    .size(0)
    .bold(false)
    .line('--- Ticket de prueba ---')
    .feed(1)
    .align(0)
    .line('Hola Plick')
    .line('Folio: #' + f)
    .line('Web Bluetooth spike OK')
    .line('Ancho 58mm / ESC-POS')
    .feed(1)
    .align(1)
    .line('* * *')
    .feed(3)
    .cut()
    .encode();
}

// Comparación opcional con el encoder de NielsLeenheer (vía CDN ESM).
// Devuelve Uint8Array o lanza si el CDN no está disponible.
export async function buildTicketWithNielsEncoder(folio) {
  const mod = await import(
    'https://esm.sh/@point-of-sale/receipt-printer-encoder@3'
  );
  const ReceiptPrinterEncoder = mod.default;
  const encoder = new ReceiptPrinterEncoder({ printerModel: 'pos-5890' });
  const f = folio ?? Math.floor(1000 + Math.random() * 9000);
  return encoder
    .initialize()
    .align('center')
    .bold(true)
    .size(2)
    .line('PLICK')
    .size(1)
    .bold(false)
    .line('Ticket de prueba (Niels)')
    .newline()
    .align('left')
    .line('Hola Plick')
    .line('Folio: #' + f)
    .newline(3)
    .cut()
    .encode();
}
