/**
 * SingleInstanceLock — P2 of the SIMPLE fork-bomb prevention design.
 *
 * Spec: docs/specs/forkbomb-prevention-simple.md (§P2, §D-LOCK).
 *
 * A per-agent, HOST-LOCAL lock so launchd + fleet + tmux cannot run DUPLICATE
 * server instances of the same agent — the 3× multiplier that made the
 * 2026-06-20 fork-bomb catastrophic (three concurrent server instances each
 * re-flooding `claude -p`).
 *
 * MECHANISM (mirrors ProjectRoundLock O_CREAT|O_EXCL + the ResumeQueue host-lock
 * contract):
 *   - Lock file `<stateDir>/local/server-instance.lock`, holder record =
 *     `{ pid, hostname, heartbeat }` (ms-epoch mtime-style heartbeat).
 *   - A FOREIGN-hostname lock is NEVER pid-probed or reclaimed (refuse-loud —
 *     the multi-machine shared-state-dir hazard, 2026-06-15): a legit standby on
 *     a DIFFERENT host with its own non-shared state dir boots freely.
 *   - Same-host stale reclaim is gated on a `df -P` host-local-disk confirmation
 *     (fail-closed: cannot-confirm-local → never reclaim).
 *   - DEPLOY HANDOFF (not too blunt): on finding a LIVE same-host holder, WAIT a
 *     bounded grace for it to release (a normal restart kills-then-respawns, so
 *     the outgoing holder's exit handler frees the lock) before refusing — so a
 *     clean restart hands off and only a genuine DUPLICATE (two independent
 *     supervisors racing) is refused.
 *   - Override: `INSTAR_ALLOW_SECOND_INSTANCE=1` boots a deliberate admin/debug
 *     instance without the lock.
 *
 * Release is wired by the CALLER via BOTH a `finally`/shutdown path AND a
 * process exit handler (SIGTERM/SIGINT/exit) — see `installReleaseHandlers`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SafeFsExecutor } from './SafeFsExecutor.js';
import { isAlive } from './ProjectRoundLock.js';

interface InstanceLockRecord {
  pid: number;
  hostname: string;
  heartbeat: number;
}

export interface SingleInstanceLockResult {
  acquired: boolean;
  /** Why not (when acquired=false). */
  reason?: 'duplicate-live-instance' | 'foreign-host-conflict' | 'override-bypassed';
  /** The conflicting holder (when refused on a same/foreign-host live lock). */
  currentHolder?: InstanceLockRecord;
  /** True when bypassed via INSTAR_ALLOW_SECOND_INSTANCE (acquired stays true). */
  overridden?: boolean;
}

export interface SingleInstanceLockDeps {
  /** `.instar` state dir — the lock lives under `<stateDir>/local/`. */
  stateDir: string;
  now?: () => number;
  hostname?: () => string;
  pidAlive?: (pid: number) => boolean;
  /** Host-local FS probe (tests override). */
  isStateDirHostLocal?: (stateDir: string) => boolean;
  /** Deploy-handoff grace (ms) to wait for an outgoing same-host holder. Default 8000. */
  handoffGraceMs?: number;
  /** Poll interval (ms) while waiting for handoff. Default 250. */
  pollIntervalMs?: number;
  /**
   * SINGLE-HOST-RENAME AUTO-HEAL (2026-07-08 hostname-flap wedge). When true, a
   * FOREIGN-hostname lock whose holder pid is DEAD, whose state dir is `df -P`
   * host-local, and whose heartbeat is older than `staleHostRenameMs` is treated
   * as THIS host under a previous name (an `os.hostname()` flap, e.g. mac.lan ↔
   * Justins-MacBook-Pro-99) and RECLAIMED instead of refused — the flap otherwise
   * wedges every boot. Fail-closed: any unmet condition → the normal refuse-loud.
   * Dev-agent-gated at the construction site (mirrors ResumeQueue.autoHealStaleHostLock).
   * Default false.
   */
  autoHealStaleHostRename?: boolean;
  /** Heartbeat-staleness floor (ms) for the rename auto-heal. Default 300000 (5 min). */
  staleHostRenameMs?: number;
  /** Awaitable delay (tests override). */
  sleep?: (ms: number) => Promise<void>;
  /** Override env read (tests inject). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Logger (default console.error). */
  log?: (msg: string) => void;
}

