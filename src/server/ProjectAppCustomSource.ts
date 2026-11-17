/**
 * ProjectAppCustomSource — the REAL `CustomAppSource` for custom project apps
 * (docs/specs/project-apps-sandbox.md §3.1-3.5, §3.7), joining:
 *
 *   - the journal union of `project-app-record` (app definitions, version cards, answers, summaries,
 *     key revocations) and `project-app-blob` (encrypted chunks + revisions), own + peer streams,
 *     with this machine's unflushed writes held in memory until the stream reader carries them;
 *   - the per-machine key file (ProjectAppKeyStore, `state/project-app-keys.json`);
 *   - the on-disk ciphertext store `state/project-app-blobs/<appId>/<kind>/<keyGen>/<sha>`
 *     (12-byte nonce ‖ ciphertext ‖ tag), written on emit and read before the journal;
 *   - the Work Board's replicated cards: the owner's phone-presence approve on a server-written
 *     version card is the ONLY thing that makes a version run (foldServedVersion).
 *
 * Writes (app creation, source and data revisions, summaries, version cards) happen ONLY on the
 * lease holder. Elsewhere a write answers 409 `not-lease-holder` naming the holder.
 *
 * NOT built here (stated, never faked): the server-side mesh forward of a write to the holder, the
 * `project-app-key-fetch` mesh verb (a non-holder without the key reports the version as `copying`),
 * the lease-epoch timeline for fenced late writes, the catch-up barrier after a restart, and the
 * erase / delete / enable / allow-again / budget cards (the folds already honour them), and a phone
 * Decline → reject. All tracked as stage 2 of the spec (CMT-1882, review 2026-11-24). Until then app
 * keys never leave the lease holder: another machine reports `copying` (fails safe, nothing leaks)
 * and an erase destroys the only copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { HlcTimestamp } from '../core/HybridLogicalClock.js';
import type { CustomAppSource, CustomAppMeta, ServedVersion, SourceWriteResult } from './ProjectAppSandbox.js';
import { ProjectAppKeyStore, type AppKeyKind } from '../core/ProjectAppKeys.js';
import {
  type UnionEntry, type BlobKind, type ChunkFields, type Revision,
  PROJECT_APP_BLOB_STORE_KEY, chunkKey, prepareDocument, openChunk, reassemble, docHashes, decodeDocument, validateChunk,
  foldRevisions, isComplete, headRevision, newestCompleteRevision, checkWriteBase, checkWriteSize, admitBudget, budgetUsage,
  buildChunk, buildRevision, serializedLineBytes, sealText, openText, noteAad, summaryAad, utcDay, NOTE_MAX_CHARS, DAILY_BUDGET_DEFAULT,
} from '../core/ProjectAppBlobStore.js';
import {
  foldServedVersion, foldRevokedKeys, foldSummary, foldAppDefs, matchApprovals, buildAppDef, buildVersionCard, buildSummary,
  versionCardId, versionCardSupportLine, appDefKey, versionCardKey, summaryKey, CARD_PURPOSES, APP_TITLE_MAX,
  type AppDef, type SourceCandidate,
} from '../core/ProjectAppCustomFold.js';
import { PROJECT_APP_STORE_KEY } from '../core/ProjectAppStore.js';
import type { WorkBoardService } from '../core/WorkBoardService.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';


type Build = (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null;
type Emit = (recordKey: string, build: Build) => { outcome: string };

export const MAX_CUSTOM_APPS_DEFAULT = 10;
/**
 * The key-file slot that holds the agent-wide narrow-key HMAC secret (kind `hmac`, §3.7). The key file
 * is per app id; this reserved id is never minted for an app.
 */
export const HMAC_SLOT_APP_ID = 'pa_0000000000000000';
const written = (o: string) => o === 'emitted' || o === 'accepted' || o === 'unconfirmed';

// ── the automated version check (§3.5): a signal, never a gate ──────────────

const LONG_LINE = 5000;
const BASE64_BLOB = 50 * 1024;

/**
 * Plain-word findings on a new source version. Names patterns only, never quotes the code, and
 * never blocks: the owner reads them on the card and decides (Signal vs Authority).
 */
