/**
 * InFlightSyncOpMarker — the single chokepoint that records whether ANY synchronous
 * subprocess/blocking op (tmux, /bin/sleep, tunnel, any sync spawn) is in flight on
 * the event loop RIGHT NOW. This is the PRIMARY block-vs-sleep discriminator for the
 * ~0-CPU I/O-wait block that #1240's CPU check cannot see: a sync-spawn wait burns
 * ~0 CPU in the parent, so cpuBusyRatio ≈ 0 and SleepWakeDetector would otherwise fall
 * through to a FALSE wake. A drift while depth>0 (and not stale) is an event-loop BLOCK.
 *
 * Leaf module (modeled on cpuStarvation.ts): module-level functions + injectable clock,
 * imports ONLY node:fs/node:path so the lifeline process can read the cross-process
 * mirror without loading the server module graph (NO import of SleepWakeDetector /
 * SessionManager / server — zero layering cycle).
 *
 * THREE consumers:
 *   - in-process READ   — SleepWakeDetector (server process) via readSyncOpMarker()
 *   - in-process WRITE  — SessionManager sync tmux callsites via withSyncOp()
 *   - cross-process READ — ServerSupervisor (LIFELINE process, separate process — the
 *     in-memory singleton is dead across the boundary) via defaultInflightMarkerReader(stateDir),
 *     against the file mirror written on every depth transition.
 *
 * The file path + JSON shape { depth, setAtMs, timeoutMs } is the cross-process CONTRACT,
 * defined ONCE here and consumed by the reader below — a writer/reader schema divergence
 * is a silent always-`!inFlight` dead read (the #1 failure mode). Spec §B + D2.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SYNC_OP_TIMEOUT_MS = 9000; // matches (A) per-call timeout (D1)
export const STALE_TTL_FACTOR = 2; // marker older than 2× timeout ⇒ STALE (self-heal)
export const MARKER_FILENAME = 'tmux-inflight-sync-op.json'; // under <stateDir>/state/

interface MarkerState {
  depth: number;
  setAtMs: number | null;
  ttlMs: number;
  staleMarkerCount: number;
}
const state: MarkerState = {
  depth: 0,
  setAtMs: null,
  ttlMs: DEFAULT_SYNC_OP_TIMEOUT_MS * STALE_TTL_FACTOR,
  staleMarkerCount: 0,
};
let nowFn: () => number = () => Date.now();
let mirrorStateDir: string | null = null; // set once at boot; null ⇒ no file mirror
/**
 * What the mirror FILE currently says (the writer's own record of its last write). The file is
 * written on a depth transition only when the reader's answer would change, not on every op:
 * on 2026-11-13 a CPU profile of a busy server put ~11% of its wall time in this mirror's
 * writeFile+rename (two per tmux call) against ~2% in the tmux spawns it brackets.
 */
const disk = { inFlight: false, setAtMs: null as number | null, dirReady: null as string | null };
let idleFlushScheduled = false;
/** A burst of sync ops keeps one on-disk stamp; it is re-stamped once it is this fraction of the TTL old. */
export const MIRROR_RESTAMP_TTL_FRACTION = 4;

// test-only
export function __setSyncOpClock(fn: () => number): void {
  nowFn = fn;
}
export function __resetSyncOpMarker(): void {
  state.depth = 0;
  state.setAtMs = null;
  state.staleMarkerCount = 0;
  state.ttlMs = DEFAULT_SYNC_OP_TIMEOUT_MS * STALE_TTL_FACTOR;
  nowFn = () => Date.now();
  mirrorStateDir = null;
  disk.inFlight = false;
  disk.setAtMs = null;
  disk.dirReady = null;
  idleFlushScheduled = false;
}

export function configureSyncOpMarker(opts: { callTimeoutMs?: number; stateDir?: string | null }): void {
  if (opts.callTimeoutMs && Number.isFinite(opts.callTimeoutMs) && opts.callTimeoutMs > 0) {
    state.ttlMs = opts.callTimeoutMs * STALE_TTL_FACTOR;
  }
  if (opts.stateDir !== undefined) {
    mirrorStateDir = opts.stateDir;
    disk.inFlight = false; // a new mirror location has no file yet: the next enter writes it
    disk.setAtMs = null;
    disk.dirReady = null;
  }
}

/** Best-effort atomic file mirror for the cross-process reader; NEVER throws. */
function mirror(): void {
  if (!mirrorStateDir) return;
  try {
    const dir = path.join(mirrorStateDir, 'state');
    const file = path.join(dir, MARKER_FILENAME);
    if (disk.dirReady !== dir) {
      fs.mkdirSync(dir, { recursive: true });
      disk.dirReady = dir;
    }
    const payload = JSON.stringify({
      depth: state.depth,
      setAtMs: state.setAtMs,
      timeoutMs: state.ttlMs / STALE_TTL_FACTOR,
    });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file); // atomic
    disk.inFlight = state.depth > 0;
    disk.setAtMs = state.setAtMs;
  } catch {
    disk.dirReady = null; // the directory may have gone: the next write re-creates it
    // @silent-fallback-ok: the mirror is best-effort — an unwritable mirror (full disk,
    // permissions) must NEVER break a tmux call; the cross-process amplifier degrades to
    // its fail-open (reader sees no file ⇒ supervisor restarts a dead server) — the safe direction.
  }
}

