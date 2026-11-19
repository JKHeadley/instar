/**
 * Server side of the reference builder (spec docs/specs/reaper-node-modules-regenerable.md §1, §3).
 *
 * After each reaper pass (dry-run worker or live reclaim child), the reaper hands
 * this the pass's node_modules summary. It:
 *   - deletes manifests no remaining checkout uses, and manifests unused for 14 days;
 *   - starts at most ONE build per pass, never while a reclaim run is active and
 *     never while a build is running;
 *   - keeps at most 30 manifests: at the cap the least recently used manifest no
 *     eligible checkout needs is evicted first; when every kept one is needed, no
 *     build starts and the checkouts read `unchecked`;
 *   - refuses to build below 3 GB free;
 *   - retries a key that failed for missing npm cache entries once a day, and
 *     other failures after 1, 2 and 4 days and then weekly (a new key — changed
 *     inputs — is built at once);
 *   - kills a build past 6 minutes by process group, records the cause, and
 *     deletes its scratch folder on every exit.
 * All file work here is asynchronous and small; the build itself runs in the
 * niced child (agentWorktreeReferenceBuildMain.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type { ReferenceBuilderPort } from './AgentWorktreeReaper.js';
import { readBuildStatus, REFERENCE_KEY, type BuildFailureCause, type BuildStatusEntry, type BuildStatusFile, type NodeModulesPassSummary } from './agentWorktreeNodeModules.js';
import { scratchRoot, type ReferenceBuildInput, type ReferenceBuildResult } from './agentWorktreeReferenceBuildMain.js';

const OP = 'src/monitoring/agentWorktreeReferenceBuilder.ts';
const DAY = 24 * 3_600_000;

export const REFERENCE_BUILD_DEFAULTS = {
  timeoutMs: 6 * 60_000,
  freeFloorBytes: 3 * 1024 ** 3,
  scratchCeilingBytes: 2 * 1024 ** 3,
  maxManifests: 30,
  retentionMs: 14 * DAY,
} as const;

/** Back-off after a failed build (spec §3 "Brakes on failed builds"). Pure; the self-action model drives it. */
export function nextBuildAttemptAt(prev: BuildStatusEntry | undefined, cause: BuildFailureCause, now: number): BuildStatusEntry {
  const failures = (prev?.failures ?? 0) + 1;
  // A missing cache entry fails within seconds: retried once a day (sessions' own installs refill the cache).
  const delay = cause === 'npm-cache-missing' ? DAY : ([DAY, 2 * DAY, 4 * DAY][failures - 1] ?? 7 * DAY);
  return { failures, lastAt: now, cause, nextAt: now + delay };
}

/** Which needed key to build now, or null. Pure. */
export function chooseBuildKey(needed: NodeModulesPassSummary['needed'], status: BuildStatusFile, haveManifest: ReadonlySet<string>, now: number): { key: string; sourceCheckout: string } | null {
  for (const n of [...needed].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (haveManifest.has(n.key)) continue;
    const st = status.keys[n.key];
    if (st && now < st.nextAt) continue;
    return n;
  }
  return null;
}

/**
 * Housekeeping and the cap (spec §3 "What stays on disk, capped"). Pure. Returns
 * the manifests to delete and whether a new one may be built.
 */
export function planManifests(
  manifests: ReadonlyArray<{ key: string; lastUsedAt: number }>,
  pass: Pick<NodeModulesPassSummary, 'keysInUse' | 'eligibleKeys'>,
  opts: { now: number; maxManifests: number; retentionMs: number; building?: string | null },
): { remove: string[]; roomForOne: boolean } {
  const inUse = new Set(pass.keysInUse);
  const needed = new Set(pass.eligibleKeys);
  const remove: string[] = [];
  const kept: Array<{ key: string; lastUsedAt: number }> = [];
  for (const m of manifests) {
    if (m.key === opts.building) { kept.push(m); continue; }
    if (!inUse.has(m.key) || opts.now - m.lastUsedAt > opts.retentionMs) remove.push(m.key);
    else kept.push(m);
  }
  if (kept.length < opts.maxManifests) return { remove, roomForOne: true };
  // At the cap: the least recently used manifest no eligible checkout needs goes first.
  const evictable = kept.filter((m) => !needed.has(m.key)).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const over = kept.length - opts.maxManifests + 1;
  if (evictable.length < over) return { remove, roomForOne: false };
  remove.push(...evictable.slice(0, over).map((m) => m.key));
  return { remove, roomForOne: true };
}

export interface ReferenceBuilderConfig {
  refsDir: string;
  /** The child's working folder (its audit trail lands in `<cwd>/.instar/audit`): the agent home. */
  agentHome: string;
  mainScript: string;
  nodePath: string;
  npmPath?: string;
  npmCacheDir?: string;
  timeoutMs?: number;
  freeFloorBytes?: number;
  scratchCeilingBytes?: number;
  maxManifests?: number;
  retentionMs?: number;
}