export function checkAppVersion(html: string): string[] {
  const out: string[] = [];
  const urls = html.match(/\b(?:https?|wss?):\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)?.filter((u) => !/^https?:\/\/www\.w3\.org$/i.test(u)) ?? [];
  if (urls.length) out.push(`This version mentions ${urls.length === 1 ? 'an outside web address' : `${urls.length} outside web addresses`}. The frame blocks outside requests, but ask your agent why they are there.`);
  if (/\bRTCPeerConnection\b|\bwebkitRTCPeerConnection\b/.test(html)) out.push('This version opens a direct peer-to-peer connection (WebRTC), which can send data around the frame\'s limits.');
  const passwordInput = /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html);
  const pinField = /\b(?:placeholder|name|id|aria-label|autocomplete)\s*=\s*["'][^"']*\b(?:password|passcode|pin|one-time-code|security code)\b/i.test(html)
    || /<label\b[^>]*>[^<]*\b(?:password|passcode|PIN)\b/i.test(html);
  if (passwordInput || pinField) out.push('This version asks for a password, PIN or code. Anything typed into it goes to your agent.');
  if (/\beval\s*\(/.test(html) || /\bFunction\s*\(/.test(html)) out.push('This version runs code it builds from text (eval or Function), which makes it hard to know what it does.');
  if (html.split('\n').some((l) => l.length > LONG_LINE)) out.push('This version has very long single lines (packed or minified code), which is hard to review.');
  let run = 0; let longest = 0;
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    const b64 = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;
    run = b64 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  if (longest > BASE64_BLOB) out.push('This version carries a large embedded blob of encoded data (over 50 KB).');
  return out;
}

/** The longest change note shown on a version card (the full note stays sealed on the revision). */
export const CARD_NOTE_MAX = 500;

/**
 * The agent's change note as the card shows it: every run of whitespace, newlines and control
 * characters collapsed to one space, capped at CARD_NOTE_MAX characters.
 */
export function cardNoteText(note: string): string {
  const flat = note.replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return flat.length > CARD_NOTE_MAX ? `${flat.slice(0, CARD_NOTE_MAX)}…` : flat;
}

/**
 * The Work Board's phone-only guard for custom-app version cards. Fails CLOSED: when the fold
 * cannot be read, the card is treated as phone-only (an approve from a weaker surface is refused
 * rather than let through).
 */
export function isPhoneOnlyCard(source: Pick<ProjectAppCustomSource, 'isVersionCard'> | null | undefined, cardId: string): boolean {
  if (!source) return false;
  try { return source.isVersionCard(cardId) === true; } catch { return true; } // @silent-fallback-ok — fail closed: an unreadable fold keeps the card phone-only
}

// ── the spec-process check (§3.4 "Spec process"): a process signal on create/offer ──

export type SpecCheck = { ok: true; specPath: string } | { ok: false; error: 'app-spec-not-converged' | 'bad-spec-path'; detail: string };

/**
 * `specPath` must resolve (realpath) inside `<projectDir>/docs/specs/` or `<projectDir>/.instar/specs/`
 * and its frontmatter must carry `review-convergence` and `review-report`.
 */
export function checkSpecConverged(projectDir: string, specPath: unknown): SpecCheck {
  if (typeof specPath !== 'string' || !specPath || specPath.length > 300 || !specPath.endsWith('.md')) return { ok: false, error: 'bad-spec-path', detail: 'specPath names the app\'s spec under docs/specs/ or .instar/specs/ (a .md file).' };
  let real: string; let root: string;
  try {
    root = fs.realpathSync(projectDir);
    real = fs.realpathSync(path.resolve(projectDir, specPath));
  } catch { return { ok: false, error: 'app-spec-not-converged', detail: 'The spec file does not exist.' }; } // @silent-fallback-ok — a missing spec is the refusal itself
  const rel = path.relative(root, real).split(path.sep).join('/');
  if (!(rel.startsWith('docs/specs/') || rel.startsWith('.instar/specs/')) || rel.includes('..')) return { ok: false, error: 'bad-spec-path', detail: 'The spec must be under docs/specs/ or .instar/specs/.' };
  let text = '';
  try { text = fs.readFileSync(real, 'utf8'); } catch { return { ok: false, error: 'app-spec-not-converged', detail: 'The spec file could not be read.' }; } // @silent-fallback-ok — unreadable is not converged
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = m ? m[1] : '';
  const has = (k: string) => new RegExp(`^${k}:\\s*\\S`, 'm').test(fm);
  if (!has('review-convergence') || !has('review-report')) return { ok: false, error: 'app-spec-not-converged', detail: 'The app\'s spec has not been through spec-converge: its frontmatter needs review-convergence and review-report.' };
  return { ok: true, specPath: rel };
}

// ── deps ────────────────────────────────────────────────────────────────────

export interface ProjectAppCustomSourceDeps {
  machineId: string;
  /** <agent>/.instar — the key file and the disk blob store live under its `state/`. */
  stateDir: string;
  /** The agent's project dir (spec paths are confined under it). */
  projectDir: string;
  emitRecord: Emit;
  emitBlob: Emit;
  /** Every `project-app-record` record this machine holds (own + peers). */
  loadRecords: () => UnionEntry[];
  /** Every `project-app-blob` record this machine holds (own + peers). */
  loadBlobs: () => UnionEntry[];
  /** The Work Board's records (its own replicated cards), or [] when it is off. */
  workBoardUnion: () => UnionEntry[];
  workBoard: () => WorkBoardService | null;
  /** Create the card's conversation (the Work Board runtime's ensureConversation). */
  ensureCardConversation?: (cardId: string) => void;
  /** The owner person key the Work Board already uses. */
  ownerPersonKey: () => string | null;
  holdsLease: () => boolean;
  leaseHolder: () => string | null;
  leaseEpoch: () => number;
  /** The bound Chief of Staff projects (conversation key + title), null when it is off. */
  projects: () => Array<{ conversationKey: string; title: string }> | null;
  /** One message in the project conversation (a version card first opened). */
  notifyProject?: (conversationKey: string, text: string) => Promise<void> | void;
  keyStore?: ProjectAppKeyStore;
  limits?: { maxApps?: number; sourceBytes?: number; dataBytes?: number; dailyBudget?: number };
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export type Refusal = { ok: false; status: number; error: string; detail?: string; [k: string]: unknown };
const refuse = (status: number, error: string, detail?: string, extra: Record<string, unknown> = {}): Refusal => ({ ok: false, status, error, ...(detail ? { detail } : {}), ...extra });

export interface SourceWriteOutcome {
  ok: true; revision: string; contentSha: string; bytes: number; findings: string[];
  card: { state: 'opened' | 'rewritten' | 'none'; cardId?: string; reason?: string };
}

interface Indexed {
  records: UnionEntry[];
  blobs: UnionEntry[];
  workBoard: UnionEntry[];
  revisions: Revision[];
  chunks: Map<string, ChunkFields>;
  available: Set<string>;
  defs: Map<string, AppDef>;
  /**
   * The folds over this index, memoised until the next invalidate (§3.7: every app api request
   * verifies its key against the epoch and the served version, so these must not refold per request).
   */
  memo: {
    revoked?: ReturnType<typeof foldRevokedKeys>;
    approvals: Map<string, ReturnType<typeof matchApprovals>>;
    served: Map<string, { cands: Array<SourceCandidate & { rev: Revision }>; view: ReturnType<typeof foldServedVersion> }>;
    epoch: Map<string, number>;
    versionCards?: Set<string>;
  };
}

/** The version card's one done-item; the server certifies it once the phone's approve serves the version. */
const VERSION_DONE_ITEM = 'approved';

export class ProjectAppCustomSource implements CustomAppSource {
  readonly keys: ProjectAppKeyStore;
  private readonly now: () => number;
  private ownRecords: UnionEntry[] = [];
  private ownBlobs: UnionEntry[] = [];
  private idx: Indexed | null = null;
  private servedCache = new Map<string, { revId: string; html: string }>();
  /** Approvals settleApprovedCards already tried (tap id + material), so each is tried once. */
  private readonly settled = new Set<string>();
  private settlePending = false;
  /** Chunk files known present (true) or absent (false) on disk; kept across rebuilds, changed only by writeDisk / rmDisk. */
  private diskKnown = new Map<string, boolean>();
  /** How often each fold ran (observability, and the proof that reads do not refold). */
  readonly foldCounts = { index: 0, served: 0, approvals: 0, revoked: 0, epoch: 0, diskChecks: 0 };

  constructor(private readonly d: ProjectAppCustomSourceDeps) {
    this.now = d.now ?? Date.now;
    this.keys = d.keyStore ?? new ProjectAppKeyStore({ filePath: path.join(d.stateDir, 'state', 'project-app-keys.json') });
  }

  // ── the union ─────────────────────────────────────────────────────────────

  /** A committed batch of either kind or of the Work Board: refold on next read. */
  invalidate(): void { this.idx = null; }

  private merge(read: () => UnionEntry[], own: UnionEntry[]): UnionEntry[] {
    let u: UnionEntry[] = [];
    try { u = read(); } catch { u = []; } // @silent-fallback-ok — an unreadable stream reads as no apps here; nothing is served from it
    const seen = new Set<string>(); const out: UnionEntry[] = [];
    for (const e of [...u, ...own]) {
      const k = String(e.data.recordKey ?? '');
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      out.push(e);
    }
    return out;
  }

  private index(): Indexed {
    if (this.idx) return this.idx;
    const records = this.merge(this.d.loadRecords, this.ownRecords);
    const blobs = this.merge(this.d.loadBlobs, this.ownBlobs);
    let workBoard: UnionEntry[] = [];
    try { workBoard = this.d.workBoardUnion(); } catch { workBoard = []; } // @silent-fallback-ok — no readable board ⇒ no approval counts ⇒ nothing new runs
    if (this.ownRecords.length > 500) this.ownRecords = this.ownRecords.slice(-500);
    if (this.ownBlobs.length > 2000) this.ownBlobs = this.ownBlobs.slice(-2000);
    const chunks = new Map<string, ChunkFields>();
    for (const e of blobs) {
      if (e.data.recordType !== 'project-app-chunk') continue;
      const c = validateChunk(e.data); if (c) chunks.set(chunkKey(c.appId, c.kind, c.keyGen, c.sha), c);
    }
    const revisions = foldRevisions(blobs);
    const available = new Set(chunks.keys());
    for (const r of revisions) for (const sha of r.chunks) {
      const k = chunkKey(r.appId, r.kind, r.keyGen, sha);
      if (!available.has(k) && this.onDisk(k, r.appId, r.kind, r.keyGen, sha)) available.add(k);
    }
    this.foldCounts.index++;
    this.idx = { records, blobs, workBoard, revisions, chunks, available, defs: foldAppDefs(records), memo: { approvals: new Map(), served: new Map(), epoch: new Map() } };
    this.servedCache.clear();
    this.applyRevocations(this.idx);
    return this.idx;
  }

  private isOwner = (personKey: string): boolean => { const o = this.d.ownerPersonKey(); return !!o && personKey === o; };

  private onDisk(k: string, appId: string, kind: BlobKind, keyGen: number, sha: string): boolean {
    const known = this.diskKnown.get(k);
    if (known !== undefined) return known;
    this.foldCounts.diskChecks++;
    const present = fs.existsSync(this.diskPath(appId, kind, keyGen, sha));
    if (this.diskKnown.size > 50_000) this.diskKnown.clear();
    this.diskKnown.set(k, present);
    return present;
  }

  private revokedView(ix: Indexed): ReturnType<typeof foldRevokedKeys> {
    if (!ix.memo.revoked) { this.foldCounts.revoked++; ix.memo.revoked = foldRevokedKeys({ records: ix.records, workBoard: ix.workBoard, isOwner: this.isOwner }); }
    return ix.memo.revoked;
  }

  private approvals(ix: Indexed, appId: string): ReturnType<typeof matchApprovals> {
    let a = ix.memo.approvals.get(appId);
    if (!a) { this.foldCounts.approvals++; a = matchApprovals(appId, ix.records, ix.workBoard, this.isOwner); ix.memo.approvals.set(appId, a); }
    return a;
  }

  /**
   * Destroy revoked key generations here and drop their ciphertext from the disk store. Every
   * step stands alone: one bad entry is logged and never stops a later revocation or erase.
   */
  private applyRevocations(ix: Indexed): void {
    let rv: ReturnType<typeof foldRevokedKeys>;
    try { rv = this.revokedView(ix); } catch (err) { this.d.log?.({ event: 'custom-revocation-apply-failed', error: (err as Error)?.message }); return; }
    if (!rv.revoked.length && !Object.keys(rv.eraseWatermarks).length && !rv.deletedApps.size) return;
    let failed: Array<{ what: string; appId: string; error: string }> = [];
    try { failed = this.keys.applyRevocations({ revoked: rv.revoked, eraseWatermarks: rv.eraseWatermarks, deletedApps: rv.deletedApps }).failed; }
    catch (err) { failed = [{ what: 'key-file', appId: '', error: (err as Error)?.message }]; }
    for (const f of failed) this.d.log?.({ event: 'custom-revocation-apply-failed', what: f.what, appId: f.appId, error: f.error });
    for (const appId of rv.deletedApps) this.rmDisk(path.join(this.blobRoot(), appId));
    for (const [appId, w] of Object.entries(rv.eraseWatermarks)) {
      try {
        const dir = path.join(this.blobRoot(), appId, 'data');
        let gens: string[] = [];
        try { gens = fs.readdirSync(dir); } catch { gens = []; } // @silent-fallback-ok — no data on disk for this app
        for (const g of gens) if (Number(g) <= w) this.rmDisk(path.join(dir, g));
      } catch (err) { this.d.log?.({ event: 'custom-revocation-apply-failed', what: 'erase-disk', appId, error: (err as Error)?.message }); }
    }
  }

  // ── the disk store ────────────────────────────────────────────────────────

  private blobRoot(): string { return path.join(this.d.stateDir, 'state', 'project-app-blobs'); }
  private diskPath(appId: string, kind: BlobKind, keyGen: number, sha: string): string {
    return path.join(this.blobRoot(), appId, kind, String(keyGen), sha);
  }
  private rmDisk(p: string): void {
    this.diskKnown.clear(); // whatever was under p is gone; re-check on the next rebuild
    try { SafeFsExecutor.safeRmSync(p, { recursive: true, force: true, operation: 'ProjectAppCustomSource.erase' }); }
    catch (err) { this.d.log?.({ event: 'custom-disk-erase-failed', error: (err as Error)?.message }); }
  }

  private writeDisk(c: ChunkFields): void {
    const p = this.diskPath(c.appId, c.kind, c.keyGen, c.sha);
    try {
      if (fs.existsSync(p)) return;
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([Buffer.from(c.nonce, 'base64'), Buffer.from(c.ct, 'base64')]), { mode: 0o600 });
      fs.renameSync(tmp, p);
      this.diskKnown.set(chunkKey(c.appId, c.kind, c.keyGen, c.sha), true);
    } catch (err) { this.d.log?.({ event: 'custom-disk-write-failed', appId: c.appId, error: (err as Error)?.message }); }
  }

  private readChunk(ix: Indexed, appId: string, kind: BlobKind, keyGen: number, sha: string): ChunkFields | null {
    const p = this.diskPath(appId, kind, keyGen, sha);
    try {
      const b = fs.readFileSync(p);
      if (b.length > 12 + 16) return { appId, kind, keyGen, sha, nonce: b.subarray(0, 12).toString('base64'), ct: b.subarray(12).toString('base64') };
    } catch { /* @silent-fallback-ok — not on disk yet: the journal copy below */ }
    const c = ix.chunks.get(chunkKey(appId, kind, keyGen, sha)) ?? null;
    if (c) this.writeDisk(c);
    return c;
  }

  /** Reassemble and decrypt a revision with this machine's key; null when anything is missing or wrong. */
  private openRevision(ix: Indexed, r: Revision): Buffer | null {
    const key = this.keys.get(r.appId, r.kind as AppKeyKind, r.keyGen);
    if (!key) return null;
    return reassemble(r, (sha) => {
      const c = this.readChunk(ix, r.appId, r.kind, r.keyGen, sha);
      return c ? openChunk(key, c) : null;
    }, docHashes(key, r));
  }

  // ── emitting ──────────────────────────────────────────────────────────────

  private emitInto(which: 'record' | 'blob', recordKey: string, build: Build): { ok: boolean; outcome: string; data: Record<string, unknown> | null } {
    let captured: Record<string, unknown> | null = null;
    const emit = which === 'record' ? this.d.emitRecord : this.d.emitBlob;
    const r = emit(recordKey, (hlc, origin, observed) => { captured = build(hlc, origin, observed); return captured; });
    const ok = !!captured && written(r.outcome);
    if (ok) (which === 'record' ? this.ownRecords : this.ownBlobs).push({ data: captured!, origin: this.d.machineId });
    return { ok, outcome: r.outcome, data: captured };
  }

  private notHolder(): Refusal | null {
    if (this.d.holdsLease()) return null;
    const holder = this.d.leaseHolder();
    return refuse(409, 'not-lease-holder', holder
      ? `Saving happens on ${holder}, the machine that holds the lease. (Forwarding a save there from this machine is not built yet.)`
      : 'No machine holds the lease right now, so nothing can be saved.', { holder });
  }

  /** A probe of a record's serialized size (for the budget, before the real HLC exists). */
  private probeBytes(build: Build): number {
    const rec = build({ physical: this.now(), logical: 999, node: this.d.machineId }, this.d.machineId);
    return rec ? serializedLineBytes(rec) + 32 : 0;
  }

  private ensureKey(appId: string, kind: AppKeyKind): { gen: number; key: Buffer } | Refusal {
    const cur = this.keys.current(appId, kind);
    if (cur) return cur;
    if (!this.d.holdsLease()) return refuse(503, 'key-unavailable', 'This machine does not hold this app\'s key yet.');
    // Fetch-before-create from peers (the project-app-key-fetch mesh verb) is not built: the holder creates.
    try { return this.keys.create(appId, kind); } catch (err) { return refuse(409, 'key-refused', (err as Error)?.message); }
  }

  /**
   * The narrow key's HMAC secret (§3.7). Created only on the lease holder, and only when this machine
   * holds none. (Fetching it from the holder over the mesh is not built: a standby without one answers
   * 503 key-secret-unavailable, fail closed.)
   */
  hmacSecret(): Buffer | null {
    try {
      const cur = this.keys.current(HMAC_SLOT_APP_ID, 'hmac');
      if (cur) return cur.key;
      if (!this.d.holdsLease()) return null;
      return this.keys.create(HMAC_SLOT_APP_ID, 'hmac').key;
    } catch (err) {
      this.d.log?.({ event: 'custom-hmac-unavailable', error: (err as Error)?.message });
      return null;
    }
  }

  // ── apps ──────────────────────────────────────────────────────────────────

  apps(): AppDef[] { return [...this.index().defs.values()].filter((a) => !this.deleted(a.appId)); }
  app(appId: string): AppDef | null { const a = this.index().defs.get(appId) ?? null; return a && !this.deleted(appId) ? a : null; }
  private deleted(appId: string): boolean {
    const ix = this.index();
    return this.approvals(ix, appId).some((a) => a.binding.purpose === 'delete-app');
  }

  /** POST /project-apps (§3.1). The route has already checked the Bearer. */
  createApp(input: { conversationKey: unknown; title: unknown; specPath: unknown }): { ok: true; appId: string } | Refusal {
    const ck = typeof input.conversationKey === 'string' ? input.conversationKey : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!/^(telegram|app|slack|imessage|whatsapp):[A-Za-z0-9_.:-]{1,128}$/.test(ck)) return refuse(400, 'bad-conversation-key');
    if (!title || title.length > APP_TITLE_MAX || /[\u0000-\u001f]/.test(title)) return refuse(400, 'bad-title', `A title of 1-${APP_TITLE_MAX} characters.`);
    const projects = this.d.projects();
    if (!projects) return refuse(503, 'projects-unavailable', 'The Chief of Staff (projects) is not running.');
    if (!projects.some((p) => p.conversationKey === ck)) return refuse(404, 'unknown-project', 'Custom apps belong to a project the owner sees in Work: bind this conversation as a Chief of Staff project first.');
    const spec = checkSpecConverged(this.d.projectDir, input.specPath);
    if (!spec.ok) return refuse(spec.error === 'bad-spec-path' ? 400 : 409, spec.error, spec.detail);
    const max = this.d.limits?.maxApps ?? MAX_CUSTOM_APPS_DEFAULT;
    if (this.apps().length >= max) return refuse(409, 'too-many-apps', `This agent already has ${max} custom apps (the most it may have).`, { limit: max });
    const nh = this.notHolder(); if (nh) return nh;
    let appId = `pa_${randomBytes(8).toString('hex')}`;
    while (appId === HMAC_SLOT_APP_ID) appId = `pa_${randomBytes(8).toString('hex')}`;
    const r = this.emitInto('record', appDefKey(appId), buildAppDef({ appId, conversationKey: ck, title, specPath: spec.specPath, at: new Date(this.now()).toISOString() }));
    if (!r.ok) return refuse(503, 'write-refused', r.outcome);
    this.invalidate();
    this.d.log?.({ event: 'custom-app-created', appId, conversationKey: ck });
    return { ok: true, appId };
  }

  /** Whether the app's spec still carries its convergence tags (the offer route's process signal). */
  specOk(appId: string): boolean {
    const a = this.app(appId);
    return !!a && checkSpecConverged(this.d.projectDir, a.specPath).ok;
  }

  // ── CustomAppSource ───────────────────────────────────────────────────────

  meta(appId: string): CustomAppMeta | null {
    const a = this.app(appId);
    if (!a) return null;
    const project = this.d.projects()?.find((p) => p.conversationKey === a.conversationKey)?.title ?? a.conversationKey;
    return { title: a.title, project, conversationHref: `/dashboard/console/#/conversations/${encodeURIComponent(a.conversationKey)}` };
  }

  private candidates(ix: Indexed, appId: string): Array<SourceCandidate & { rev: Revision }> {
    return ix.revisions.filter((r) => r.appId === appId && r.kind === 'source')
      .map((r) => ({ id: r.id, contentSha: r.contentSha, hlc: r.hlc, complete: isComplete(r, ix.available), rev: r }));
  }

  private servedView(appId: string) {
    const ix = this.index();
    let m = ix.memo.served.get(appId);
    if (!m) {
      this.foldCounts.served++;
      const cands = this.candidates(ix, appId);
      m = { cands, view: foldServedVersion({ appId, records: ix.records, workBoard: ix.workBoard, isOwner: this.isOwner, candidates: cands }) };
      ix.memo.served.set(appId, m);
    }
    return { ix, cands: m.cands, view: m.view };
  }

  servedVersion(appId: string): ServedVersion {
    if (!this.app(appId)) return { state: 'none' };
    const { ix, view } = this.servedView(appId);
    if (view.disabled || view.deleted) return { state: 'disabled' };
    if (!view.served) return { state: view.newerApprovedCopying ? 'copying' : 'none' };
    const cached = this.servedCache.get(appId);
    if (cached && cached.revId === view.served.id) return { state: 'served', contentSha: view.served.contentSha, html: cached.html };
    const rev = ix.revisions.find((r) => r.id === view.served!.id)!;
    const bytes = this.openRevision(ix, rev);
    // Complete here but no key on this machine yet (the key fetch verb is not built): still copying.
    if (!bytes) return { state: 'copying' };
    const html = decodeDocument(bytes);
    this.servedCache.set(appId, { revId: rev.id, html });
    return { state: 'served', contentSha: rev.contentSha, html };
  }

  /**
   * The app's key epoch (§3.7), derived from the replicated records so every machine agrees. Every
   * decision event — a version answer (reject / disable / enable), a withdraw-approval tap on any of
   * the app's cards, an owner approval — adds a million; the position of the newest approved,
   * not-rejected source revision adds its ordinal (always under a million). So a disable or a newly
   * served version always raises it, and every older key is revoked.
   */
  epoch(appId: string): number {
    const memo = this.index().memo.epoch.get(appId);
    if (memo !== undefined) return memo;
    this.foldCounts.epoch++;
    const { ix, cands, view } = this.servedView(appId);
    let ordinal = 0;
    for (let i = cands.length - 1; i >= 0; i--) {
      const d = view.contents.get(cands[i].contentSha);
      if (d && d.approved && !d.rejected) { ordinal = i + 1; break; }
    }
    const ids = new Set(CARD_PURPOSES.map((p) => versionCardId(appId, p)));
    const answers = ix.records.filter((e) => e.data.recordType === 'project-app-version-answer' && e.data.appId === appId).length;
    const withdraws = ix.workBoard.filter((e) => e.data.recordType === 'tap' && e.data.action === 'withdraw-approval' && ids.has(String(e.data.cardId))).length;
    const approvals = this.approvals(ix, appId).length;
    const e = 1 + ordinal + 1_000_000 * (answers + withdraws + approvals);
    ix.memo.epoch.set(appId, e);
    return e;
  }

  readData(appId: string): { body: unknown; revision: string | null } {
    const ix = this.index();
    const head = headRevision(ix.revisions, appId, 'data');
    if (!head) return { body: null, revision: null };
    const r = newestCompleteRevision(ix.revisions, appId, 'data', ix.available);
    const bytes = r ? this.openRevision(ix, r) : null;
    let body: unknown = null;
    if (bytes) { try { body = JSON.parse(decodeDocument(bytes)); } catch { body = null; } } // @silent-fallback-ok — a document that does not parse reads as empty; the revision still names the head
    return { body, revision: head.id };
  }

  writeData(appId: string, body: unknown, base: string | null): SourceWriteResult {
    if (!this.app(appId)) return refuse(404, 'unknown-app');
    const nh = this.notHolder(); if (nh) return nh;
    let text: string;
    try { text = JSON.stringify(body ?? null); } catch { return refuse(400, 'bad-body', 'The body must be JSON.'); }
    const r = this.writeRevision(appId, 'data', text, base, 'app');
    return r.ok ? { ok: true, revision: r.revision } : r;
  }

  readSummary(appId: string): unknown {
    const ix = this.index();
    const rv = this.revokedView(ix);
    const s = foldSummary(ix.records, appId, rv);
    if (!s) return null;
    if (s.erased) return { erased: true, asOf: s.asOf };
    const key = this.keys.get(appId, 'data', s.keyGen);
    const plain = key ? openText(key, s.sealed, summaryAad(appId, s.keyGen)) : null;
    if (!plain) return { unreadable: true, asOf: s.asOf };
    try { return { ...(JSON.parse(plain) as Record<string, unknown>), asOf: s.asOf, by: s.by }; } catch { return { unreadable: true, asOf: s.asOf }; } // @silent-fallback-ok — an unparseable summary is shown as unreadable, never as text
  }

  writeSummary(appId: string, body: unknown): SourceWriteResult {
    if (!this.app(appId)) return refuse(404, 'unknown-app');
    const nh = this.notHolder(); if (nh) return nh;
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const headline = typeof b.headline === 'string' ? b.headline : '';
    if (!headline.trim() || headline.length > 4000) return refuse(400, 'bad-summary', 'A summary has a headline (1-4000 characters).');
    const counts: Array<{ label: string; value: number }> = [];
    if (b.counts !== undefined) {
      if (!Array.isArray(b.counts) || b.counts.length > 12) return refuse(400, 'bad-summary', 'At most 12 counts.');
      for (const c of b.counts as Array<Record<string, unknown>>) {
        if (!c || typeof c.label !== 'string' || !c.label.trim() || c.label.length > 60 || typeof c.value !== 'number' || !Number.isFinite(c.value)) return refuse(400, 'bad-summary', 'Each count is {label (1-60), value (a number)}.');
        counts.push({ label: c.label, value: c.value });
      }
    }
    const at = new Date(this.now()).toISOString();
    const asOf = typeof b.asOf === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(b.asOf) ? b.asOf : at;
    if (asOf > at) return refuse(400, 'bad-summary', 'asOf cannot be later than now.');
    const k = this.ensureKey(appId, 'data'); if ('ok' in k) return k;
    const sealed = sealText(k.key, JSON.stringify({ headline, counts }), summaryAad(appId, k.gen));
    const build = buildSummary({ appId, keyGen: k.gen, sealed, asOf, by: 'app', at });
    const ix = this.index();
    const budget = this.d.limits?.dailyBudget ?? DAILY_BUDGET_DEFAULT;
    const admit = admitBudget(budgetUsage([...ix.blobs, ...ix.records], appId, utcDay(this.now())), this.probeBytes(build), budget);
    if (!admit.ok) return refuse(429, 'daily-budget', 'Saving is paused until tomorrow.', { used: admit.used, budget: admit.budget });
    const r = this.emitInto('record', summaryKey(appId), build);
    if (!r.ok) return refuse(r.data ? 503 : 413, r.data ? 'write-refused' : 'summary-too-large', r.outcome);
    this.invalidate();
    return { ok: true };
  }

  // ── revisions ─────────────────────────────────────────────────────────────

  private writeRevision(appId: string, kind: BlobKind, text: string, base: string | null, by: 'agent' | 'app', note?: string): { ok: true; revision: string; contentSha: string; bytes: number } | Refusal {
    const bytes = Buffer.byteLength(text, 'utf8');
    const lim = { source: this.d.limits?.sourceBytes, data: this.d.limits?.dataBytes };
    const size = checkWriteSize(kind, bytes, { ...(lim.source ? { source: lim.source } : {}), ...(lim.data ? { data: lim.data } : {}) });
    if (!size.ok) return refuse(413, 'too-large', `At most ${size.limit} bytes per save.`, { limit: size.limit });
    const ix = this.index();
    const b = checkWriteBase(ix.revisions, appId, kind, base);
    if (!b.ok) return refuse(409, 'conflict', 'Someone saved a newer version first; reload and try again.', { current: b.current?.id ?? null });
    const k = this.ensureKey(appId, kind); if ('ok' in k) return k;
    const doc = prepareDocument(k.key, { appId, kind, keyGen: k.gen }, text);
    const at = new Date(this.now()).toISOString();
    const builds: Array<{ key: string; build: Build; chunk?: ChunkFields }> = [];
    for (const c of doc.chunkRecords) {
      const ck = chunkKey(appId, kind, k.gen, c.sha);
      if (ix.available.has(ck)) continue; // content-addressed: already stored
      builds.push({ key: ck, build: buildChunk(c, at), chunk: c });
    }
    let sealedNote: { nonce: string; ct: string } | undefined;
    if (kind === 'source' && note) sealedNote = sealText(k.key, note.slice(0, NOTE_MAX_CHARS), noteAad(appId, k.gen));
    const revFields = { appId, kind, keyGen: k.gen, contentSha: doc.contentSha, chunks: doc.chunks, bytes: doc.bytes, base, by, ...(sealedNote ? { note: sealedNote } : {}), epoch: this.d.leaseEpoch(), at };
    const revBuild = buildRevision(revFields);
    const budget = this.d.limits?.dailyBudget ?? DAILY_BUDGET_DEFAULT;
    const incoming = builds.reduce((n, x) => n + this.probeBytes(x.build), 0) + this.probeBytes(revBuild);
    const admit = admitBudget(budgetUsage([...ix.blobs, ...ix.records], appId, utcDay(this.now())), incoming, budget);
    if (!admit.ok) return refuse(429, 'daily-budget', 'Saving is paused until tomorrow.', { used: admit.used, budget: admit.budget });
    for (const x of builds) {
      const r = this.emitInto('blob', x.key, x.build);
      if (!r.ok) { this.invalidate(); return refuse(503, 'write-refused', `A piece of the document could not be saved (${r.outcome}).`); }
      if (x.chunk) this.writeDisk(x.chunk);
    }
    // The revision key is derived from the HLC the emitter assigns; the pending key only names the emit.
    const r = this.emitInto('blob', `rev-pending:${appId}:${randomBytes(6).toString('hex')}`, revBuild);
    this.invalidate();
    if (!r.ok || !r.data) return refuse(503, 'write-refused', r.outcome);
    return { ok: true, revision: String(r.data.recordKey), contentSha: doc.contentSha, bytes: doc.bytes };
  }

  // ── source + the version card (§3.4) ──────────────────────────────────────

  /** PUT /project-apps/:appId/source. The route has checked the Bearer. */
  writeSource(appId: string, html: unknown, note: unknown): SourceWriteOutcome | Refusal {
    const a = this.app(appId);
    if (!a) return refuse(404, 'unknown-app');
    if (typeof html !== 'string' || !html.trim()) return refuse(400, 'html-required', 'The app\'s source is one HTML document.');
    if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_MAX_CHARS)) return refuse(400, 'bad-note', `A change note is text, at most ${NOTE_MAX_CHARS} characters.`);
    const nh = this.notHolder(); if (nh) return nh;
    const ix = this.index();
    const head = headRevision(ix.revisions, appId, 'source');
    const w = this.writeRevision(appId, 'source', html, head?.id ?? null, 'agent', typeof note === 'string' ? note.trim() : undefined);
    if (!w.ok) return w;
    const findings = checkAppVersion(html);
    const card = this.openVersionCard(a, w.contentSha, w.bytes, findings, typeof note === 'string' ? note.trim() : '');
    this.d.log?.({ event: 'custom-source-written', appId, card: card.state });
    return { ok: true, revision: w.revision, contentSha: w.contentSha, bytes: w.bytes, findings, card };
  }

  /** The card ids of every project-app-version-card record (the server-owned, phone-only class). */
  isVersionCard(cardId: string): boolean {
    const ix = this.index();
    if (!ix.memo.versionCards) ix.memo.versionCards = new Set(ix.records.filter((e) => e.data.recordType === 'project-app-version-card').map((e) => String(e.data.cardId)));
    return ix.memo.versionCards.has(cardId);
  }

  private openVersionCard(a: AppDef, contentSha: string, bytes: number, findings: string[], note: string): SourceWriteOutcome['card'] {
    const svc = this.d.workBoard();
    if (!svc) return { state: 'none', reason: 'The Work Board is off, so no version card could be opened.' };
    const owner = this.d.ownerPersonKey();
    if (!owner) return { state: 'none', reason: 'No owner is set up, so nobody can approve a version (custom apps need your phone).' };
    const appId = a.appId;
    const { ix, view } = this.servedView(appId);
    if (view.served?.contentSha === contentSha) return { state: 'none', reason: 'This version is already running.' };
    const cardId = versionCardId(appId, 'serve');
    const serveRecs = ix.records.filter((e) => e.data.recordType === 'project-app-version-card' && e.data.appId === appId && e.data.purpose === 'serve');
    const existing = svc.view(cardId);
    const newest = serveRecs.sort((x, y) => Number(y.data.gen) - Number(x.data.gen))[0];
    if (existing?.card.created && newest?.data.contentSha === contentSha && existing.card.materialHash === newest.data.materialHash) {
      return { state: 'none', cardId, reason: 'This version is already waiting for your phone.' };
    }
    const gen = serveRecs.reduce((m, e) => Math.max(m, Number(e.data.gen) || 0), 0) + 1;
    const project = this.d.projects()?.find((p) => p.conversationKey === a.conversationKey)?.title ?? 'its project';
    const fields = this.cardFields({ title: a.title, project, conversationKey: a.conversationKey, note, bytes, findings, appId, contentSha, gen, owner });
    let state: 'opened' | 'rewritten';
    if (existing?.card.created) {
      // A new version is a new request: the rewrite may reopen a finished card (its approval and
      // finish are bound to the old material, so the card reads as needing approval again).
      const r = svc.edit({ kind: 'agent' }, cardId, fields, { serverOwnedRewrite: true });
      if (!r.ok) return { state: 'none', cardId, reason: `The version card could not be rewritten (${r.error}).` };
      state = 'rewritten';
    } else {
      const r = svc.createCard({ kind: 'agent' }, fields, { cardId });
      if (!r.ok) return { state: 'none', cardId, reason: `The version card could not be opened (${r.error}).` };
      state = 'opened';
      try { this.d.ensureCardConversation?.(cardId); } catch (err) { this.d.log?.({ event: 'custom-card-conversation-failed', error: (err as Error)?.message }); }
    }
    const materialHash = svc.view(cardId)?.card.materialHash;
    if (!materialHash) return { state: 'none', cardId, reason: 'The version card did not land.' };
    const at = new Date(this.now()).toISOString();
    const rec = this.emitInto('record', versionCardKey({ appId, purpose: 'serve', contentSha, gen }), buildVersionCard({ appId, purpose: 'serve', gen, materialHash, contentSha, at }));
    this.invalidate();
    if (!rec.ok) return { state: 'none', cardId, reason: `The card's binding could not be recorded (${rec.outcome}); it cannot serve until it is.` };
    if (state === 'opened' && this.d.notifyProject) {
      const text = `Your agent made a new version of ${a.title}. It runs only after you approve it on your phone: it is waiting in Work.`;
      try { void Promise.resolve(this.d.notifyProject(a.conversationKey, text)).catch((err) => this.d.log?.({ event: 'custom-card-notice-failed', error: (err as Error)?.message })); }
      catch (err) { this.d.log?.({ event: 'custom-card-notice-failed', error: (err as Error)?.message }); }
    }
    return { state, cardId };
  }

  /**
   * Finish every serve card the owner's phone has approved (§3.4): the same approval match that makes
   * the version served. Only the lease holder writes (the same holder rule every card write follows).
   * Idempotent: a card already finished for its current material is skipped, and each approval is
   * tried at most once in this process per hold state (a refusal is logged, never retried in a loop; an approval
   * whose version is not served here yet is not counted as tried, so a later commit finishes it).
   * Called (through scheduleSettle) after a commit of any of the three streams, and once at boot.
   */
  settleApprovedCards(): { closed: string[]; refused: Array<{ cardId: string; error: string }> } {
    return this.settle();
  }

  /** settleApprovedCards after the current commit (coalesced). */
  scheduleSettle(): void {
    if (this.settlePending) return;
    this.settlePending = true;
    // After the commit that asked: the observer that calls this is inside a journal commit, and
    // settling writes Work Board records of its own.
    setImmediate(() => {
      this.settlePending = false;
      try { this.settleApprovedCards(); } catch (err) { this.d.log?.({ event: 'custom-card-close-failed', error: (err as Error)?.message }); }
    });
  }

  private settle(): { closed: string[]; refused: Array<{ cardId: string; error: string }> } {
    const out = { closed: [] as string[], refused: [] as Array<{ cardId: string; error: string }> };
    if (!this.d.holdsLease()) return out;
    const svc = this.d.workBoard();
    if (!svc) return out;
    for (const a of this.apps()) {
      const cardId = versionCardId(a.appId, 'serve');
      const v = svc.view(cardId);
      const card = v?.card;
      if (!card || !card.created || card.redacted || card.done) continue;
      if (!card.approvalValid) continue;
      const { ix, view } = this.servedView(a.appId);
      const approval = this.approvals(ix, a.appId).find((x) => x.binding.cardId === cardId && x.binding.purpose === 'serve' && x.binding.materialHash === card.materialHash);
      if (!approval) continue;
      if (!view.served || view.served.contentSha !== approval.binding.contentSha) continue; // not running here yet
      // One try per approval and per state of the things that refuse a finish (holds, unreadable parts):
      // a person releasing a hold earns one more try; nothing the server writes does.
      const attempt = `${approval.tapId}:${card.materialHash}:${card.holds.join(',')}:${card.unknown.length}`;
      if (this.settled.has(attempt)) continue;
      this.settled.add(attempt);
      if (this.settled.size > 1000) this.settled.delete(this.settled.values().next().value as string);
      const agent = { kind: 'agent' } as const;
      if (!card.evidence.some((e) => e.itemId === VERSION_DONE_ITEM && e.counts)) {
        const e = svc.addEvidence(agent, cardId, { itemId: VERSION_DONE_ITEM, text: 'Approved on your phone; this version is now running.' });
        if (!e.ok) { out.refused.push({ cardId, error: e.error }); this.d.log?.({ event: 'custom-card-close-refused', appId: a.appId, cardId, step: 'evidence', error: e.error }); continue; }
      }
      const c = svc.claimDone(agent, cardId);
      if (!c.ok) { out.refused.push({ cardId, error: c.error }); this.d.log?.({ event: 'custom-card-close-refused', appId: a.appId, cardId, step: 'claim', error: c.error }); continue; }
      out.closed.push(cardId);
      this.d.log?.({ event: 'custom-card-closed', appId: a.appId, cardId, contentSha: approval.binding.contentSha });
    }
    return out;
  }

  private cardFields(c: { title: string; project: string; conversationKey: string; note: string; bytes: number; findings: string[]; appId: string; contentSha: string; gen: number; owner: string }): Record<string, unknown> {
    const kb = c.bytes < 1024 ? `${c.bytes} bytes` : c.bytes < 1024 * 1024 ? `${(c.bytes / 1024).toFixed(1)} KB` : `${(c.bytes / 1024 / 1024).toFixed(2)} MB`;
    const titleRaw = `Run ${c.title} new version for ${c.project}?`;
    const title = titleRaw.length <= 300 ? titleRaw : `Run ${c.title} new version?`;
    const note = cardNoteText(c.note);
    const noteLine = note ? `What changed, in your agent's words: "${note}"` : 'Your agent left no note on what changed.';
    const check = c.findings.length ? `Automated check (a signal, not a verdict):\n- ${c.findings.join('\n- ')}` : 'Automated check: nothing unusual found.';
    // The server's own findings come BEFORE the agent's note, and the note is one line, so the note
    // can never pose as (or push down) the check results.
    const need = [
      `Your agent wrote a new version of ${c.title}, an app for ${c.project}. It runs only after you approve it on your phone.`,
      check,
      `Size: ${kb}.`,
      noteLine,
      versionCardSupportLine(c.appId, c.contentSha, c.gen),
    ].join('\n\n');
    return {
      title, need,
      // The server finishes the card itself once the phone's approve serves this version
      // (settleApprovedCards), so the item is agent-certified: an owner-confirms item would leave the
      // card "Yours to do" after the approve with nothing to close it. The carrier stays the owner:
      // a card carried by the agent is workable once approved and would start an agent pickup.
      // `outward` stays true in the record: in the Work Board it is what makes a card need its own
      // approve tap under every board policy (under "Only outward cards wait" an inward agent card
      // needs none, and the phone shows Approve only on a card that needs approval). The display
      // does not say it sends anything outward: cardJson drops the outward wording for phone-only cards.
      doneWhen: [{ id: VERSION_DONE_ITEM, text: 'You approved this version on your phone', certify: 'agent-may-certify' }],
      carrier: { personKey: c.owner }, outward: true, links: [], projectKey: c.conversationKey,
    };
  }
}

export { PROJECT_APP_STORE_KEY, PROJECT_APP_BLOB_STORE_KEY };