/** `df -P` host-local classifier (FAIL-CLOSED) — same contract as ResumeQueue/semaphore. */
export function isStateDirHostLocalForLock(stateDir: string): boolean {
  let out: string;
  try {
    // lint-allow-sync-spawn: a bounded (3s) one-shot host-FS classification, run
    // only at server-BOOT during single-instance-lock acquisition (never on a
    // request/event-loop path). Mirrors ResumeQueue's host-lock df -P contract.
    out = execFileSync('df', ['-P', stateDir], { timeout: 3000, encoding: 'utf-8' });
  } catch {
    // @silent-fallback-ok: df failed ⇒ cannot confirm local ⇒ fail-closed.
    return false;
  }
  const lines = out.trim().split('\n');
  if (lines.length < 2) return false;
  const source = lines[1]?.trim().split(/\s+/)[0] ?? '';
  if (!source) return false;
  if (source.startsWith('//')) return false;
  if (/^[^/][^:]*:/.test(source)) return false;
  if (source.startsWith('/dev/')) return true;
  return false;
}

export class SingleInstanceLock {
  private readonly stateDir: string;
  private readonly now: () => number;
  private readonly host: string;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly isStateDirHostLocal: (stateDir: string) => boolean;
  private readonly handoffGraceMs: number;
  private readonly pollIntervalMs: number;
  private readonly autoHealStaleHostRename: boolean;
  private readonly staleHostRenameMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (msg: string) => void;
  private held = false;

  constructor(deps: SingleInstanceLockDeps) {
    this.stateDir = deps.stateDir;
    this.now = deps.now ?? (() => Date.now());
    this.host = (deps.hostname ?? (() => os.hostname()))();
    this.pidAlive = deps.pidAlive ?? isAlive;
    this.isStateDirHostLocal = deps.isStateDirHostLocal ?? isStateDirHostLocalForLock;
    this.handoffGraceMs = deps.handoffGraceMs ?? 8000;
    this.pollIntervalMs = deps.pollIntervalMs ?? 250;
    this.autoHealStaleHostRename = deps.autoHealStaleHostRename ?? false;
    this.staleHostRenameMs = deps.staleHostRenameMs ?? 300_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? ((m) => console.error(m));
  }

  lockPath(): string {
    return path.join(this.stateDir, 'local', 'server-instance.lock');
  }

