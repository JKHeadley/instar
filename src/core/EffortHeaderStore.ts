/**
 * EffortHeaderStore — the METADATA of effort headers (docs/specs/conversation-effort-hierarchy-v3.md
 * §3.2 and §7.6). It never holds user text, salts, keys or ciphertext.
 *
 * CUSTODY (decided with the runtime owner, 2026-11-05): the runtime's witness/replication owns the
 * ONE encrypted payload and key lifecycle, with its enumerated backup and erasure protocol. This
 * store keeps only opaque metadata per header — the applied operations' cores (id, kind, base
 * version, operation hash, salted commitment, bundle reference) and whether the header is forgotten.
 * A title is resolved on demand through an injected `HeaderDecryptor` that reads the runtime's
 * all-member-certified source custody; nothing decrypted is cached or written. When custody is
 * missing or erased, the decryptor returns null and so does `titleOf`.
 *
 * IDENTITY (§7.6): a header is addressed by an opaque random `headerId`, referenced from the
 * effort's `create-effort` graph event. Graph events never carry text or a deterministic hash.
 *
 * OPERATIONS carry no plaintext: `set-effort-title` names a SALTED commitment
 * sha256(salt-hex ‖ "\0" ‖ canonical title) and an encrypted bundle reference; `forget-header`
 * names neither. `applyCertified(op, {title, salt})` verifies the decrypted pair against the
 * commitment (so a wrong bundle is refused) and then persists only the operation's opaque core.
 * `titleOf` re-verifies the decryptor's answer against the winning operation's commitment.
 *
 * ORDER-INDEPENDENT: version v+1 is the set whose baseVersion is v; a same-base race resolves by the
 * smallest operation hash (the others are reported); a future base is held; a forgotten header's
 * version is max(forget baseVersion)+1; refused operations are never recorded. A forget is a
 * tombstone: serving stops at once, here, whatever the runtime's purge status.
 *
 * ONE WRITER per stateDir is required. Writes and reads re-check the file; there is no lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson, sha256Hex, HEADER_ID_RE } from './conversationGraph.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const MAX_EFFORT_TITLE_CHARS = 200;
export const HEADER_OPERATION_SCHEMA_VERSION = 1;
const OP_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SALT_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Identifiers only — no spaces, so prose cannot ride in an immutable core field. */
const ID_RE = /^[A-Za-z0-9_.:@-]{1,120}$/;

interface HeaderOpBase {
  schemaVersion: 1;
  opId: string;
  headerId: string;
  baseVersion: number;
  authority: 'owner';
  principal: string;
  receipt: { kind: 'owner-proof'; id: string };
  machineId: string;
  createdAt: string;
}
export interface SetTitleOperation extends HeaderOpBase {
  kind: 'set-effort-title';
  /** sha256(salt-hex ‖ "\0" ‖ canonical title). The salt lives only in the encrypted bundle. */
  titleCommitment: string;
  bundleRef: { kind: 'header-source-bundle'; id: string };
}
export interface ForgetHeaderOperation extends HeaderOpBase { kind: 'forget-header' }
export type HeaderOperation = SetTitleOperation | ForgetHeaderOperation;

/**
 * Reads the runtime's certified source custody. Returns the decrypted {title, salt} for a bundle,
 * or null when it is missing, not yet all-member certified, or erased. Must not cache plaintext.
 */
export type HeaderDecryptor = (headerId: string, bundleRef: SetTitleOperation['bundleRef']) => { title: string; salt: string } | null;

/** A fresh opaque header id for a new effort's `create-effort` event. */
export function newHeaderId(): string { return `hdr-${crypto.randomBytes(16).toString('base64url')}`; }
export function isHeaderId(v: unknown): v is string { return typeof v === 'string' && HEADER_ID_RE.test(v); }
/** The canonical form of a title: NFC-normalized and trimmed. */
export function canonicalTitle(title: string): string { return title.normalize('NFC').trim(); }
/** A fresh per-operation salt (32 random bytes, hex). It belongs ONLY inside the encrypted bundle. */
export function newTitleSalt(): string { return crypto.randomBytes(32).toString('hex'); }
/** The salted commitment an operation carries. Never compute or store an unsalted title hash. */
export function titleCommitment(title: string, salt: string): string {
  if (!SALT_RE.test(salt)) throw new Error('title salt must be 32 random bytes, hex');
  return sha256Hex(`${salt}\0${canonicalTitle(title)}`);
}
export function headerOperationHash(op: HeaderOperation): string { return sha256Hex(canonicalJson(op)); }

