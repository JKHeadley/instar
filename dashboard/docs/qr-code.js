// Instar Documents — a small QR encoder for the "link this computer" code (spec §3.6a).
//
// ISO/IEC 18004, byte mode (UTF-8), error-correction levels L/M/Q/H, versions 1–20 (the smallest
// that fits), all eight masks scored with the standard penalty rules. No dependencies and no DOM
// except qrSvg, which builds the picture with createElementNS (the page's CSP allows no markup
// parsing). Coordinates: matrix[y][x], y = row, x = column; true = dark.

const EC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_EC_BITS = [1, 0, 3, 2]; // L, M, Q, H as written in the format information
const MAX_VERSION = 20;

// Per version 1–20 (index 0 unused), per level L/M/Q/H: EC codewords per block, and number of blocks.
const EC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28],
];
const EC_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25],
];

// ── GF(256) and Reed–Solomon (polynomial 0x11D) ───────────────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** The generator polynomial of the given degree, highest coefficient (1) dropped. */
function rsGenerator(degree) {
  const g = new Uint8Array(degree); g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { g[j] = gfMul(g[j], root); if (j + 1 < degree) g[j] ^= g[j + 1]; }
    root = gfMul(root, 2);
  }
  return g;
}

/** The `degree` error-correction codewords for `data` (an array of bytes). */
export function rsEncode(data, degree) {
  const g = rsGenerator(degree);
  const out = new Uint8Array(degree);
  for (const b of data) {
    const f = b ^ out[0];
    out.copyWithin(0, 1); out[degree - 1] = 0;
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(g[i], f);
  }
  return Array.from(out);
}

// ── format and version information ───────────────────────────────────────────────────────────

/** The 15-bit format information (BCH(15,5), masked with 0x5412) for a level and a mask. */
export function formatBits(ecl, mask) {
  const data = (FORMAT_EC_BITS[EC_LEVELS[ecl]] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** The 18-bit version information (BCH(18,6)) for versions 7 and up. */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

// ── capacity ─────────────────────────────────────────────────────────────────────────────────

function rawModules(v) {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) { const a = Math.floor(v / 7) + 2; n -= (25 * a - 10) * a - 55; if (v >= 7) n -= 36; }
  return n;
}
const dataCodewords = (v, e) => Math.floor(rawModules(v) / 8) - EC_PER_BLOCK[e][v] * EC_BLOCKS[e][v];

export function alignmentPositions(v) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2;
  const step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = v * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ── encoding ─────────────────────────────────────────────────────────────────────────────────

/** Data codewords (mode, count, bytes, terminator, padding) and the version chosen. */
function encodeData(bytes, e) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const capBits = dataCodewords(v, e) * 8;
    if (4 + countBits + bytes.length * 8 > capBits) continue;
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4); put(bytes.length, countBits);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, capBits - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xec; out.length < capBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
    return { version: v, codewords: out };
  }
  throw new Error('qr-too-long');
}

/** Splits into blocks, adds each block's EC codewords and interleaves them. */
function withErrorCorrection(data, v, e) {
  const nBlocks = EC_BLOCKS[e][v];
  const ecLen = EC_PER_BLOCK[e][v];
  const raw = Math.floor(rawModules(v) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks) - ecLen; // data codewords in a short block
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const d = data.slice(k, k + shortLen + (i < nShort ? 0 : 1));
    k += d.length;
    blocks.push({ d, ec: rsEncode(d, ecLen) });
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ── the matrix ────────────────────────────────────────────────────────────────────────────────

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function grid(size) { return Array.from({ length: size }, () => new Array(size).fill(false)); }

/** Finder, separator, timing and alignment patterns, the dark module, and reserved areas. */
function functionPatterns(v) {
  const size = v * 4 + 17;
  const m = grid(size);
  const fn = grid(size);
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignmentPositions(v);
  const last = al.length - 1;
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(m, fn, 0); // reserves the format areas (overwritten per mask) and sets the dark module
  if (v >= 7) {
    const bits = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }
  return { size, m, fn };
}

function drawFormat(m, fn, bits) {
  const size = m.length;
  const set = (x, y, i) => { m[y][x] = ((bits >>> i) & 1) === 1; fn[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, i);
  set(8, 7, 6); set(8, 8, 7); set(7, 8, 8);
  for (let i = 9; i < 15; i++) set(14 - i, 8, i);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, i);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, i);
  m[size - 8][8] = true; fn[size - 8][8] = true; // the dark module
}

function placeData(m, fn, codewords) {
  const size = m.length;
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fn[y][x]) continue;
        if (i < total) { m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }
}

function applyMask(m, fn, mask) {
  const f = MASKS[mask];
  const out = m.map((row) => row.slice());
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (!fn[y][x] && f(x, y)) out[y][x] = !out[y][x];
  return out;
}

/** The ISO 18004 penalty score (rules N1–N4) of a finished matrix. */
export function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) { lines.push(m[i]); lines.push(m.map((row) => row[i])); }
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = P1.slice().reverse();
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    for (let i = 0; i + 11 <= size; i++) {
      let a = true; let b = true;
      for (let k = 0; k < 11 && (a || b); k++) { if (line[i + k] !== P1[k]) a = false; if (line[i + k] !== P2[k]) b = false; }
      if (a) score += 40;
      if (b) score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (x + 1 < size && y + 1 < size) { const c = m[y][x]; if (m[y][x + 1] === c && m[y + 1][x] === c && m[y + 1][x + 1] === c) score += 3; }
  }
  score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
  return score;
}

/**
 * The QR matrix for `text` (UTF-8, byte mode): boolean[][] with true = dark, no quiet zone.
 * `opts.mask` forces a mask (0–7); otherwise the lowest-penalty one is used.
 */
export function qrMatrix(text, ecl = 'M', opts = {}) {
  const e = EC_LEVELS[ecl];
  if (e === undefined) throw new Error('qr-bad-level');
  const { version, codewords } = encodeData(new TextEncoder().encode(String(text)), e);
  const all = withErrorCorrection(codewords, version, e);
  const { m, fn } = functionPatterns(version);
  placeData(m, fn, all);
  const masks = Number.isInteger(opts.mask) ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  let best = null; let bestScore = Infinity;
  for (const mask of masks) {
    const out = applyMask(m, fn, mask);
    drawFormat(out, fn, formatBits(ecl, mask));
    const s = masks.length === 1 ? 0 : penalty(out);
    if (s < bestScore) { best = out; bestScore = s; }
  }
  return best;
}

/**
 * An <svg> picture of the code, built with createElementNS: a white background and one path of
 * dark modules. Options: scale (px per module), quiet (modules of margin), label (aria-label), ecl.
 */
export function qrSvg(doc, text, { scale = 6, quiet = 4, label = 'QR code', ecl = 'M' } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const m = qrMatrix(text, ecl);
  const n = m.length + quiet * 2;
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', String(n * scale));
  svg.setAttribute('height', String(n * scale));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = doc.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(n)); bg.setAttribute('height', String(n)); bg.setAttribute('fill', '#ffffff');
  const d = [];
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) d.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
  const path = doc.createElementNS(NS, 'path');
  path.setAttribute('d', d.join(''));
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}