  /**
   * Try to acquire the single-instance lock. Resolves with `acquired: false`
   * (and a reason) on a genuine duplicate; `acquired: true` on success or a
   * deliberate override.
   */
  async acquire(): Promise<SingleInstanceLockResult> {
    // Operator override — a deliberate second/admin instance.
    if (this.env['INSTAR_ALLOW_SECOND_INSTANCE'] === '1') {
      this.log('[single-instance] INSTAR_ALLOW_SECOND_INSTANCE=1 — bypassing the single-instance lock (deliberate second instance).');
      // Still write our record so a LATER third instance sees a holder.
      this.tryWriteLock();
      this.held = true;
      return { acquired: true, overridden: true };
    }

    const deadline = this.now() + this.handoffGraceMs;
    for (;;) {
      const existing = this.readLock();

      if (!existing) {
        // Free — take it.
        if (this.tryWriteLock()) {
          this.held = true;
          return { acquired: true };
        }
        // Lost a creation race — loop and re-read.
        if (this.now() >= deadline) {
          return { acquired: false, reason: 'duplicate-live-instance' };
        }
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      // FOREIGN-host lock → normally NEVER reclaim (refuse-loud). A standby on
      // another host with its own non-shared state dir boots freely; this branch
      // only fires when two hosts SHARE a state dir (a misconfiguration we refuse
      // rather than corrupt) — OR when THIS host's `os.hostname()` FLAPPED and a
      // dead-holder lock stamped with the old name now looks foreign (the
      // 2026-07-08 wedge: mac.lan ↔ Justins-MacBook-Pro-99 crash-looped every boot).
      if (existing.hostname && existing.hostname !== this.host) {
        // SINGLE-HOST-RENAME AUTO-HEAL (dev-agent-gated). A "foreign" lock is
        // provably THIS host under a previous name — NOT a shared volume — iff
        // ALL hold: the flag is on, the holder pid is DEAD on this host, the
        // heartbeat is genuinely STALE, and the state dir is `df -P` host-local
        // (the load-bearing guard: a host-local disk cannot be shared by a second
        // host). Fail-closed: any unmet condition falls through to refuse-loud.
        const holderDead = !this.pidAlive(existing.pid);
        const hbStale =
          typeof existing.heartbeat === 'number' &&
          existing.heartbeat > 0 &&
          this.now() - existing.heartbeat > this.staleHostRenameMs;
        if (
          this.autoHealStaleHostRename &&
          holderDead &&
          hbStale &&
          this.isStateDirHostLocal(this.stateDir)
        ) {
          this.log(
            `[single-instance] AUTO-HEAL single-host rename: lock hostname "${existing.hostname}" != this host ` +
            `"${this.host}", but the state dir is host-local (df -P), holder pid ${existing.pid} is dead, and its ` +
            `heartbeat is ${this.now() - existing.heartbeat}ms stale — treating as an os.hostname() flap on THIS ` +
            `host and reclaiming the stale lock (NOT a shared-volume conflict).`,
          );
          // Fall through to the same-host-DEAD reclaim path below (it re-verifies
          // dead + host-local, then unlinks + rewrites) — no duplicated logic.
        } else {
          this.log(
            `[single-instance] lock held by FOREIGN host "${existing.hostname}" (this host "${this.host}"). ` +
            `Refusing — the state dir must be host-local; a shared volume is unsupported. ` +
            `If this is a deliberate second instance, set INSTAR_ALLOW_SECOND_INSTANCE=1.`,
          );
          return { acquired: false, reason: 'foreign-host-conflict', currentHolder: existing };
        }
      }

      // Same-host lock (or an auto-heal-approved single-host rename). Is the holder alive?
      if (this.pidAlive(existing.pid)) {
        // A LIVE same-host holder. Could be a normal restart's outgoing instance
        // (it will exit + release shortly) OR a genuine duplicate. Wait a bounded
        // grace for a handoff before refusing.
        if (this.now() >= deadline) {
          this.log(
            `[single-instance] refusing to start: a LIVE instance (pid ${existing.pid}) of this agent is already ` +
            `running on this host after a ${this.handoffGraceMs}ms handoff grace. This is the duplicate-flood guard. ` +
            `If this is intentional, set INSTAR_ALLOW_SECOND_INSTANCE=1.`,
          );
          return { acquired: false, reason: 'duplicate-live-instance', currentHolder: existing };
        }
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      // Same-host DEAD holder — reclaim ONLY on a host-local-disk confirmation.
      if (!this.isStateDirHostLocal(this.stateDir)) {
        this.log(
          `[single-instance] same-host lock holder (pid ${existing.pid}) is dead, but the state dir could not be ` +
          `confirmed host-local (df -P) — refusing to reclaim (fail-closed). Set INSTAR_ALLOW_SECOND_INSTANCE=1 to override.`,
        );
        return { acquired: false, reason: 'foreign-host-conflict', currentHolder: existing };
      }
      // Reclaim the stale lock atomically and take it.
      try {
        SafeFsExecutor.safeUnlinkSync(this.lockPath(), { operation: 'SingleInstanceLock.acquire:reclaim-stale' });
      } catch {
        /* race with another reclaimer — loop and re-read */
      }
      if (this.tryWriteLock()) {
        this.held = true;
        this.log(`[single-instance] reclaimed a stale same-host lock (dead pid ${existing.pid}).`);
        return { acquired: true };
      }
      if (this.now() >= deadline) {
        return { acquired: false, reason: 'duplicate-live-instance', currentHolder: existing };
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** Refresh the heartbeat (optional — the lock is primarily pid-guarded). */
  heartbeat(): void {
    if (!this.held) return;
    const rec = this.readLock();
    if (rec && rec.pid === process.pid && rec.hostname === this.host) {
      rec.heartbeat = this.now();
      try {
        fs.writeFileSync(this.lockPath(), JSON.stringify(rec), 'utf-8');
      } catch {
        /* best-effort */
      }
    }
  }

  /** Release the lock — ONLY if WE still hold it (pid+host match). Idempotent. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    const rec = this.readLock();
    if (!rec) return;
    if (rec.pid !== process.pid || rec.hostname !== this.host) {
      // A successor already took it — never delete someone else's lock.
      return;
    }
    try {
      SafeFsExecutor.safeUnlinkSync(this.lockPath(), { operation: 'SingleInstanceLock.release' });
    } catch {
      /* @silent-fallback-ok: the lock is already gone — release is idempotent */
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private readLock(): InstanceLockRecord | null {
    try {
      const raw = fs.readFileSync(this.lockPath(), 'utf-8');
      const obj = JSON.parse(raw);
      if (typeof obj?.pid !== 'number') return null;
      if (typeof obj?.hostname !== 'string') return null;
      const heartbeat = typeof obj?.heartbeat === 'number' ? obj.heartbeat : 0;
      return { pid: obj.pid, hostname: obj.hostname, heartbeat };
    } catch {
      // @silent-fallback-ok: a missing/corrupt lock file reads as "no holder"
      // (null) — the acquire loop then treats the slot as free, the safe direction.
      return null;
    }
  }

  /** Atomic O_CREAT|O_EXCL write. Returns false if another writer won the race. */
  private tryWriteLock(): boolean {
    this.ensureDir();
    const rec: InstanceLockRecord = { pid: process.pid, hostname: this.host, heartbeat: this.now() };
    const body = JSON.stringify(rec);
    const tmp = `${this.lockPath()}.tmp.${process.pid}`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeSync(fd, body);
      fs.closeSync(fd);
    } catch {
      // @silent-fallback-ok: a tmp-file write race ⇒ report "did not acquire"
      // (false); the acquire loop re-reads and retries — never a silent grant.
      try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'SingleInstanceLock.tryWriteLock:cleanup-tmp' }); } catch { /* @silent-fallback-ok: tmp cleanup is best-effort */ }
      return false;
    }
    // Use link()/rename guarded by an O_EXCL pre-check: rename would clobber an
    // existing lock, so only rename when the target does NOT exist. The window
    // is narrow; a clobber would only happen between two simultaneous fresh
    // starts, and the pid-guarded release prevents deleting the winner's lock.
    try {
      if (fs.existsSync(this.lockPath())) {
        // Someone created the lock between our read and now — back off.
        try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'SingleInstanceLock.tryWriteLock:exists-backoff' }); } catch { /* @silent-fallback-ok: tmp cleanup is best-effort */ }
        return false;
      }
      fs.renameSync(tmp, this.lockPath());
      return true;
    } catch {
      // @silent-fallback-ok: a rename race ⇒ report "did not acquire" (false);
      // the acquire loop re-reads and retries — never a silent grant past the cap.
      try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'SingleInstanceLock.tryWriteLock:cleanup-tmp' }); } catch { /* @silent-fallback-ok: tmp cleanup is best-effort */ }
      return false;
    }
  }

  private ensureDir(): void {
    const localDir = path.join(this.stateDir, 'local');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
  }
}

/**
 * Wire release on every exit path (SIGTERM/SIGINT/exit). The caller's graceful
 * shutdown should ALSO call `lock.release()` directly (belt-and-suspenders); the
 * `exit` handler is the last-resort net for a hard exit. Returns a disposer that
 * removes the handlers (rarely needed; useful in tests).
 */
export function installReleaseHandlers(lock: SingleInstanceLock): () => void {
  const onExit = (): void => {
    try { lock.release(); } catch { /* best-effort on teardown */ }
  };
  // 'exit' must be synchronous — release() is sync, so this is safe.
  process.on('exit', onExit);
  // SIGTERM/SIGINT: the server already installs its own graceful shutdown that
  // exits the process, which fires 'exit'. We add direct handlers too so the
  // lock frees even if some other SIGTERM handler exits first.
  const onSignal = (): void => { onExit(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return () => {
    process.off('exit', onExit);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
}