function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).sort().join(',') === [...keys].sort().join(',');
}

/** Validate an untrusted header operation. Off-schema → null. */
export function validateHeaderOperation(raw: unknown): HeaderOperation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== HEADER_OPERATION_SCHEMA_VERSION) return null;
  if (typeof o.opId !== 'string' || !OP_ID_RE.test(o.opId)) return null;
  if (!isHeaderId(o.headerId)) return null;
  if (typeof o.baseVersion !== 'number' || !Number.isSafeInteger(o.baseVersion) || o.baseVersion < 0) return null;
  if (o.authority !== 'owner') return null; // header writes are owner-only
  if (typeof o.principal !== 'string' || !ID_RE.test(o.principal)) return null;
  const rc = o.receipt as Record<string, unknown> | null;
  if (!rc || typeof rc !== 'object' || Array.isArray(rc) || !exactKeys(rc, ['id', 'kind']) || rc.kind !== 'owner-proof' || typeof rc.id !== 'string' || !ID_RE.test(rc.id)) return null;
  if (typeof o.machineId !== 'string' || !ID_RE.test(o.machineId)) return null;
  if (typeof o.createdAt !== 'string' || !ISO_RE.test(o.createdAt) || Number.isNaN(Date.parse(o.createdAt))) return null;
  const base: HeaderOpBase = {
    schemaVersion: 1, opId: o.opId, headerId: o.headerId as string, baseVersion: o.baseVersion,
    authority: 'owner', principal: o.principal, receipt: { kind: 'owner-proof', id: rc.id as string }, machineId: o.machineId, createdAt: o.createdAt,
  };
  const common = ['schemaVersion', 'opId', 'headerId', 'baseVersion', 'authority', 'principal', 'receipt', 'machineId', 'createdAt', 'kind'];
  if (o.kind === 'set-effort-title') {
    if (!exactKeys(o, [...common, 'titleCommitment', 'bundleRef'])) return null; // no plaintext title, no salt, no extras
    if (typeof o.titleCommitment !== 'string' || !SHA_RE.test(o.titleCommitment)) return null;
    const b = o.bundleRef as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !exactKeys(b, ['id', 'kind']) || b.kind !== 'header-source-bundle' || typeof b.id !== 'string' || !ID_RE.test(b.id)) return null;
    return { ...base, kind: 'set-effort-title', titleCommitment: o.titleCommitment, bundleRef: { kind: 'header-source-bundle', id: b.id as string } };
  }
  if (o.kind === 'forget-header') {
    if (!exactKeys(o, common)) return null;
    return { ...base, kind: 'forget-header' };
  }
  return null;
}

/** The opaque metadata kept per applied operation — never text, salt, key or ciphertext. */
interface OpMeta {
  opId: string;
  kind: HeaderOperation['kind'];
  baseVersion: number;
  hash: string;
  titleCommitment?: string;
  bundleRef?: SetTitleOperation['bundleRef'];
}
interface HeaderRecord {
  ops: OpMeta[];
  forgotten?: true;
  /**
   * A LOCAL erasure fence (§7.6 "immediately suppress local serving"): set when an owner-verified
   * forget intent is accepted on this machine, before witness or fleet certification. Never lifted:
   * the certified forget-header later completes it.
   */
  fence?: { receiptId: string; at: string };
}
/** v5 adds the local erasure fence; an older build refuses a v5 file instead of ignoring the fence. */
interface Snapshot { schemaVersion: 5; headers: Record<string, HeaderRecord> }

/** The opaque record of an owner-verified forget intent, accepted by the runtime's ingress. */
export interface ForgetIntentReceipt { kind: 'owner-forget-intent'; id: string; at: string }

export type ErasureState = 'none' | 'pending' | 'complete';

/** Why a pending header operation would be refused if submitted now (revalidation, never a guess). */
export type HeaderRevalidation =
  | { ok: true; currentVersion: number }
  | { ok: false; reason: 'invalid' | 'opid-reused' | 'erasure-pending' | 'forgotten' | 'stale-version' | 'future-version'; currentVersion: number };

