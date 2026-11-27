/**
 * KeyedLease — the per-key fenced lock the fold transaction takes
 * (context-budget-layered-summaries §9.3 step 1, §14 "Fold lock", §18).
 *
 * The machine lease (FencedLease + LeaseCoordinator) answers "which machine is
 * awake". A fold needs a different lock: one per TOPIC, held by one hand on the
 * topic's owner, fenced by a monotonic generation, and handed from the
 * FoldCoordinator to the sentinel on quarantine WITHOUT a re-acquire (the
 * store refuses to acquire a lock it still considers held). The key is inside
 * the signed tuple (`FencedLease.canonicalizeKeyed`), so a lock for one topic
 * never verifies for another.
 *
 * This is the spec's "`LeaseStore` generalised with a key": a parallel,
 * keyed store interface with the same CAS discipline, rather than a change to
 * the single-lease `LeaseStore`, whose awake/standby lifecycle a fold lock
 * must not touch.
 *
 * Two media, one CAS rule (strict generation advance, never a force):
 *  - `local` (`LocalKeyedLeaseStore`): one file per key on this machine, its
 *    read-compare-write serialised by an exclusive lock file so two processes
 *    cannot both win, and a monotonic floor file so a lost or torn lease file
 *    can never let a generation be reused.
 *  - `git` (`GitKeyedLeaseStore`): the same files in a git-synced directory,
 *    pull-rebase before each read/CAS and a commit-and-push per step; a
 *    rejected push reverts the local write and returns the observed state.
 *
 * Authority is the generation (and, for the holder, the exact signed record),
 * never the clock: expiry only decides whether a DIFFERENT holder may acquire.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FencedLease, type KeyedLeaseRecord } from './FencedLease.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
/** A generation a real lock can reach (one per fold step, forever): anything larger is forged or corrupt, never a floor. */
const MAX_GENERATION = 1e12;
function validGeneration(n: number): boolean { return Number.isSafeInteger(n) && n > 0 && n <= MAX_GENERATION; }
export function isSafeLeaseKey(key: string): boolean { return SAFE_KEY.test(key); }

export interface KeyedLeaseView {
  lease: KeyedLeaseRecord | null;
  /** The CAS floor: the highest generation ever committed for this key. */
  generation: number;
}

export interface KeyedLeaseStore {
  read(key: string): KeyedLeaseView;
  /** Commit `candidate` iff it strictly advances the floor for its key. */
  casWrite(candidate: KeyedLeaseRecord): { ok: boolean; observed: KeyedLeaseView };
  /**
   * Same-generation expiry refresh (renewal) of `expected` → `next`. Commits
   * only if the stored record is still exactly `expected` (same signature).
   */
  refresh(expected: KeyedLeaseRecord, next: KeyedLeaseRecord): boolean;
}

/** Stale lock-file age after which a crashed writer's lock is broken. */
const STORE_LOCK_STALE_MS = 10_000;

/** `local` medium: one file per key under `dir`, plus `<key>.floor` and a transient `<key>.lock`. */
export class LocalKeyedLeaseStore implements KeyedLeaseStore {
  constructor(private readonly dir: string) {}

  fileFor(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error(`unsafe lease key: ${key}`);
    return path.join(this.dir, `${key}.json`);
  }
  private floorFile(key: string): string { return path.join(this.dir, `${key}.floor`); }
  private lockFile(key: string): string { return path.join(this.dir, `${key}.lock`); }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }

  /**
   * Run `fn` holding the per-key exclusive lock (O_EXCL create). Returns null,
   * never throws and never waits, when another writer holds it: the caller
   * reports a lost CAS and retries later. A stale lock (a crashed writer) is
   * broken by an atomic rename to a unique name first, so only one contender
   * can break it.
   */
  private withLock<T>(key: string, fn: () => T): T | null {
    this.ensureDir();
    const lf = this.lockFile(key);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(lf, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        try { return fn(); } finally {
          SafeFsExecutor.safeRmSync(lf, { force: true, operation: 'src/core/KeyedLease.ts:releaseLock' });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let stale = false;
        try { stale = Date.now() - fs.statSync(lf).mtimeMs > STORE_LOCK_STALE_MS; } catch { stale = false; }
        if (!stale) return null; // a live writer holds it
        const breaker = `${lf}.stale-${process.pid}-${Date.now()}`;
        try { fs.renameSync(lf, breaker); } catch { return null; } // another contender broke it first
        SafeFsExecutor.safeRmSync(breaker, { force: true, operation: 'src/core/KeyedLease.ts:breakStaleLock' });
      }
    }
    return null;
  }

  private readFloor(key: string): number {
    try {
      const n = Number(fs.readFileSync(this.floorFile(key), 'utf-8').trim());
      return validGeneration(n) ? n : 0;
    } catch { return 0; } // @silent-fallback-ok — no floor yet
  }

  private readRaw(key: string): KeyedLeaseRecord | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFor(key), 'utf-8')) as { lease?: KeyedLeaseRecord };
      const l = raw?.lease;
      if (l && l.key === key && validGeneration(l.generation)) return l;
    } catch {
      // @silent-fallback-ok — absent or torn lease file: no current record; the floor file still bounds reuse
    }
    return null;
  }

  private writeAtomic(file: string, body: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  read(key: string): KeyedLeaseView {
    const lease = this.readRaw(key);
    return { lease, generation: Math.max(lease?.generation ?? 0, this.readFloor(key)) };
  }

  casWrite(candidate: KeyedLeaseRecord): { ok: boolean; observed: KeyedLeaseView } {
    if (!validGeneration(candidate.generation)) return { ok: false, observed: this.read(candidate.key) };
    return this.withLock(candidate.key, () => {
      const cur = this.read(candidate.key);
      if (candidate.generation <= cur.generation) return { ok: false, observed: cur };
      // Floor first: a crash between the two writes leaves the floor ahead, never behind.
      this.writeAtomic(this.floorFile(candidate.key), String(candidate.generation));
      this.writeAtomic(this.fileFor(candidate.key), JSON.stringify({ lease: candidate }));
      return { ok: true, observed: { lease: candidate, generation: candidate.generation } };
    }) ?? { ok: false, observed: this.read(candidate.key) };
  }

  refresh(expected: KeyedLeaseRecord, next: KeyedLeaseRecord): boolean {
    if (next.key !== expected.key || next.generation !== expected.generation) return false;
    return this.withLock(expected.key, () => {
      const cur = this.read(expected.key);
      if (!cur.lease || cur.lease.signature !== expected.signature || cur.generation !== expected.generation) return false;
      this.writeAtomic(this.fileFor(expected.key), JSON.stringify({ lease: next }));
      return true;
    }) ?? false;
  }
}

