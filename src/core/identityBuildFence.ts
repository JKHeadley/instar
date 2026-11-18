/**
 * The minimum-build fence (identity-security piece 2c).
 *
 * Machines too old to follow the identity rules are waited for before enrolment, and after enrolment they
 * can't join, can't be rolled back into, and don't get the owner record. Refusing them the lease and
 * routing is piece 2d. Nothing here refuses anything until the record is enrolled at a level with a floor.
 *
 * Spec: docs/specs/identity-security-piece2c-minimum-build-fence.md
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { versionAtLeast } from './poolSignedReads.js';
import type { OwnerRecordState } from './ownerRecord.js';

/**
 * §1: for each level, the earliest release whose tests prove it enforces that level's rules. Each piece that
 * adds rules for a level updates its row in the same change, with the test that proves it. Basic has no fence.
 */
export const IDENTITY_LEVEL_MIN_BUILD: Readonly<Record<string, string | null>> = Object.freeze({
  basic: null,
});

/** How long a peer's signed statement stays fresh: four full 6-hour backoff cycles of a pulling peer (§2). */
export const BUILD_STATEMENT_FRESH_MS = 24 * 60 * 60 * 1000;
/** Piece 2d §2: each updated machine takes the lease from a given below machine at most this often per day. */
export const BELOW_FENCE_TAKEOVER_BUDGET = 3;

export type PeerBuildState = 'confirmed' | 'below' | 'unconfirmed' | 'retired';

const LEDGERS = new Map<string, PeerBuildLedger>();
/** Tests: forget the shared ledger instances. */
export function resetPeerBuildLedgersForTests(): void { LEDGERS.clear(); }

export function isValidBuild(v: unknown): v is string {
  return typeof v === 'string' && versionAtLeast(v, '0.0.0');
}

/** A machine's signing-key fingerprint: observations are kept per registration (machine id + key). */
export function keyFingerprint(publicKeyPem: string | null): string {
  return publicKeyPem ? crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16) : 'none';
}

/** §1: a write is valid only if it parses and is at or above the active level's floor. */
export function validateFenceWrite(level: string, value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isValidBuild(value)) return { ok: false, reason: 'unparseable-build' };
  const floor = IDENTITY_LEVEL_MIN_BUILD[level] ?? null;
  if (floor && !versionAtLeast(value, floor)) return { ok: false, reason: `below-level-floor:${floor}` };
  return { ok: true };
}

export interface FenceInForce {
  /** The fence in force, or null when none applies (Basic, never enrolled, or no value set). */
  value: string | null;
  source: 'none' | 'record' | 'last-verified';
  /** Enrolled, a value was set, but neither it nor any last verified fence is usable: hold (§1). */
  unusable: boolean;
  /** A newer build's floor for the active level is above the fence: the owner should be offered a raise. */
  raiseDue: string | null;
  /** The record's `minimumBuild` was set but can't be parsed, so it was ignored: reported once. */
  badValue: string | null;
}

interface Observation { machineId: string; key: string; build: string | null; guards: string[]; at: number }
interface LedgerFile { observations: Observation[]; lastVerifiedFence: string | null; lastNotice: { at: number; list: string } | null; createdAt: number; takeovers?: Record<string, number[]> }

/**
 * §2: each peer's last signed build statement, per registration, saved across restarts in a key-material path.
 * An observation never overwrites a newer one; "below" sticks until a newer statement at or above the fence.
 */