export interface ReferenceBuilderSeams {
  /** Spawn the build child detached in its own process group; `onExit` fires once. */
  spawnChild(args: string[], cwd: string, onExit: () => void): { pid: number | undefined };
  killGroup(pgid: number, signal: NodeJS.Signals): void;
  freeBytes(dir: string): Promise<number | null>;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

export function realReferenceBuilderSeams(nodePath: string = process.execPath): ReferenceBuilderSeams {
  return {
    spawnChild: (args, cwd, onExit) => {
      const useNice = process.platform !== 'win32';
      const child = spawn(useNice ? 'nice' : nodePath, useNice ? ['-n', '10', nodePath, ...args] : args, { detached: true, stdio: 'ignore', cwd });
      child.once('exit', () => onExit());
      child.once('error', () => onExit());
      child.unref();
      return { pid: child.pid };
    },
    killGroup: (pgid, signal) => { process.kill(-pgid, signal); },
    freeBytes: async (dir) => {
      let d = path.resolve(dir);
      for (;;) {
        try { const st = await fs.promises.statfs(d); return Number(st.bavail) * Number(st.bsize); }
        catch { const up = path.dirname(d); if (up === d) return null; d = up; } // @silent-fallback-ok — unknown ⇒ no build
      }
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; },
  };
}

export class AgentWorktreeReferenceBuilder implements ReferenceBuilderPort {
  private running: { key: string; buildId: string; startedAt: number; pgid: number; timer: { cancel(): void }; timedOut: boolean; resultPath: string } | null = null;
  private lastOutcome: { key: string; ok: boolean; cause?: string; at: number } | null = null;
  private highWater = 0;

  constructor(private readonly cfg: ReferenceBuilderConfig, private readonly seams: ReferenceBuilderSeams = realReferenceBuilderSeams(cfg.nodePath)) {}

  private get statusPath(): string { return path.join(this.cfg.refsDir, 'status.json'); }

  status(): ReturnType<ReferenceBuilderPort['status']> {
    const st = readStatusQuiet(this.cfg.refsDir);
    const failures: Record<string, { failures: number; cause: string; nextAt: number }> = {};
    for (const [k, v] of Object.entries(st.keys)) failures[k] = { failures: v.failures, cause: v.cause, nextAt: v.nextAt };
    return {
      running: this.running ? { key: this.running.key, startedAt: this.running.startedAt } : null,
      lastOutcome: this.lastOutcome,
      scratchHighWaterBytes: Math.max(this.highWater, st.scratchHighWaterBytes),
      failures,
    };
  }

  async afterPass(pass: NodeModulesPassSummary, ctx: { reclaimRunActive: boolean }): Promise<{ started: boolean; reason: string; key?: string }> {
    const now = this.seams.now();
    const manifests = await listManifestsAsync(this.cfg.refsDir);
    const plan = planManifests(manifests, pass, {
      now, maxManifests: this.cfg.maxManifests ?? REFERENCE_BUILD_DEFAULTS.maxManifests,
      retentionMs: this.cfg.retentionMs ?? REFERENCE_BUILD_DEFAULTS.retentionMs, building: this.running?.key ?? null,
    });
    for (const key of plan.remove) {
      try { await SafeFsExecutor.safeUnlink(path.join(this.cfg.refsDir, 'manifests', `${key}.json`), { operation: `${OP}:manifest-cleanup` }); }
      catch { /* @silent-fallback-ok — a manifest that cannot be deleted is retried next pass; it never passes a checkout it does not match */ }
    }
    /* @self-action-controller: worktree-reference-build-spawn */
    if (this.running) return { started: false, reason: 'build-running' };
    if (ctx.reclaimRunActive) return { started: false, reason: 'reclaim-run-active' };
    const have = new Set(manifests.map((m) => m.key).filter((k) => !plan.remove.includes(k)));
    const status = readStatusQuiet(this.cfg.refsDir);
    const pick = chooseBuildKey(pass.needed, status, have, now);
    if (!pick) return { started: false, reason: 'nothing-needed' };
    if (!plan.roomForOne) return { started: false, reason: 'manifest-cap' };
    if (!pass.npmMajor) return { started: false, reason: 'npm-version-unknown' };
    const free = await this.seams.freeBytes(this.cfg.refsDir);
    if (free === null || free < (this.cfg.freeFloorBytes ?? REFERENCE_BUILD_DEFAULTS.freeFloorBytes)) return { started: false, reason: 'below-free-floor' };
    return this.start(pick, pass.npmMajor);
  }

