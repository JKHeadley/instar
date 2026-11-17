/**
 * ProjectAppKeys — the per-machine key file for custom project apps
 * (docs/specs/project-apps-sandbox.md §3.2 "App keys" and §3.7 "The HMAC secret").
 *
 * One file per machine, `state/project-app-keys.json`, mode 0600, never in the journal, secret
 * sync or backups. It holds, per app, key GENERATIONS of three kinds:
 *   data    seals data chunks and the app's summary record
 *   source  seals source chunks and the agent's change notes
 *   hmac    the narrow per-app key's HMAC secret
 *
 * Destruction is permanent: a destroyed generation goes on a DENY-LIST and is refused on every
 * later store (a peer offering it back) and fetch (a peer asking for it). An erase WATERMARK per
 * app destroys every data generation ≤ N, including generations this machine never held, so an
 * older generation a returning machine offers later is covered too. A deleted app refuses every
 * kind.
 *
 * File I/O only, at the injected path; no network (the mesh `project-app-key-fetch` verb is wired
 * by the caller). Every write is atomic and owner-only.
 */

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { writeFileAtomicOwnerOnly } from '../identity/IdentityKeyFile.js';

export const APP_KEY_KINDS = ['data', 'source', 'hmac'] as const;
export type AppKeyKind = typeof APP_KEY_KINDS[number];

const APP_ID_RE = /^pa_[0-9a-f]{16}$/;
const isKind = (k: unknown): k is AppKeyKind => k === 'data' || k === 'source' || k === 'hmac';
const isGen = (g: unknown): g is number => typeof g === 'number' && Number.isInteger(g) && g >= 1 && g <= 1_000_000;

interface AppEntry {
  /** gen (as a string key) → base64 of 32 key bytes. */
  keys: Record<AppKeyKind, Record<string, string>>;
  /** Destroyed generations, per kind (the deny-list). */
  revoked: Record<AppKeyKind, number[]>;
  /** Every data generation ≤ this is destroyed (0 = none). */
  eraseWatermark: number;
  /** Delete <app>: every generation of every kind is refused. */
  deleted: boolean;
}

interface KeyFile { v: 1; apps: Record<string, AppEntry> }

export type PutResult = { ok: true } | { ok: false; reason: 'revoked' | 'conflict' | 'invalid' };

export class ProjectAppKeyError extends Error {}

export class ProjectAppKeyStore {
  private readonly filePath: string;
  private cache: KeyFile | null = null;

  constructor(opts: { filePath: string }) { this.filePath = opts.filePath; }