export class PeerBuildLedger {
  private data: LedgerFile;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.data = this.read();
  }

  /** One shared instance per ledger file: several writers each holding their own copy would overwrite each
   *  other's counts (piece 2d's takeover budget is the case that broke). */
  static at(stateDir: string, now?: () => number): PeerBuildLedger {
    const file = path.join(stateDir, 'state', 'owner-record', 'peer-builds.json');
    let l = LEDGERS.get(file);
    if (!l) { l = new PeerBuildLedger(file, now); LEDGERS.set(file, l); }
    return l;
  }

  /** Record a signed statement. `build` null means the peer pulled with no build field (a 2b-only build). */
  record(machineId: string, key: string, build: unknown, guards: unknown, at: number): void {
    const b = typeof build === 'string' ? build.slice(0, 64) : null;
    const g = Array.isArray(guards) ? guards.filter((x): x is string => typeof x === 'string').slice(0, 32).map((x) => x.slice(0, 64)) : [];
    const prev = this.data.observations.find((o) => o.machineId === machineId && o.key === key);
    if (prev && prev.at > at) return; // never overwritten by an older statement
    this.data.observations = this.data.observations.filter((o) => !(o.machineId === machineId && o.key === key));
    this.data.observations.push({ machineId, key, build: b, guards: g, at });
    if (this.data.observations.length > 256) this.data.observations = this.data.observations.sort((x, y) => y.at - x.at).slice(0, 256);
    this.write();
  }

  observation(machineId: string, key: string): Observation | null {
    return this.data.observations.find((o) => o.machineId === machineId && o.key === key) ?? null;
  }

  /** §2's four states against a fence (null fence: anything heard counts as confirmed). */
  stateOf(machineId: string, key: string, fence: string | null): PeerBuildState {
    const o = this.observation(machineId, key);
    if (!o) return 'unconfirmed';
    const at = o.build !== null && (fence === null || versionAtLeast(o.build, fence));
    if (!at) return 'below'; // sticky: only a newer statement at or above the fence changes it
    return this.now() - o.at <= BUILD_STATEMENT_FRESH_MS ? 'confirmed' : 'unconfirmed';
  }

  guardsOf(machineId: string, key: string): string[] {
    return this.observation(machineId, key)?.guards ?? [];
  }

  lastVerifiedFence(): string | null { return this.data.lastVerifiedFence; }
  /** When this ledger began watching: a peer never heard from counts as long-unconfirmed only after a day of it. */
  watchingSince(): number { return this.data.createdAt; }
  clearLastVerifiedFence(): void {
    if (this.data.lastVerifiedFence === null) return;
    this.data.lastVerifiedFence = null;
    this.write();
  }
  setLastVerifiedFence(v: string): void {
    if (this.data.lastVerifiedFence === v) return;
    this.data.lastVerifiedFence = v;
    this.write();
  }

  /** §4: one aggregated notice per distinct list, never repeated while the list is unchanged; it survives a
   *  lease move because the list is saved here. */
  noticeDue(list: string[]): boolean {
    if (list.length === 0) return false;
    const key = list.slice().sort().join(',');
    if (this.data.lastNotice?.list === key) return false;
    this.data.lastNotice = { at: this.now(), list: key };
    this.write();
    return true;
  }

  /** Piece 2d §2: takeovers of a below holder, at most TAKEOVER_BUDGET per machine per 24 hours. */
  takeoverAllowed(machineId: string): boolean {
    const recent = (this.data.takeovers?.[machineId] ?? []).filter((t) => this.now() - t < 24 * 60 * 60 * 1000);
    return recent.length < BELOW_FENCE_TAKEOVER_BUDGET;
  }
  noteTakeover(machineId: string): void {
    const all = this.data.takeovers ?? {};
    all[machineId] = [...(all[machineId] ?? []).filter((t) => this.now() - t < 24 * 60 * 60 * 1000), this.now()];
    this.data.takeovers = all;
    this.write();
  }

  /** The list emptied: forget the last notice, and say whether one was open (so it can be closed). */
  clearNoticeIfOpen(): boolean {
    if (!this.data.lastNotice) return false;
    this.data.lastNotice = null;
    this.write();
    return true;
  }

  private read(): LedgerFile {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LedgerFile>;
      return {
        observations: Array.isArray(d.observations) ? d.observations.filter((o) => o && typeof o.machineId === 'string' && typeof o.key === 'string' && typeof o.at === 'number') : [],
        lastVerifiedFence: isValidBuild(d.lastVerifiedFence) ? d.lastVerifiedFence : null,
        lastNotice: d.lastNotice && typeof d.lastNotice.at === 'number' && typeof d.lastNotice.list === 'string' ? d.lastNotice : null,
        createdAt: typeof d.createdAt === 'number' ? d.createdAt : this.now(),
        takeovers: d.takeovers && typeof d.takeovers === 'object' ? d.takeovers : {},
      };
    } catch { return { observations: [], lastVerifiedFence: null, lastNotice: null, createdAt: this.now() }; /* @silent-fallback-ok: absent or unreadable ledger starts empty; every peer reads unconfirmed, which refuses nothing and keeps readiness false */ }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/**
 * §1: the fence in force is the record's `minimumBuild` (or the last verified one). It applies only once the
 * record is enrolled at a level other than Basic. The code table never raises it by itself.
 */