export interface GitKeyedLeaseStoreDeps {
  /** Absolute directory inside the git-synced tree. */
  dir: string;
  /** Pull-rebase before reading or writing. False = the view may be stale (partition). */
  pullRebase: () => boolean;
  /**
   * Commit and push exactly these paths. On a rejected (non-fast-forward)
   * push it MUST drop its own local commit before returning false, so the
   * working tree is back at the last pushed state; `revertPath` then restores
   * the file from there.
   */
  commitAndPush: (message: string, paths: string[]) => boolean;
  /** Restore a path to the last pushed content (or remove it if it never existed there). */
  revertPath: (absPath: string) => void;
}

/** `git` medium: the same files, CAS by pull-rebase → re-read → write → push-or-revert. */
export class GitKeyedLeaseStore implements KeyedLeaseStore {
  private readonly local: LocalKeyedLeaseStore;
  constructor(private readonly d: GitKeyedLeaseStoreDeps) {
    this.local = new LocalKeyedLeaseStore(d.dir);
  }

  read(key: string): KeyedLeaseView {
    this.d.pullRebase();
    return this.local.read(key);
  }

  casWrite(candidate: KeyedLeaseRecord): { ok: boolean; observed: KeyedLeaseView } {
    // A failed pull means a stale view; the push below is what decides (a stale
    // writer is rejected as non-fast-forward), so the CAS stays sound.
    this.d.pullRebase();
    const file = this.local.fileFor(candidate.key);
    const res = this.local.casWrite(candidate);
    if (!res.ok) return res;
    if (this.d.commitAndPush(`fold-lock ${candidate.key} gen ${candidate.generation} (${candidate.role})`, [file, `${file.slice(0, -5)}.floor`])) return res;
    this.d.revertPath(file);
    this.d.revertPath(`${file.slice(0, -5)}.floor`);
    this.d.pullRebase();
    return { ok: false, observed: this.local.read(candidate.key) };
  }

  refresh(expected: KeyedLeaseRecord, next: KeyedLeaseRecord): boolean {
    this.d.pullRebase();
    if (!this.local.refresh(expected, next)) return false;
    const file = this.local.fileFor(expected.key);
    if (this.d.commitAndPush(`fold-lock ${expected.key} gen ${expected.generation} renew`, [file])) return true;
    this.d.revertPath(file);
    return false;
  }
}

export type AcquireResult =
  | { ok: true; lease: KeyedLeaseRecord }
  | { ok: false; reason: 'held' | 'cas-lost' | 'bad-key' | 'not-held-by-caller'; holder?: { holder: string; role: string; generation: number } };

export interface KeyedLeaseLockOpts {
  fenced: FencedLease;
  store: KeyedLeaseStore;
  ttlMs: number;
  now?: () => number;
}

/**
 * The lock controller. `acquire` takes a free or expired key; `handover`
 * moves a lock THIS hand holds (exact signed record) to another role with a
 * new generation (the quarantine path); `renew` refreshes the expiry at the
 * same generation; `release` writes a signed tombstone at a new generation;
 * `holds` is the fencing check. Every method on an unsafe key refuses rather
 * than throws.
 */
export class KeyedLeaseLock {
  private nonce = 0;
  constructor(private readonly o: KeyedLeaseLockOpts) {}

  private now(): number { return (this.o.now ?? Date.now)(); }
  private nextNonce(): number { this.nonce = Math.max(this.nonce + 1, this.now()); return this.nonce; }