function enter(): void {
  // TTL self-heal: a leaked depth (a missed leave()) older than the TTL is reset before the next op.
  if (state.depth > 0 && state.setAtMs !== null && nowFn() - state.setAtMs > state.ttlMs) {
    state.staleMarkerCount += 1;
    state.depth = 0;
    state.setAtMs = null;
  }
  const opening = state.depth === 0;
  if (opening) state.setAtMs = nowFn(); // stamp the EARLIEST open op (no advance on the 2nd enter)
  state.depth += 1;
  // The file must say "in flight" BEFORE the op blocks the loop, so this write stays synchronous.
  // It is skipped when the file already says so with a recent stamp: a nested op (the reader only
  // tests depth > 0), or the next op of a burst whose idle flush has not run yet. An older stamp
  // on disk only makes the reader call the marker stale sooner, which is its fail-open side.
  if (!opening) return;
  // A negative age (the clock stepped back) is never fresh: a future-dated stamp is rewritten.
  const diskAgeMs = disk.setAtMs === null ? -1 : state.setAtMs! - disk.setAtMs;
  const fresh = disk.inFlight && diskAgeMs >= 0 && diskAgeMs <= state.ttlMs / MIRROR_RESTAMP_TTL_FRACTION;
  if (!fresh) mirror();
}
function leave(): void {
  state.depth = Math.max(0, state.depth - 1);
  if (state.depth > 0) return;
  state.setAtMs = null;
  // "Not in flight" is written once the loop is free again, not after every op: a turn that makes
  // N sync calls costs one write here, not N.
  // MEANING OF THE FILE (changed 2026-11-13): it says in-flight for the rest of the loop turn in
  // which a marked op ran, not only while the op itself runs. Two consequences for the reader:
  //  - a loop that hangs on something unmarked right after an op reads in-flight until the stamp
  //    passes the TTL, then stale;
  //  - a turn that never yields but keeps starting marked ops (each re-stamp keeps it fresh) reads
  //    in-flight for as long as that lasts, so the supervisor defers on every check up to its own
  //    hard cap (starvationRestartThreshold, about 5 minutes) where it used to defer only on the
  //    checks that landed inside an op. The turn is still starting subprocess ops (most of its
  //    time may be unmarked JS); close to the class the deferral exists for, and accepted
  //    deliberately. The hard cap is unchanged.
  if (!disk.inFlight || idleFlushScheduled) return;
  idleFlushScheduled = true;
  setImmediate(flushSyncOpMirror);
}
/** Write the idle state now if the file still says in-flight and no op is open. Normally run from
 *  the setImmediate that leave() queues; exported for an in-process reader of the file (the
 *  server's wake handler settles the mirror before reading it) and for tests. */
export function flushSyncOpMirror(): void {
  idleFlushScheduled = false;
  if (state.depth === 0 && disk.inFlight) mirror();
}

/** The SOLE funnel: wrap every synchronous subprocess/blocking call. depth is a COUNTER (overlap-safe). */
export function withSyncOp<T>(fn: () => T): T {
  enter();
  try {
    return fn();
  } finally {
    leave();
  }
}

/** In-process read (SleepWakeDetector). TTL self-heal runs here too so a leaked marker can't permanently blind sleep detection. */
export function readSyncOpMarker(): {
  inFlight: boolean;
  depth: number;
  ageMs: number | null;
  stale: boolean;
  staleMarkerCount: number;
} {
  if (state.depth > 0 && state.setAtMs !== null) {
    const ageMs = nowFn() - state.setAtMs;
    if (ageMs > state.ttlMs) {
      state.staleMarkerCount += 1;
      state.depth = 0;
      state.setAtMs = null;
      mirror();
      return { inFlight: false, depth: 0, ageMs: null, stale: true, staleMarkerCount: state.staleMarkerCount };
    }
    return { inFlight: true, depth: state.depth, ageMs, stale: false, staleMarkerCount: state.staleMarkerCount };
  }
  return { inFlight: false, depth: 0, ageMs: null, stale: false, staleMarkerCount: state.staleMarkerCount };
}

/**
 * Cross-process reader (LIFELINE process — ServerSupervisor). NO shared memory; reads the mirror file.
 * Absent/unparseable ⇒ null ⇒ fail-OPEN (the supervisor proceeds to restart a genuinely dead server).
 */
export function defaultInflightMarkerReader(
  stateDir: string | null,
): () => { inFlight: boolean; ageMs: number; stale: boolean } | null {
  return () => {
    if (!stateDir) return null;
    try {
      const raw = fs.readFileSync(path.join(stateDir, 'state', MARKER_FILENAME), 'utf-8');
      const m = JSON.parse(raw) as { depth: number; setAtMs: number | null; timeoutMs: number };
      if (m.setAtMs == null) return { inFlight: false, ageMs: 0, stale: false };
      const ageMs = Date.now() - m.setAtMs;
      const stale = ageMs > STALE_TTL_FACTOR * (m.timeoutMs || DEFAULT_SYNC_OP_TIMEOUT_MS);
      return { inFlight: m.depth > 0 && !stale, ageMs, stale };
    } catch {
      // @silent-fallback-ok: cross-process reader fail-OPEN — an absent/unparseable mirror
      // file ⇒ null ⇒ the supervisor proceeds to restart a genuinely dead server (the safe
      // direction). A defer only ever happens on an affirmatively-present, in-flight, non-stale
      // marker; never on a read failure.
      return null;
    }
  };
}