export function fenceInForce(state: OwnerRecordState | null, ledger: PeerBuildLedger): FenceInForce {
  const last = ledger.lastVerifiedFence();
  const keepLast = (): FenceInForce => ({ value: last, source: last ? 'last-verified' : 'none', unusable: false, raiseDue: null, badValue: null });
  // Only a record that evaluates `ok` may set or clear the saved fence. A lost, invalid, contested or over-bound
  // record never relaxes it: the last verified fence stays in force.
  if (!state || state.status !== 'ok') return keepLast();
  if (!state.everEnrolled) return keepLast(); // a Basic record that never enrolled: keep any fence a lost enrolled record left
  if (state.level === 'basic') { ledger.clearLastVerifiedFence(); return { value: null, source: 'none', unusable: false, raiseDue: null, badValue: null }; } // the owner lowered the level
  const level = state.level;
  const raw = state.policies.minimumBuild;
  const floor = IDENTITY_LEVEL_MIN_BUILD[level] ?? null;
  if (raw !== undefined && isValidBuild(raw)) {
    // A parseable value is in force even below this build's floor for the level (an older writer set it); the
    // owner is then offered a raise to the floor. Only the write path refuses below-floor values.
    ledger.setLastVerifiedFence(raw);
    return { value: raw, source: 'record', unusable: false, raiseDue: floor && !versionAtLeast(raw, floor) ? floor : null, badValue: null };
  }
  const badValue = raw !== undefined ? String(raw).slice(0, 64) : null;
  if (last) return { value: last, source: 'last-verified', unusable: false, raiseDue: null, badValue };
  return { value: null, source: 'none', unusable: raw !== undefined, raiseDue: floor, badValue };
}

export interface FenceStatus {
  target: string;
  confirmed: string[];
  below: string[];
  unconfirmed: string[];
  ready: boolean;
}

/** §3: on the lease holder, from its own first-hand observations, over every registered machine (this one too). */
export function fenceStatus(target: string, peers: Array<{ machineId: string; key: string }>, ledger: PeerBuildLedger, self?: { machineId: string; build: string }): FenceStatus {
  const out: FenceStatus = { target, confirmed: [], below: [], unconfirmed: [], ready: false };
  if (self) (versionAtLeast(self.build, target) ? out.confirmed : out.below).push(self.machineId); // every registered machine, this one too
  for (const p of peers) {
    const s = ledger.stateOf(p.machineId, p.key, target);
    if (s === 'confirmed') out.confirmed.push(p.machineId);
    else if (s === 'below') out.below.push(p.machineId);
    else if (s === 'unconfirmed') out.unconfirmed.push(p.machineId);
  }
  out.ready = isValidBuild(target) && out.below.length === 0 && out.unconfirmed.length === 0;
  return out;
}

/** §4: the join and rollback checks — a build below the fence in force is refused, naming the build needed. */
export function belowFence(build: unknown, fence: string | null): { refused: false } | { refused: true; needed: string } {
  if (!fence) return { refused: false };
  return typeof build === 'string' && versionAtLeast(build, fence) ? { refused: false } : { refused: true, needed: fence };
}

/** The fence a join or rollback must respect: read from the ledger file without the full sync machinery. */
export function lastVerifiedFenceAt(stateDir: string): string | null {
  return PeerBuildLedger.at(stateDir).lastVerifiedFence();
}
