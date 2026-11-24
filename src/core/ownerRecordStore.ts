/**
 * The owner record on this machine (identity-security piece 2b).
 *
 * Stores 2a's `keep` set (and ancestors) in `.instar/state/owner-record/` (listed in KEY_MATERIAL_PATHS: never
 * served, backed up, committed or synced). The markers and the pin
 * live apart, in `.instar/machine/`, so deleting one folder never reads as Basic. State is always
 * recomputed from stored entries with 2a's evaluator; nothing editable stands in for it.
 *
 * Spec: docs/specs/identity-security-piece2b-owner-record-store.md
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateOwnerRecord, ownerRecordEntryId, ownerRecordSignedText, signOwnerRecordEntry, OWNER_RECORD_MAX_INPUT,
  type EvaluateOptions, type OwnerRecordEntry, type OwnerRecordState,
} from './ownerRecord.js';

export interface OwnerRecordSelf {
  machineId: string;
  publicKeyPem: string;
  sign: (text: string) => string;
}

export interface OwnerRecordStoreDeps {
  instarDir: string;
  agentId: string;
  /** This machine's mesh identity, or null when it has none (a single machine that never paired). */
  self: () => OwnerRecordSelf | null;
  /** A registered machine's signing public key, used only for unpinned (Basic) genesis candidates. */
  registeredKey: (machineId: string) => string | null;
  verifyFirstOwnerProof?: EvaluateOptions['verifyFirstOwnerProof'];
  now?: () => number;
}

export type Enrolment = 'never' | 'enrolled' | 'unknown';
export interface GateVerdict {
  act: 'basic' | 'record' | 'hold';
  enrolment: Enrolment;
  reason: string;
  state: OwnerRecordState | null;
}

/** What peers have said, as far as the gate is concerned. */
export interface PeerView {
  /** Every registered active peer answered a pull this boot (an older build's "unknown command" is not an answer). */
  allAnswered: boolean;
  /** Some peer reported a marker naming this agent and a genesis held here or enrolled at a peer (§4). */
  honouredPeerMarker: boolean;
  /** Piece 2c §1: enrolled, a fence value is set, but neither it nor a last verified fence is usable. */
  fenceUnusable?: boolean;
}

interface Marker { agentId: string; machineId: string | null; genesis: string; at: string }
type MarkerRead = { kind: 'absent' } | { kind: 'ok'; marker: Marker } | { kind: 'mismatch' | 'unreadable' };

const RECORD_DIR = path.join('state', 'owner-record');
const ENTRIES_FILE = 'entries.jsonl';
const EXCLUDED_FILE = 'excluded-geneses.json';
const ENROLLED_MARKER = 'owner-record-enrolled.json';
const SEEN_MARKER = 'owner-record-seen.json';
const PIN_FILE = 'owner-record-pin.json';
/** Over 2a's 2,000-entry bound only a verified flood can arrive (§2); it is kept up to this cap so the record
 *  keeps reading `input-too-large` (a visible hold) across restarts. Revocations are always kept. */
export const OWNER_RECORD_STORE_HARD_CAP = 2_500;
const OVER_CAP_REVOCATIONS = 50;
/** Verified candidate keys tried per entry when checking arrivals (§2): keeps the check linear in the batch. */
const MAX_CANDIDATES = 4;

export class OwnerRecordStore {
  private entries = new Map<string, OwnerRecordEntry>();
  private excluded = new Set<string>();
  private current: OwnerRecordState | null = null;

  constructor(private readonly deps: OwnerRecordStoreDeps) {}

  private get recordDir(): string { return path.join(this.deps.instarDir, RECORD_DIR); }
  private get machineDir(): string { return path.join(this.deps.instarDir, 'machine'); }