  private load(): KeyFile {
    if (this.cache) return this.cache;
    let raw: string;
    try { raw = fs.readFileSync(this.filePath, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { this.cache = { v: 1, apps: {} }; return this.cache; }
      throw err;
    }
    // An unreadable file is never treated as empty: starting over would mint new keys and leave
    // every saved document unreadable, and would forget the deny-list.
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ProjectAppKeyError('project app key file is not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || (parsed as KeyFile).v !== 1 || typeof (parsed as KeyFile).apps !== 'object') {
      throw new ProjectAppKeyError('project app key file has an unknown shape');
    }
    this.cache = parsed as KeyFile;
    return this.cache;
  }

  private save(f: KeyFile): void {
    writeFileAtomicOwnerOnly(this.filePath, JSON.stringify(f, null, 2) + '\n');
    this.cache = f;
  }

  private entry(f: KeyFile, appId: string, create: boolean): AppEntry | null {
    if (!APP_ID_RE.test(appId)) throw new ProjectAppKeyError('bad app id');
    let e = f.apps[appId];
    if (!e && create) {
      e = { keys: { data: {}, source: {}, hmac: {} }, revoked: { data: [], source: [], hmac: [] }, eraseWatermark: 0, deleted: false };
      f.apps[appId] = e;
    }
    return e ?? null;
  }

  /** Whether a generation is destroyed here (deny-list, erase watermark or a deleted app). */
  isRevoked(appId: string, kind: AppKeyKind, gen: number): boolean {
    const e = this.entry(this.load(), appId, false);
    if (!e) return false;
    return e.deleted || e.revoked[kind].includes(gen) || (kind === 'data' && gen <= e.eraseWatermark);
  }

  /** The generations held (not destroyed), ascending. */
  generations(appId: string, kind: AppKeyKind): number[] {
    const e = this.entry(this.load(), appId, false);
    if (!e || e.deleted) return [];
    return Object.keys(e.keys[kind]).map(Number).filter((g) => !this.isRevoked(appId, kind, g)).sort((a, b) => a - b);
  }

  /** The newest held generation, or null. */
  current(appId: string, kind: AppKeyKind): { gen: number; key: Buffer } | null {
    const gens = this.generations(appId, kind);
    if (!gens.length) return null;
    const gen = gens[gens.length - 1];
    return { gen, key: this.get(appId, kind, gen)! };
  }

  /** A held generation's key, or null (never a revoked one). Also the answer the fetch verb gives a peer. */
  get(appId: string, kind: AppKeyKind, gen: number): Buffer | null {
    if (!isKind(kind) || !isGen(gen)) return null;
    if (this.isRevoked(appId, kind, gen)) return null;
    const e = this.entry(this.load(), appId, false);
    const b64 = e?.keys[kind][String(gen)];
    return b64 ? Buffer.from(b64, 'base64') : null;
  }

  /**
   * Create the next generation (the lease holder only; the caller decides that). The new number is
   * above every generation ever held, revoked or covered by the watermark, so it is never reused.
   */
  create(appId: string, kind: AppKeyKind): { gen: number; key: Buffer } {
    if (!isKind(kind)) throw new ProjectAppKeyError('bad key kind');
    const f = this.load();
    const e = this.entry(f, appId, true)!;
    if (e.deleted) throw new ProjectAppKeyError('app deleted');
    const used = [...Object.keys(e.keys[kind]).map(Number), ...e.revoked[kind], kind === 'data' ? e.eraseWatermark : 0];
    const gen = Math.max(0, ...used) + 1;
    const key = randomBytes(32);
    e.keys[kind][String(gen)] = key.toString('base64');
    this.save(f);
    return { gen, key };
  }

  /** Store a generation fetched from (or offered by) a peer. A revoked generation is refused. */
  put(appId: string, kind: AppKeyKind, gen: number, key: Buffer): PutResult {
    if (!isKind(kind) || !isGen(gen) || !Buffer.isBuffer(key) || key.length !== 32) return { ok: false, reason: 'invalid' };
    if (this.isRevoked(appId, kind, gen)) return { ok: false, reason: 'revoked' };
    const f = this.load();
    const e = this.entry(f, appId, true)!;
    const have = e.keys[kind][String(gen)];
    if (have !== undefined) return have === key.toString('base64') ? { ok: true } : { ok: false, reason: 'conflict' };
    e.keys[kind][String(gen)] = key.toString('base64');
    this.save(f);
    return { ok: true };
  }

  /** Destroy one generation and deny it from now on. Idempotent. */
  destroy(appId: string, kind: AppKeyKind, gen: number): void {
    if (!isKind(kind) || !isGen(gen)) throw new ProjectAppKeyError('bad key kind or generation');
    const f = this.load();
    const e = this.entry(f, appId, true)!;
    delete e.keys[kind][String(gen)];
    if (!e.revoked[kind].includes(gen)) e.revoked[kind].push(gen);
    this.save(f);
  }

  /** Erase <app>'s saved data: destroy every data generation ≤ watermark. The watermark only rises. */
  eraseData(appId: string, watermark: number): number[] {
    if (!isGen(watermark)) throw new ProjectAppKeyError('bad watermark');
    const f = this.load();
    const e = this.entry(f, appId, true)!;
    const gone = Object.keys(e.keys.data).map(Number).filter((g) => g <= watermark);
    for (const g of gone) delete e.keys.data[String(g)];
    e.eraseWatermark = Math.max(e.eraseWatermark, watermark);
    this.save(f);
    return gone.sort((a, b) => a - b);
  }

  /** Delete <app>: destroy every key of every kind; nothing for this app is stored or handed out again. */
  destroyApp(appId: string): void {
    const f = this.load();
    const e = this.entry(f, appId, true)!;
    for (const k of APP_KEY_KINDS) {
      for (const g of Object.keys(e.keys[k]).map(Number)) if (!e.revoked[k].includes(g)) e.revoked[k].push(g);
      e.keys[k] = {};
    }
    e.deleted = true;
    this.save(f);
  }

  /**
   * Apply folded revocations (revoke records and erase/delete approves) to this machine's file.
   * Each entry is applied on its own: one bad entry (a watermark out of range, an unknown kind)
   * is reported in `failed` and never stops the rest from being destroyed.
   */
  applyRevocations(r: { revoked?: Array<{ appId: string; keyKind: AppKeyKind; gen: number }>; eraseWatermarks?: Record<string, number>; deletedApps?: Iterable<string> }): { failed: Array<{ what: string; appId: string; error: string }> } {
    const failed: Array<{ what: string; appId: string; error: string }> = [];
    const each = (what: string, appId: string, fn: () => void) => {
      try { fn(); } catch (err) { failed.push({ what, appId: String(appId), error: (err as Error)?.message ?? String(err) }); }
    };
    for (const appId of r.deletedApps ?? []) each('delete-app', appId, () => { if (!this.entry(this.load(), appId, false)?.deleted) this.destroyApp(appId); });
    for (const [appId, w] of Object.entries(r.eraseWatermarks ?? {})) each('erase-data', appId, () => {
      const e = this.entry(this.load(), appId, false);
      if (!e || e.eraseWatermark < w || Object.keys(e.keys.data).some((g) => Number(g) <= w)) this.eraseData(appId, w);
    });
    for (const x of r.revoked ?? []) each(`revoke:${x.keyKind}:${x.gen}`, x.appId, () => {
      const e = this.entry(this.load(), x.appId, false);
      if (!e || !e.revoked[x.keyKind].includes(x.gen) || e.keys[x.keyKind][String(x.gen)] !== undefined) this.destroy(x.appId, x.keyKind, x.gen);
    });
    return { failed };
  }
}
