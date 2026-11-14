/**
 * Instar Documents — salted, content-addressed text blobs (spec §3.4 "Content blobs", §5.3).
 *
 * Every piece of text lives in a blob `{ salt, text }` keyed by `sha256(salt ‖ text)`. The salt
 * lives only inside the blob, never in a row or a signed payload, so once a blob is deleted (purge,
 * prune) its hash can't be checked against guesses. Version chunks use the document's one secret
 * salt, so an unchanged paragraph chunk has the same id in every version and is stored once.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { FORMAT, isHash } from './rows.js';

export interface Blob { salt: string; text: string }

export const newSalt = (): string => crypto.randomBytes(16).toString('hex');

export function blobHash(salt: string, text: string): string {
  return crypto.createHash('sha256').update(salt, 'utf8').update('\u0000', 'utf8').update(text, 'utf8').digest('hex');
}

/** The serialized size the format bound is measured on. */
export const blobBytes = (b: Blob): number => Buffer.byteLength(JSON.stringify(b), 'utf8');

export type BlobCheck = { ok: true; hash: string } | { ok: false; reason: 'too-large' | 'malformed' | 'hash-mismatch' };

/** Validate a blob received from anywhere, optionally against the hash a row names. */
export function checkBlob(input: unknown, expectedHash?: string): BlobCheck {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'malformed' };
  const b = input as Record<string, unknown>;
  if (typeof b.salt !== 'string' || !/^[0-9a-f]{32}$/.test(b.salt) || typeof b.text !== 'string') return { ok: false, reason: 'malformed' };
  if (blobBytes(b as unknown as Blob) > FORMAT.blobBytes) return { ok: false, reason: 'too-large' };
  const hash = blobHash(b.salt, b.text);
  if (expectedHash !== undefined && hash !== expectedHash) return { ok: false, reason: 'hash-mismatch' };
  return { ok: true, hash };
}

/** A multi-blob body's hash: sha256 of the ordered list of its blobs' hashes (§3.6). */
export function listHash(hashes: ReadonlyArray<string>): string {
  return crypto.createHash('sha256').update(hashes.join('\n'), 'utf8').digest('hex');
}

/** Split text into blobs under one salt, each within the format bound. Short text is one blob. */
export function textToBlobs(text: string, salt: string): Blob[] {
  const out: Blob[] = [];
  let rest = text;
  // Leave room for the JSON envelope and escaping: measure on the serialized blob itself.
  while (rest.length > 0) {
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (blobBytes({ salt, text: safeSlice(rest, mid) }) <= FORMAT.blobBytes) lo = mid; else hi = mid - 1;
    }
    const piece = safeSlice(rest, lo);
    out.push({ salt, text: piece });
    rest = rest.slice(piece.length);
  }
  if (out.length === 0) out.push({ salt, text: '' });
  return out;
}

/** Slice without splitting a surrogate pair. */
function safeSlice(s: string, n: number): string {
  if (n >= s.length) return s;
  const code = s.charCodeAt(n - 1);
  return code >= 0xd800 && code <= 0xdbff ? s.slice(0, n - 1) : s.slice(0, n);
}

/**
 * On-disk blob store: `<root>/<docKey>/<hash>.json`, files 0600, directories 0700. A document's
 * blobs are deleted together on purge; the purged set is remembered so blobs are refused again.
 */
export class BlobStore {
  constructor(private readonly root: string) {}

  private dirFor(docKey: string): string { return path.join(this.root, docKey); }

  put(docKey: string, blob: Blob): string {
    const check = checkBlob(blob);
    if (!check.ok) throw new Error(`blob refused: ${check.reason}`);
    const dir = this.dirFor(docKey);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${check.hash}.json`);
    if (!fs.existsSync(file)) SafeFsExecutor.atomicWriteFileSync(file, JSON.stringify(blob), { operation: 'documents.blob.put', mode: 0o600 });
    return check.hash;
  }

  get(docKey: string, hash: string): Blob | null {
    if (!isHash(hash)) return null;
    try {
      const b = JSON.parse(fs.readFileSync(path.join(this.dirFor(docKey), `${hash}.json`), 'utf8')) as Blob;
      return checkBlob(b, hash).ok ? b : null;
    } catch { return null; } // @silent-fallback-ok — a missing blob reads as "not held"; health reports chunk gaps
  }

  has(docKey: string, hash: string): boolean {
    return isHash(hash) && fs.existsSync(path.join(this.dirFor(docKey), `${hash}.json`));
  }

  /** Delete the named blobs of one document (prune), or all of them (purge). */
  delete(docKey: string, hashes?: ReadonlyArray<string>): number {
    const dir = this.dirFor(docKey);
    if (!fs.existsSync(dir)) return 0;
    const targets = hashes ? hashes.filter(isHash).map((h) => `${h}.json`) : fs.readdirSync(dir);
    let n = 0;
    for (const f of targets) {
      try { SafeFsExecutor.safeRmSync(path.join(dir, f), { force: true, operation: 'documents.blob.delete' }); n++; } catch { /* @silent-fallback-ok — an already-gone blob is the goal state */ }
    }
    if (!hashes) { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'documents.blob.purge' }); } catch { /* @silent-fallback-ok — same */ } }
    return n;
  }
}