  private live(l: KeyedLeaseRecord | null, key: string): boolean {
    if (!l || l.released === true || l.key !== key) return false;
    if (!this.o.fenced.verifyKeyedLease(l)) return false;
    const exp = Date.parse(l.expiresAt);
    return Number.isFinite(exp) && this.now() < exp;
  }

  private mint(key: string, role: string, generation: number, released = false): KeyedLeaseRecord {
    const t = this.now();
    return this.o.fenced.signKeyedLease({
      key, role, generation,
      acquiredAt: new Date(t).toISOString(),
      expiresAt: new Date(released ? t : t + this.o.ttlMs).toISOString(),
      nonce: this.nextNonce(),
      ...(released ? { released: true as const } : {}),
    });
  }

  read(key: string): KeyedLeaseView {
    return SAFE_KEY.test(key) ? this.o.store.read(key) : { lease: null, generation: 0 };
  }

  /** Take the lock for `key` as `role`. Refused while any live holder has it (including another role here). */
  acquire(key: string, role: string): AcquireResult {
    if (!SAFE_KEY.test(key)) return { ok: false, reason: 'bad-key' };
    const cur = this.o.store.read(key);
    if (this.live(cur.lease, key)) {
      const l = cur.lease!;
      return { ok: false, reason: 'held', holder: { holder: l.holder, role: l.role, generation: l.generation } };
    }
    const cand = this.mint(key, role, cur.generation + 1);
    const res = this.o.store.casWrite(cand);
    if (!res.ok) {
      const l = res.observed.lease;
      return { ok: false, reason: 'cas-lost', ...(l ? { holder: { holder: l.holder, role: l.role, generation: l.generation } } : {}) };
    }
    return { ok: true, lease: cand };
  }

  /** Is the stored record exactly `held` (same signature), ours, signed, not released? */
  private isMine(held: KeyedLeaseRecord): boolean {
    if (!SAFE_KEY.test(held.key)) return false;
    const cur = this.o.store.read(held.key);
    const l = cur.lease;
    return !!l && l.signature === held.signature && cur.generation === held.generation && l.released !== true
      && l.holder === this.o.fenced.selfMachineId && this.o.fenced.verifyKeyedLease(l);
  }

  /**
   * Hand the lock `held` (the exact record the caller holds) to `toRole` at
   * the next generation. Allowed after expiry (a hung coordinator's expired
   * lock is exactly the quarantine case), but only for the exact record the
   * caller holds, so no other hand on the machine can take a live lock.
   */
  handover(held: KeyedLeaseRecord, toRole: string): AcquireResult {
    if (!SAFE_KEY.test(held.key)) return { ok: false, reason: 'bad-key' };
    if (!this.isMine(held)) return { ok: false, reason: 'not-held-by-caller' };
    const cand = this.mint(held.key, toRole, held.generation + 1);
    const res = this.o.store.casWrite(cand);
    return res.ok ? { ok: true, lease: cand } : { ok: false, reason: 'cas-lost' };
  }

  /** Refresh the expiry of the lock `held`, same generation. Null ⇒ the caller no longer holds it. */
  renew(held: KeyedLeaseRecord): KeyedLeaseRecord | null {
    if (!this.isMine(held)) return null;
    const t = this.now();
    const renewed = this.o.fenced.signKeyedLease({
      key: held.key, role: held.role, generation: held.generation,
      acquiredAt: held.acquiredAt, expiresAt: new Date(t + this.o.ttlMs).toISOString(), nonce: this.nextNonce(),
    });
    return this.o.store.refresh(held, renewed) ? renewed : null;
  }

  /** Release: a signed tombstone at the next generation (the floor never goes down). */
  release(held: KeyedLeaseRecord): boolean {
    if (!this.isMine(held)) return false;
    return this.o.store.casWrite(this.mint(held.key, held.role, held.generation + 1, true)).ok;
  }

  /**
   * The fencing check: is `held` (the exact signed record the caller holds)
   * still the committed lock, ours, as its role, not released (and, unless
   * `allowExpired`, unexpired)? Pinning the signature means two hands can
   * never both pass, even with the same role and generation.
   */
  holds(held: KeyedLeaseRecord, opts: { allowExpired?: boolean } = {}): boolean {
    if (!this.isMine(held)) return false;
    if (opts.allowExpired) return true;
    const exp = Date.parse(held.expiresAt);
    return Number.isFinite(exp) && this.now() < exp;
  }

  /**
   * The committed record for `key` if it is ours with this role and
   * generation. For the topic's single writer only (the FoldCoordinator, and a
   * restarted process re-adopting its own fold): two callers adopting the same
   * key would both get the same record, so the caller must be the one hand.
   */
  adopt(key: string, generation: number, role: string): KeyedLeaseRecord | null {
    if (!SAFE_KEY.test(key)) return null;
    const cur = this.o.store.read(key);
    const l = cur.lease;
    if (!l || l.generation !== generation || cur.generation !== generation || l.role !== role || l.released === true) return null;
    if (l.holder !== this.o.fenced.selfMachineId || !this.o.fenced.verifyKeyedLease(l)) return null;
    return l;
  }
}