  private start(pick: { key: string; sourceCheckout: string }, npmMajor: string): { started: boolean; reason: string; key?: string } {
    const buildId = crypto.randomBytes(16).toString('hex');
    const timeoutMs = this.cfg.timeoutMs ?? REFERENCE_BUILD_DEFAULTS.timeoutMs;
    const resultPath = path.join(this.cfg.refsDir, 'results', `${buildId}.json`);
    const input: ReferenceBuildInput = {
      buildId, key: pick.key, sourceCheckout: pick.sourceCheckout, refsDir: this.cfg.refsDir, npmMajor,
      ...(this.cfg.npmPath ? { npmPath: this.cfg.npmPath } : {}),
      ...(this.cfg.npmCacheDir ? { npmCacheDir: this.cfg.npmCacheDir } : {}),
      scratchCeilingBytes: this.cfg.scratchCeilingBytes ?? REFERENCE_BUILD_DEFAULTS.scratchCeilingBytes,
      timeoutMs, resultPath,
    };
    let child: { pid: number | undefined };
    try { child = this.seams.spawnChild([this.cfg.mainScript, '--input-json', JSON.stringify(input)], this.cfg.agentHome, () => { void this.finish(buildId); }); }
    catch { child = { pid: undefined }; } // @silent-fallback-ok — recorded as a failed start below
    if (!child.pid) {
      this.recordFailure(pick.key, 'build-error', 'spawn failed');
      return { started: false, reason: 'spawn-failed' };
    }
    const pgid = child.pid;
    // Its own timeout, killed by process group: SIGTERM, then SIGKILL.
    const timer = this.seams.setTimer(() => {
      if (!this.running || this.running.buildId !== buildId) return;
      this.running.timedOut = true;
      try { this.seams.killGroup(pgid, 'SIGTERM'); } catch { /* @silent-fallback-ok — already gone */ }
      this.seams.setTimer(() => { try { this.seams.killGroup(pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok — already gone */ } }, 5_000);
    }, timeoutMs);
    this.running = { key: pick.key, buildId, startedAt: this.seams.now(), pgid, timer, timedOut: false, resultPath };
    return { started: true, reason: 'started', key: pick.key };
  }

  /** The child exited (or was killed): read its result, update the retry status, delete scratch. */
  async finish(buildId: string): Promise<void> {
    const run = this.running;
    if (!run || run.buildId !== buildId) return;
    run.timer.cancel();
    // `running` is cleared only at the very end (finally): until the outcome is recorded
    // and scratch is deleted, no new build may start, or this cleanup could delete the
    // next build's scratch, and status would read "idle" with no outcome yet.
    try {
    let r: ReferenceBuildResult | null = null;
    try { r = JSON.parse(await fs.promises.readFile(run.resultPath, 'utf8')) as ReferenceBuildResult; }
    catch { r = null; } // @silent-fallback-ok — no result ⇒ recorded as killed / timed out below
    if (r && r.scratchHighWaterBytes > this.highWater) this.highWater = r.scratchHighWaterBytes;
    const at = this.seams.now();
    if (r && r.ok && !run.timedOut) {
      this.lastOutcome = { key: run.key, ok: true, at };
      this.clearFailure(run.key);
    } else {
      const cause: BuildFailureCause = run.timedOut ? 'timeout' : r?.cause && r.cause !== 'busy' ? r.cause : 'killed';
      this.lastOutcome = { key: run.key, ok: false, cause, at };
      // 'busy' (an orphaned build from before a restart holds the lock) is not this key's failure.
      if (r?.cause !== 'busy') this.recordFailure(run.key, cause, r?.error);
    }
    // Scratch is deleted on every exit, also when the child was killed before its own cleanup.
    const scratch = scratchRoot(this.cfg.refsDir);
    try { if (fs.existsSync(scratch)) await SafeFsExecutor.safeRmTreeSerial(scratch, { operation: `${OP}:scratch-cleanup` }); }
    catch { /* @silent-fallback-ok — the next build deletes leftover scratch first */ }
    try { await SafeFsExecutor.safeUnlink(run.resultPath, { operation: `${OP}:result-cleanup` }); }
    catch { /* @silent-fallback-ok — a stale result file is never read again (keyed by build id) */ }
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  private writeStatus(mut: (s: BuildStatusFile) => void): void {
    const st = readStatusQuiet(this.cfg.refsDir);
    mut(st);
    st.scratchHighWaterBytes = Math.max(st.scratchHighWaterBytes, this.highWater);
    try { SafeFsExecutor.atomicWriteJsonSync(this.statusPath, st, { operation: `${OP}:status`, mode: 0o600, indent: 0 }); }
    catch { /* @silent-fallback-ok — an unwritten status only means the key is retried sooner; every retry stays one build per pass */ }
  }

  private recordFailure(key: string, cause: BuildFailureCause, error?: string): void {
    this.writeStatus((s) => { s.keys[key] = { ...nextBuildAttemptAt(s.keys[key], cause, this.seams.now()), ...(error ? { error: error.slice(0, 300) } : {}) }; });
  }

  private clearFailure(key: string): void {
    this.writeStatus((s) => { delete s.keys[key]; });
  }
}

function readStatusQuiet(refsDir: string): BuildStatusFile {
  return readBuildStatus(refsDir);
}

async function listManifestsAsync(refsDir: string): Promise<Array<{ key: string; lastUsedAt: number }>> {
  const dir = path.join(refsDir, 'manifests');
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return []; } // @silent-fallback-ok — none yet
  const out: Array<{ key: string; lastUsedAt: number }> = [];
  for (const n of names) {
    if (!n.endsWith('.json') || !REFERENCE_KEY.test(n.slice(0, -5))) continue;
    try { out.push({ key: n.slice(0, -5), lastUsedAt: (await fs.promises.stat(path.join(dir, n))).mtimeMs }); }
    catch { /* @silent-fallback-ok — vanished mid-list */ }
  }
  return out;
}