export type ApplyResult =
  | { applied: true; local: true }
  | { applied: false; reason: 'duplicate' | 'opid-conflict' | 'forgotten' | 'erasure-pending' | 'commitment-mismatch' | 'invalid' | 'title-required' };

export interface DerivedHeader {
  version: number;
  forgotten: boolean;
  /** 'pending' once a local fence is set and until the certified forget is applied; then 'complete'. */
  erasure: ErasureState;
  /** The winning set operation (null if none or forgotten): what titleOf resolves through custody. */
  current: { opId: string; bundleRef: SetTitleOperation['bundleRef']; titleCommitment: string } | null;
  conflicts: string[];
  held: string[];
}

export class EffortHeaderStore {
  readonly file: string;
  private readonly dir: string;
  private snap: Snapshot = { schemaVersion: 5, headers: {} };
  private stamp = '';

  constructor(stateDir: string, private readonly decryptor: HeaderDecryptor) {
    this.dir = path.join(stateDir, 'conversation-graph');
    this.file = path.join(this.dir, 'effort-headers.json');
    this.load();
  }

  load(): void {
    if (fs.existsSync(this.dir)) {
      for (const name of fs.readdirSync(this.dir)) {
        const m = /^effort-headers\.json\.(\d+)\.tmp$/.exec(name);
        if (m && !EffortHeaderStore.alive(Number(m[1]))) this.removeTemp(path.join(this.dir, name));
      }
    }
    if (!fs.existsSync(this.file)) { this.snap = { schemaVersion: 5, headers: {} }; this.stamp = this.currentStamp(); return; }
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Snapshot>;
    if (!parsed || parsed.schemaVersion !== 5 || !parsed.headers || typeof parsed.headers !== 'object') {
      // A file this version cannot read is never silently replaced: refuse to start.
      throw new Error(`effort header store unreadable: ${this.file}`);
    }
    this.snap = { schemaVersion: 5, headers: { ...parsed.headers } };
    this.stamp = this.currentStamp();
  }