  /** Read stored entries and re-evaluate. A corrupt line is skipped and counted, never fatal. */
  load(): { corruptLines: number } {
    this.entries.clear();
    let corruptLines = 0;
    const file = path.join(this.recordDir, ENTRIES_FILE);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as OwnerRecordEntry;
          this.entries.set(ownerRecordEntryId(e), e);
        } catch { corruptLines++; /* @silent-fallback-ok: a corrupt line is counted and reported in status; the entry can be pulled again from a peer */ }
      }
    }
    const ex = readJson<string[]>(path.join(this.recordDir, EXCLUDED_FILE));
    this.excluded = new Set(Array.isArray(ex) ? ex.filter((x) => typeof x === 'string') : []);
    this.current = this.entries.size > 0 ? this.evaluate([...this.entries.values()]) : null;
    return { corruptLines };
  }

  state(): OwnerRecordState | null { return this.current; }
  hasRecord(): boolean { return this.entries.size > 0; }
  pinned(): string | null {
    const p = readJson<{ genesis?: unknown; agentId?: unknown }>(path.join(this.machineDir, PIN_FILE));
    return p && typeof p.genesis === 'string' && p.agentId === this.deps.agentId ? p.genesis : null;
  }
  enrolledMarker(): MarkerRead { return this.readMarker(ENROLLED_MARKER); }
  seenMarker(): boolean { return fs.existsSync(path.join(this.machineDir, SEEN_MARKER)); }
  /** Ids held, for pulls. */
  ids(): string[] { return [...this.entries.keys()].sort(); }

  /** A page of entries the asker lacks, ordered by id so paging is stable. */
  page(have: ReadonlySet<string>, after: string | null, limit = 500): { entries: OwnerRecordEntry[]; next: string | null } {
    const ids = this.ids().filter((id) => !have.has(id) && (after === null || id > after));
    const slice = ids.slice(0, limit);
    return { entries: slice.map((id) => this.entries.get(id)!), next: ids.length > limit ? slice[slice.length - 1] : null };
  }

  /**
   * Judge new entries together with the stored ones and keep only 2a's `keep` set and its ancestors, each
   * with its one verifying signature. Returns the ids newly stored.
   */
  ingest(rawIncoming: unknown[]): { added: string[]; state: OwnerRecordState; refused?: 'input-too-large' | 'no-genesis' } {
    // Only entries whose signature verifies against a key this record has ever held (or one added, verified,
    // in the same batch) go further: junk never counts toward the bound or the work.
    const incoming = this.verifiedOnly(rawIncoming);
    const pool = new Map<string, unknown[]>();
    for (const e of this.entries.values()) pool.set(ownerRecordEntryId(e), [e]);
    for (const raw of incoming) {
      let id: string;
      try { id = ownerRecordEntryId(raw as OwnerRecordEntry); } catch { continue; /* @silent-fallback-ok: an entry whose id can't be computed is malformed; the evaluator would reject it anyway */ }
      if (this.entries.has(id)) continue; // already stored with a verifying signature: a junk copy can't shadow it
      pool.set(id, [...(pool.get(id) ?? []), raw]);
    }
    const all = [...pool.values()].flat();
    const state = this.evaluate(all);
    // Never replace what is stored with a result that can't stand on its own: an over-bound input, or one
    // with no genesis at all (for example, its machine left the registry). The stored record stays as is.
    if (this.entries.size > 0 && state.status === 'input-too-large') {
      // A verified flood (a stolen key): keep it, up to the hard cap and every revocation, so the record reads
      // `input-too-large` and holds until the owner's reset, here and after a restart. Nothing stored is dropped.
      const added: string[] = [];
      for (const raw of incoming) {
        const e = raw as OwnerRecordEntry;
        const id = ownerRecordEntryId(e);
        if (this.entries.has(id)) continue;
        if (this.entries.size >= OWNER_RECORD_STORE_HARD_CAP) {
          // Past the cap only an owner key's revocation of a key this record holds may be kept, and only 50.
          const known = this.knownKeys();
          const ownerRevocation = e.kind === 'revoke-key' && e.signer?.type === 'owner-key' && known.has(e.signer.keyId) && typeof e.body?.keyId === 'string' && known.has(e.body.keyId);
          if (!ownerRevocation || this.entries.size >= OWNER_RECORD_STORE_HARD_CAP + OVER_CAP_REVOCATIONS) continue;
        }
        this.entries.set(id, e); added.push(id);
      }
      if (added.length > 0) this.persistEntries();
      this.current = state;
      return { added: added.sort(), state, refused: 'input-too-large' };
    }
    if (this.entries.size > 0 && state.genesis === null) {
      return { added: [], state: this.current ?? state, refused: 'no-genesis' };
    }
    const replaced = this.applyReplacement(state, all);
    const finalState = replaced ? this.evaluate(all) : state;
    const byId = new Map<string, OwnerRecordEntry>();
    for (const raw of all) {
      const e = raw as OwnerRecordEntry;
      let id: string;
      try { id = ownerRecordEntryId(e); } catch { continue; /* @silent-fallback-ok: malformed, already rejected by the evaluator */ }
      if (finalState.signatures[id] === e.sig) byId.set(id, e);
    }
    const kept = new Map<string, OwnerRecordEntry>();
    const stack = [...finalState.keep];
    while (stack.length) {
      const id = stack.pop()!;
      if (kept.has(id)) continue;
      const e = byId.get(id) ?? this.entries.get(id);
      if (!e) continue;
      kept.set(id, e);
      stack.push(...e.parents);
    }
    const added = [...kept.keys()].filter((id) => !this.entries.has(id)).sort();
    const removed = [...this.entries.keys()].some((id) => !kept.has(id));
    if (added.length > 0 || removed) {
      this.entries = kept;
      this.persistEntries();
    }
    this.current = this.entries.size > 0 ? finalState : null;
    this.afterEvaluate();
    return { added, state: finalState };
  }

  /**
   * Write a Basic genesis with this machine's key (decision 17). The caller checks §3's conditions (lease,
   * no split-brain, every peer answered with no record and no marker naming this agent).
   */
  bootstrap(): { id: string; state: OwnerRecordState } {
    const self = this.deps.self();
    if (!self) throw new Error('owner record bootstrap needs a machine identity (piece 3 creates it at first enrolment)');
    if (this.enrolledMarker().kind !== 'absent') throw new Error('owner record bootstrap refused: this machine was enrolled');
    // A failing record that never enrolled is replaced; name its genesis even when it no longer evaluates
    // as a genesis at all (for example, its machine key rotated out of the registry).
    const failing = this.current && this.current.status !== 'ok' && !this.current.everEnrolled
      ? (this.current.genesis ?? this.storedGenesisId()) : null;
    const body: Record<string, unknown> = { machineId: self.machineId, publicKey: self.publicKeyPem, level: 'basic', agentProducible: true, createdAt: new Date(this.now()).toISOString() };
    if (failing) body.replaces = failing;
    const g = signOwnerRecordEntry({ kind: 'genesis', agentId: this.deps.agentId, parents: [], body, signer: { type: 'machine', keyId: self.machineId } }, self.sign);
    const { state } = this.ingest([g.entry]);
    return { id: g.id, state };
  }

  /** §5's table: the one place later pieces ask what the record means right now. */
  gate(peers: PeerView): GateVerdict {
    const st = this.current;
    const marker = this.enrolledMarker();
    if (marker.kind === 'mismatch' || marker.kind === 'unreadable') {
      return { act: 'hold', enrolment: 'unknown', reason: 'enrolment-unknown', state: st };
    }
    const enrolled = marker.kind === 'ok' || peers.honouredPeerMarker || !!st?.everEnrolled;
    if (enrolled) {
      if (peers.fenceUnusable) return { act: 'hold', enrolment: 'enrolled', reason: 'fence-unusable', state: st };
      if (st && st.everEnrolled && st.status === 'ok') return { act: 'record', enrolment: 'enrolled', reason: 'ok', state: st };
      return { act: 'hold', enrolment: 'enrolled', reason: st ? `record-${st.status}` : 'record-missing', state: st };
    }
    if (st) return { act: 'basic', enrolment: 'never', reason: st.status === 'ok' ? 'basic-record' : `basic-record-${st.status}`, state: st };
    if (!this.seenMarker()) return { act: 'basic', enrolment: 'never', reason: 'no-record-yet', state: null };
    // The record was here once and is gone: unknown until every peer has answered.
    if (peers.allAnswered) return { act: 'basic', enrolment: 'never', reason: 'record-lost-peers-not-enrolled', state: null };
    return { act: 'hold', enrolment: 'unknown', reason: 'record-lost-waiting-for-peers', state: null };
  }

  // ── internals ────────────────────────────────────────────────────

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private evaluate(all: unknown[]): OwnerRecordState {
    const opts: EvaluateOptions = { agentId: this.deps.agentId, verifyFirstOwnerProof: this.deps.verifyFirstOwnerProof };
    const usable = all.filter((raw) => {
      const e = raw as Partial<OwnerRecordEntry>;
      if (e?.kind !== 'genesis') return true;
      try { return !this.excluded.has(ownerRecordEntryId(e as OwnerRecordEntry)); } catch { return true; /* @silent-fallback-ok: malformed; the evaluator rejects it */ }
    });
    if (usable.length > OWNER_RECORD_MAX_INPUT) return evaluateOwnerRecord(usable, opts); // input-too-large
    const pin = this.pinned();
    if (pin) return evaluateOwnerRecord(usable, { ...opts, pinnedGenesis: pin });
    // Unpinned (Basic): only geneses from registered machines count; an enrolled record beats a Basic one;
    // between equals 2a's tie rule (lowest machine id) decides.
    const candidates = usable.filter((raw) => {
      const e = raw as OwnerRecordEntry;
      return e?.kind === 'genesis' && typeof e.body?.machineId === 'string' && this.deps.registeredKey(e.body.machineId) === e.body.publicKey;
    }).map((raw) => ownerRecordEntryId(raw as OwnerRecordEntry));
    const geneses = [...new Set(candidates)];
    if (geneses.length === 0) return evaluateOwnerRecord(usable.filter((raw) => (raw as OwnerRecordEntry)?.kind !== 'genesis'), opts);
    const results = geneses.map((g) => evaluateOwnerRecord(usable, { ...opts, pinnedGenesis: g }));
    const machineOf = (s: OwnerRecordState): string => {
      const e = usable.find((raw) => { try { return ownerRecordEntryId(raw as OwnerRecordEntry) === s.genesis; } catch { return false; /* @silent-fallback-ok: malformed */ } }) as OwnerRecordEntry | undefined;
      return String(e?.body?.machineId ?? '');
    };
    results.sort((a, b) => (Number(b.everEnrolled) - Number(a.everEnrolled))
      || (machineOf(a) < machineOf(b) ? -1 : machineOf(a) > machineOf(b) ? 1 : 0)
      || ((a.genesis ?? '') < (b.genesis ?? '') ? -1 : 1));
    return results[0];
  }

  /** Keys this record has ever held (genesis and every add entry stored), for checking arrivals cheaply. */
  private knownKeys(): Map<string, string> {
    const keys = new Map<string, string>();
    for (const e of this.entries.values()) addKeyOf(e, keys);
    return keys;
  }

  /** Arrivals whose signature verifies against a known key, or against a key added by a verified arrival in the
   *  same batch, checked in dependency order at any depth. A genesis or a self-signed add verifies against its
   *  own body; 2a's evaluator still decides whether it counts. */
  private verifiedOnly(raw: unknown[]): unknown[] {
    const keys = this.knownKeys();
    // 2a allows a self-signed entry only as a genesis, or as the first owner key while the record has none.
    const recordHasOwnerKey = [...this.entries.values()].some((e) => e.kind === 'add-owner-key');
    const selfSignAllowed = (e: OwnerRecordEntry): boolean => {
      const introduces = (e.body as Record<string, unknown> | undefined)?.keyId ?? (e.body as Record<string, unknown> | undefined)?.machineId;
      if (e.kind === 'genesis') return true;
      return e.kind === 'add-owner-key' && introduces === e.signer?.keyId && !recordHasOwnerKey;
    };
    // Keys introduced within this batch, by the entry that introduces them (not yet verified). Every one is
    // walked (each check is memoized), and at most MAX_CANDIDATES keys that VERIFY are tried per entry, so junk
    // can't crowd out the real introducer and the signature work stays linear in the batch.
    const introducers = new Map<string, OwnerRecordEntry[]>();
    for (const r of raw) {
      const e = r as OwnerRecordEntry;
      const b = e?.body as Record<string, unknown> | undefined;
      const id = e?.kind === 'add-owner-key' ? b?.keyId : e?.kind === 'add-machine-key' || e?.kind === 'genesis' ? b?.machineId : null;
      if (typeof id === 'string') introducers.set(id, [...(introducers.get(id) ?? []), e]);
    }
    for (const [id, list] of introducers) {
      introducers.set(id, list.slice().sort((x, y) => (Number(y.signer?.type === 'owner-key') - Number(x.signer?.type === 'owner-key')) || (ownerRecordEntryIdSafe(x) < ownerRecordEntryIdSafe(y) ? -1 : 1)));
    }
    const verdict = new Map<OwnerRecordEntry, boolean>();
    const inProgress = new Set<OwnerRecordEntry>();
    // Dependency order: to check an entry, first check whatever introduced its signer's key. One signature
    // check per entry, any depth, cycle-safe.
    const check = (e: OwnerRecordEntry): boolean => {
      const done = verdict.get(e);
      if (done !== undefined) return done;
      if (inProgress.has(e) || !e || typeof e !== 'object' || typeof e.sig !== 'string' || !e.signer || typeof e.signer.keyId !== 'string') return false;
      inProgress.add(e);
      const selfSigned = selfSignAllowed(e);
      // Every candidate key is tried: the one already known, and the key of EVERY introducer that verifies.
      // Stopping at the first would let a junk self-signed add under the same key id stand in for the real one.
      const pubs = new Set<string>();
      if (selfSigned) { if (typeof e.body?.publicKey === 'string') pubs.add(e.body.publicKey); }
      else {
        const known = keys.get(e.signer.keyId);
        if (known) pubs.add(known);
        for (const intro of introducers.get(e.signer.keyId) ?? []) {
          if (pubs.size >= MAX_CANDIDATES) break;
          if (intro !== e && check(intro) && typeof intro.body?.publicKey === 'string') pubs.add(intro.body.publicKey);
        }
      }
      let ok = false;
      for (const pub of pubs) {
        try { ok = crypto.verify(null, Buffer.from(ownerRecordSignedText(e)), pub, Buffer.from(e.sig, 'base64')); } catch { ok = false; /* @silent-fallback-ok: an unparseable key or signature does not verify; the arrival is dropped */ }
        if (ok) break;
      }
      inProgress.delete(e);
      verdict.set(e, ok);
      return ok;
    };
    return raw.filter((r) => check(r as OwnerRecordEntry));
  }

  private storedGenesisId(): string | null {
    return [...this.entries.entries()].filter(([, e]) => e.kind === 'genesis').map(([id]) => id).sort()[0] ?? null;
  }

  /** A new genesis naming one it replaces: accepted only if that genesis fails and never enrolled here. */
  private applyReplacement(state: OwnerRecordState, all: unknown[]): boolean {
    if (!state.genesis) return false;
    const g = (all as OwnerRecordEntry[]).find((e) => {
      try { return e?.kind === 'genesis' && ownerRecordEntryId(e) === state.genesis; } catch { return false; /* @silent-fallback-ok: malformed */ }
    }) ?? null;
    const replaces = g?.body?.replaces;
    if (typeof replaces !== 'string' || this.excluded.has(replaces) || replaces === this.pinned()) return false;
    // Accepted only for the genesis this machine itself holds, judged here as failing and never enrolled.
    const old = this.current;
    const heldGenesis = old?.genesis ?? this.storedGenesisId();
    if (!old || heldGenesis !== replaces || old.everEnrolled || old.status === 'ok') return false;
    this.excluded.add(replaces);
    writeJsonAtomic(path.join(this.recordDir, EXCLUDED_FILE), [...this.excluded].sort());
    return true;
  }

  private afterEvaluate(): void {
    const st = this.current;
    if (!st?.genesis) return;
    if (!this.seenMarker()) this.writeMarker(SEEN_MARKER, st.genesis);
    if (st.everEnrolled) {
      if (this.enrolledMarker().kind === 'absent') this.writeMarker(ENROLLED_MARKER, st.genesis);
      if (!this.pinned()) writeJsonAtomic(path.join(this.machineDir, PIN_FILE), { agentId: this.deps.agentId, genesis: st.genesis, at: new Date(this.now()).toISOString() });
    }
  }

  private readMarker(name: string): MarkerRead {
    const file = path.join(this.machineDir, name);
    if (!fs.existsSync(file)) return { kind: 'absent' };
    const m = readJson<Marker>(file);
    if (!m || typeof m.agentId !== 'string' || typeof m.genesis !== 'string') return { kind: 'unreadable' };
    return m.agentId === this.deps.agentId ? { kind: 'ok', marker: m } : { kind: 'mismatch' };
  }

  private writeMarker(name: string, genesis: string): void {
    writeJsonAtomic(path.join(this.machineDir, name), { agentId: this.deps.agentId, machineId: this.deps.self()?.machineId ?? null, genesis, at: new Date(this.now()).toISOString() });
  }

  private persistEntries(): void {
    const lines = [...this.entries.keys()].sort().map((id) => JSON.stringify(this.entries.get(id)));
    writeFileAtomic(path.join(this.recordDir, ENTRIES_FILE), lines.join('\n') + (lines.length ? '\n' : ''));
  }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; /* @silent-fallback-ok: absent or unreadable; callers treat null as "not there" and markers as unreadable */ }
}

function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/** Record the key an entry introduces (genesis, add-machine-key, add-owner-key). Returns true if it was new. */
function addKeyOf(e: OwnerRecordEntry, keys: Map<string, string>): boolean {
  const b = e?.body as Record<string, unknown> | undefined;
  if (!b || typeof b.publicKey !== 'string') return false;
  const id = e.kind === 'genesis' || e.kind === 'add-machine-key' ? b.machineId : e.kind === 'add-owner-key' ? b.keyId : null;
  if (typeof id !== 'string' || keys.has(id)) return false;
  keys.set(id, b.publicKey);
  return true;
}

function ownerRecordEntryIdSafe(e: OwnerRecordEntry): string {
  try { return ownerRecordEntryId(e); } catch { return ''; /* @silent-fallback-ok: malformed; sorts first and fails verification anyway */ }
}
