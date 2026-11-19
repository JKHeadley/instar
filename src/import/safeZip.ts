/**
 * Reads named JSON entries out of a Claude or ChatGPT export zip, safely
 * (docs/specs/import-from-claude-chatgpt.md §E). No dependency: it walks the zip's central directory
 * itself so every limit is enforced here, before a byte is inflated:
 *   - the zip is at most 2 GB, and zip64 is refused (nothing under 2 GB needs it);
 *   - entries named with `..`, an absolute path or a backslash, a symlink, or a duplicate name are refused;
 *   - the local header must agree with the central directory (name, method, sizes);
 *   - unpacked size is capped per entry and in total, and the compression ratio at 100:1.
 * Only the entries the caller names are read, and they are streamed, never held whole.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

export const MAX_ZIP_BYTES = 2 * 1024 ** 3;
export const MAX_TOTAL_UNPACKED = 4 * 1024 ** 3;
export const MAX_RATIO = 100;

export class ZipRefused extends Error {
  constructor(message: string) { super(message); this.name = 'ZipRefused'; }
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const U32_MAX = 0xffffffff;

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, offset + got);
    if (n === 0) break;
    got += n;
  }
  if (got !== length) throw new ZipRefused('The file ends early; it may be damaged or still downloading.');
  return buf;
}

function badName(name: string): boolean {
  return name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || name.includes('\0');
}

/** Lists the zip's entries after checking the whole directory. Throws ZipRefused with plain words. */
export function listEntries(zipPath: string): ZipEntry[] {
  const size = fs.statSync(zipPath).size;
  if (size > MAX_ZIP_BYTES) throw new ZipRefused('This file is bigger than 2 GB, the most the importer reads.');
  if (size < 22) throw new ZipRefused('This is not a zip file.');
  const fd = fs.openSync(zipPath, 'r');
  try {
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    // The real end record is the one whose comment runs exactly to the end of the file; a comment
    // containing the signature can't fool the search.
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipRefused('This is not a zip file.');
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw new ZipRefused('This zip is split across several files; export it again as one file.');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX) {
      throw new ZipRefused('This zip uses a large-file format (zip64) the importer does not read.');
    }
    if (cdOffset + cdSize > size) throw new ZipRefused('This zip is damaged (its directory points past the end).');
    const cd = readAt(fd, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let total = 0;
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN) throw new ZipRefused('This zip is damaged (its directory is unreadable).');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const extAttr = cd.readUInt32LE(p + 38);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
      p += 46 + nameLen + extraLen + commentLen;
      if (compressedSize === U32_MAX || usize === U32_MAX || localHeaderOffset === U32_MAX) {
        throw new ZipRefused('This zip uses a large-file format (zip64) the importer does not read.');
      }
      if (flags & 0x1) throw new ZipRefused('This zip is password-protected; export it again without a password.');
      if (badName(name)) throw new ZipRefused(`This zip contains an unsafe file name (${JSON.stringify(name.slice(0, 80))}).`);
      if ((madeBy >> 8) === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000) {
        throw new ZipRefused(`This zip contains a link (${JSON.stringify(name.slice(0, 80))}), which the importer refuses.`);
      }
      if (seen.has(name)) throw new ZipRefused(`This zip names the same file twice (${JSON.stringify(name.slice(0, 80))}).`);
      seen.add(name);
      if (name.endsWith('/')) continue;
      if (method !== 0 && method !== 8) throw new ZipRefused(`This zip uses a compression the importer does not read (${JSON.stringify(name.slice(0, 80))}).`);
      if (compressedSize > 0 && usize / compressedSize > MAX_RATIO) {
        throw new ZipRefused(`A file in this zip unpacks to more than ${MAX_RATIO} times its size (${JSON.stringify(name.slice(0, 80))}).`);
      }
      total += usize;
      if (total > MAX_TOTAL_UNPACKED) throw new ZipRefused('This zip unpacks to more than 4 GB, the most the importer reads.');
      if (localHeaderOffset + 30 > size) throw new ZipRefused('This zip is damaged (an entry points past the end).');
      entries.push({ name, method, compressedSize, size: usize, localHeaderOffset });
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** The byte offset where an entry's data starts, after checking its local header agrees. */
function dataOffset(fd: number, e: ZipEntry, zipSize: number): number {
  const h = readAt(fd, e.localHeaderOffset, 30);
  if (h.readUInt32LE(0) !== LOC) throw new ZipRefused('This zip is damaged (an entry header is missing).');
  const flags = h.readUInt16LE(6);
  const method = h.readUInt16LE(8);
  const nameLen = h.readUInt16LE(26);
  const extraLen = h.readUInt16LE(28);
  const name = readAt(fd, e.localHeaderOffset + 30, nameLen).toString('utf-8');
  if (name !== e.name || method !== e.method) throw new ZipRefused('This zip is damaged (its directory and its contents disagree).');
  // With a data descriptor (flag 3) the local sizes are zero; otherwise they must match the directory.
  if (!(flags & 0x8)) {
    const cs = h.readUInt32LE(18);
    const us = h.readUInt32LE(22);
    if (cs !== e.compressedSize || us !== e.size) throw new ZipRefused('This zip is damaged (its directory and its contents disagree).');
  }
  const start = e.localHeaderOffset + 30 + nameLen + extraLen;
  if (start + e.compressedSize > zipSize) throw new ZipRefused('This zip is damaged (an entry runs past the end).');
  return start;
}

/**
 * A stream of one entry's unpacked bytes. It stops with ZipRefused if the data unpacks to more than
 * the directory declared, so a lying header can't become a zip bomb.
 */
export function openEntry(zipPath: string, e: ZipEntry): Readable {
  const size = fs.statSync(zipPath).size;
  const fd = fs.openSync(zipPath, 'r');
  let start: number;
  try { start = dataOffset(fd, e, size); } finally { fs.closeSync(fd); }
  if (e.compressedSize === 0) return Readable.from([]);
  const raw = fs.createReadStream(zipPath, { start, end: start + e.compressedSize - 1, highWaterMark: 1 << 20 });
  const inflated: Readable = e.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
  let seen = 0;
  const limit = e.size;
  const out = new Readable({
    read() { inflated.resume(); },
    // A reader that stops early (or a dropped request) closes the file and the inflater too.
    destroy(err, cb) { inflated.destroy(); raw.destroy(); cb(err); },
  });
  inflated.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > limit) {
      inflated.destroy();
      raw.destroy();
      out.destroy(new ZipRefused(`A file in this zip unpacks to more than it says (${JSON.stringify(e.name.slice(0, 80))}).`));
      return;
    }
    if (!out.push(chunk)) inflated.pause();
  });
  inflated.on('end', () => out.push(null));
  inflated.on('error', (err) => out.destroy(err instanceof ZipRefused ? err : new ZipRefused(`A file in this zip could not be unpacked (${JSON.stringify(e.name.slice(0, 80))}).`)));
  raw.on('error', (err) => out.destroy(err));
  return out;
}

/** Finds an entry by its base name at the top level or one folder down (exports vary). */
export function findEntry(entries: ZipEntry[], baseName: string): ZipEntry | undefined {
  return entries.find((e) => e.name === baseName) ?? entries.find((e) => e.name.split('/').length === 2 && e.name.endsWith(`/${baseName}`));
}