  private currentStamp(): string {
    try { const st = fs.statSync(this.file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return 'absent'; }
  }

  private refreshIfChanged(): void { if (this.currentStamp() !== this.stamp) this.load(); }

  /**
   * Apply one ALL-MEMBER-CERTIFIED operation. For a set, `content` is the decrypted bundle
   * {title, salt}; it is verified against the commitment and then dropped. Only the operation's
   * opaque metadata is persisted. Idempotent per opId.
   */
  applyCertified(raw: HeaderOperation, content: { title: string; salt: string } | null): ApplyResult {
    const op = validateHeaderOperation(raw);
    if (!op) return { applied: false, reason: 'invalid' };
    this.load(); // read-modify-write against the file, never a cached snapshot
    // A private copy: a refused operation must never alter the cached snapshot.
    const rec: HeaderRecord = structuredClone(this.snap.headers[op.headerId] ?? { ops: [] });
    const hash = headerOperationHash(op);
    const same = rec.ops.find((x) => x.opId === op.opId);
    if (same) {
      if (same.hash === hash) return { applied: false, reason: 'duplicate' };
      // A reused opId with different content. A FORGET ALWAYS WINS, in either arrival order: a
      // forget reusing a set's opId replaces it and is applied; nothing reusing an opId may displace
      // a forget or touch a forgotten header. Between two sets, every member keeps the SMALLER hash
      // (the newcomer must verify), so the outcome never depends on arrival order.
      if (op.kind === 'set-effort-title' && (rec.forgotten || same.kind === 'forget-header')) return { applied: false, reason: 'opid-conflict' };
      if (op.kind === 'set-effort-title' && (hash > same.hash || !verifies(op, content))) return { applied: false, reason: 'opid-conflict' };
      if (op.kind === 'forget-header' && same.kind === 'forget-header' && hash > same.hash) return { applied: false, reason: 'opid-conflict' };
      rec.ops = rec.ops.filter((x) => x.opId !== op.opId);
      rec.forgotten = rec.ops.some((x) => x.kind === 'forget-header') ? true : undefined;
    }
    if (op.kind === 'forget-header') {
      const next: HeaderRecord = { ops: [...rec.ops, { opId: op.opId, kind: op.kind, baseVersion: op.baseVersion, hash }], forgotten: true };
      this.persist({ schemaVersion: 5, headers: { ...this.snap.headers, [op.headerId]: next } });
      return { applied: true, local: true };
    }
    if (rec.forgotten) return { applied: false, reason: 'forgotten' }; // refused, never recorded
    if (rec.fence) return { applied: false, reason: 'erasure-pending' }; // a local forget fence: refused, never recorded
    if (!verifies(op, content)) {
      if (content === null || typeof content.title !== 'string' || typeof content.salt !== 'string') return { applied: false, reason: 'title-required' };
      const clean = canonicalTitle(content.title);
      if (clean.length === 0 || clean.length > MAX_EFFORT_TITLE_CHARS || !SALT_RE.test(content.salt)) return { applied: false, reason: 'invalid' };
      return { applied: false, reason: 'commitment-mismatch' };
    }
    const meta: OpMeta = { opId: op.opId, kind: op.kind, baseVersion: op.baseVersion, hash, titleCommitment: op.titleCommitment, bundleRef: op.bundleRef };
    this.persist({ schemaVersion: 5, headers: { ...this.snap.headers, [op.headerId]: { ops: [...rec.ops, meta] } } });
    return { applied: true, local: true };
  }

  /** The derived header metadata, identical on every machine for the same applied operations. */
  get(headerId: string): DerivedHeader | null {
    this.refreshIfChanged();
    const rec = this.snap.headers[headerId];
    if (!rec) return null;
    if (rec.forgotten) {
      const forgetBase = Math.max(...rec.ops.filter((o) => o.kind === 'forget-header').map((o) => o.baseVersion));
      return { version: forgetBase + 1, forgotten: true, erasure: 'complete', current: null, conflicts: [], held: [] };
    }
    const sets = rec.ops.filter((o) => o.kind === 'set-effort-title');
    let version = 0;
    let winner: OpMeta | null = null;
    const conflicts: string[] = [];
    for (;;) {
      const atBase = sets.filter((o) => o.baseVersion === version).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
      if (atBase.length === 0) break;
      winner = atBase[0];
      conflicts.push(...atBase.slice(1).map((o) => o.opId));
      version += 1;
    }
    const held = sets.filter((o) => o.baseVersion > version).map((o) => o.opId).sort();
    const current = winner && winner.bundleRef && winner.titleCommitment
      ? { opId: winner.opId, bundleRef: winner.bundleRef, titleCommitment: winner.titleCommitment }
      : null;
    return { version, forgotten: false, erasure: rec.fence ? 'pending' : 'none', current, conflicts: conflicts.sort(), held };
  }

  /**
   * Fence a header LOCALLY, at once, when the runtime has verified an owner's forget intent (device
   * proof / PIN at its ingress) — before any witness, peer or network step. From here on titleOf
   * returns null and every set for this header is refused, even across a restart or a replay of an
   * older certified set. Idempotent; the first receipt is kept. The certified forget-header later
   * completes the erasure; nothing lifts the fence.
   */
  suppressHeader(headerId: string, receipt: ForgetIntentReceipt): { fenced: true; erasure: ErasureState } | { fenced: false; reason: 'invalid' } {
    const r = receipt as unknown as Record<string, unknown> | null;
    if (!isHeaderId(headerId) || !r || typeof r !== 'object' || !exactKeys(r, ['at', 'id', 'kind']) || r.kind !== 'owner-forget-intent' ||
      typeof r.id !== 'string' || !ID_RE.test(r.id) || typeof r.at !== 'string' || !ISO_RE.test(r.at) ||
      Number.isNaN(Date.parse(r.at)) || new Date(r.at).toISOString() !== r.at) return { fenced: false, reason: 'invalid' };
    this.load();
    const rec: HeaderRecord = structuredClone(this.snap.headers[headerId] ?? { ops: [] });
    if (rec.forgotten) return { fenced: true, erasure: 'complete' };
    if (!rec.fence) this.persist({ schemaVersion: 5, headers: { ...this.snap.headers, [headerId]: { ...rec, fence: { receiptId: receipt.id, at: receipt.at } } } });
    return { fenced: true, erasure: 'pending' };
  }

  /**
   * Client-facing admission for a NOT-YET-SUBMITTED header operation (the runtime's pending queue and
   * its 409 header-version-conflict): a set must name exactly the current derived version (0 for a
   * header that does not exist yet), must not reuse an applied opId, and is refused on a fenced or
   * forgotten header; a forget is always admissible. This is deliberately STRICTER than
   * applyCertified, which must accept every certified operation (races and future versions included)
   * so that every member derives the same header. Passing revalidate does not bypass certification.
   */
  revalidate(raw: HeaderOperation): HeaderRevalidation {
    const op = validateHeaderOperation(raw);
    const h = op ? this.get(op.headerId) : null;
    const currentVersion = h?.version ?? 0;
    if (!op) return { ok: false, reason: 'invalid', currentVersion };
    if (op.kind === 'forget-header') return { ok: true, currentVersion };
    if ((this.snap.headers[op.headerId]?.ops ?? []).some((o) => o.opId === op.opId)) return { ok: false, reason: 'opid-reused', currentVersion };
    if (h?.forgotten) return { ok: false, reason: 'forgotten', currentVersion };
    if (h?.erasure === 'pending') return { ok: false, reason: 'erasure-pending', currentVersion };
    if (op.baseVersion < currentVersion) return { ok: false, reason: 'stale-version', currentVersion };
    if (op.baseVersion > currentVersion) return { ok: false, reason: 'future-version', currentVersion };
    return { ok: true, currentVersion };
  }

  /**
   * The title to display: resolved through the injected decryptor from the runtime's custody and
   * re-verified against the winning commitment. Null when absent, forgotten, missing or erased.
   * Nothing is cached.
   */
  titleOf = (headerId: string): string | null => {
    const h = this.get(headerId);
    if (!h || h.forgotten || h.erasure !== 'none' || !h.current) return null;
    const content = this.decryptor(headerId, h.current.bundleRef);
    if (!content || typeof content.title !== 'string' || typeof content.salt !== 'string' || !SALT_RE.test(content.salt)) return null;
    return titleCommitment(content.title, content.salt) === h.current.titleCommitment ? canonicalTitle(content.title) : null;
  };

  private persist(next: Snapshot): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600); /* state-registry: conversation-graph */
      try {
        fs.writeSync(fd, `${JSON.stringify(next)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.removeTemp(tmp);
      throw err;
    }
    try {
      const dfd = fs.openSync(this.dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the file itself was fsynced */ }
    this.snap = next;
    this.stamp = this.currentStamp();
  }

  private removeTemp(file: string): void {
    try { SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/core/EffortHeaderStore.ts:temp-cleanup' }); } catch { /* @silent-fallback-ok — the next load retries the sweep */ }
  }

  private static alive(pid: number): boolean {
    if (pid === process.pid) return false; // this process is not mid-write during load
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
  }
}

function verifies(op: SetTitleOperation, content: { title: string; salt: string } | null): boolean {
  if (!content || typeof content.title !== 'string' || typeof content.salt !== 'string' || !SALT_RE.test(content.salt)) return false;
  const clean = canonicalTitle(content.title);
  if (clean.length === 0 || clean.length > MAX_EFFORT_TITLE_CHARS) return false;
  return titleCommitment(clean, content.salt) === op.titleCommitment;
}

/**
 * Build a valid operation core (tests and the runtime intake). For a set, pass the title and the
 * salt that will travel in the encrypted bundle; the core keeps only their commitment.
 */
export function makeHeaderOperation(
  kind: HeaderOperation['kind'], headerId: string, baseVersion: number, extra: { title?: string; salt?: string; opId?: string; createdAt?: string } = {},
): HeaderOperation {
  const base: HeaderOpBase = {
    schemaVersion: 1, opId: extra.opId ?? `hop-${crypto.randomBytes(6).toString('hex')}`, headerId, baseVersion,
    authority: 'owner', principal: 'owner', receipt: { kind: 'owner-proof', id: 'proof' }, machineId: 'm1',
    createdAt: extra.createdAt ?? '2026-11-05T12:00:00.000Z',
  };
  return kind === 'set-effort-title'
    ? { ...base, kind, titleCommitment: titleCommitment(extra.title ?? '', extra.salt ?? newTitleSalt()), bundleRef: { kind: 'header-source-bundle', id: `b-${base.opId}` } }
    : { ...base, kind };
}
