/**
 * ExternalHogRealAdapters — the IMPURE edge that binds the reviewed pure modules to the real OS
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §1-§6). It builds the
 * `ExternalHogAdapters` object the ExternalHogSentinel shell consumes.
 *
 * Every raw side-effect (spawn `ps`/`launchctl`/`lsof` off-loop, `process.kill`, the model call,
 * raising an attention item, reading the clock + arm file) is a single INJECTED primitive, so the
 * wiring here is unit-testable with fakes and NO real process is ever spawned or signalled in a
 * test. The server supplies the real primitives (`defaultPrimitives`-style) at construction.
 *
 * This module holds NO kill decision — it only READS the OS to produce facts and EXECUTES the
 * signals the reviewed funnel decides on. The watch-only guarantee, the floor veto, the arm gate
 * and the classifier authority all live in the modules it wires together, unchanged.
 */

import { parseProcTable, type ProcTableRow } from './ExternalHogProcTable.js';
import { buildProcTree, type ExternalHogAdapters } from './ExternalHogSentinel.js';
import type { OwnedRefs, ProcTree } from './ExternalHogOwnership.js';
import type { Candidate } from './ExternalHogSampler.js';
import { buildFacts, buildIdentity } from './ExternalHogFactBuilder.js';
import { matchAllowlistClass, classRuleSources, type ExternalHogFacts } from './ExternalHogFloor.js';
import { classContentHash, isMarkerValid, type ArmMarker } from './ExternalHogArmMarker.js';
import { buildClassifierPrompt } from './ExternalHogClassifierPrompt.js';
import type { KillFunnelDeps } from './ExternalHogKillFunnel.js';
import type { CoalesceResult } from './ExternalHogNoticeCoalescer.js';
import type { DecisionProvenanceBlock } from '../core/decisionQualityTypes.js';

/** The raw side-effect primitives — the ONLY things that touch the real OS / network. */
export interface ExternalHogPrimitives {
  /** Run a command off the event loop, resolve stdout. Reject/throw on non-zero exit is fine —
   *  each caller decides the fail-safe direction. */
  exec(cmd: string, args: readonly string[]): Promise<string>;
  /** Send a signal to a pid; `0` is an aliveness probe. Returns false if the pid is gone. */
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0): boolean;
  /** Kill-time CPU RE-CONFIRM (§4.5): sample the pid's cumulative cputime twice over `windowMs`
   *  (monotonic Δwall) and resolve the core-equivalents right now; null if the pid vanished /
   *  is unreadable. This is the fresh "is it STILL pinning cores, or did it go idle?" probe that
   *  gates every signal — a null or below-threshold reading must abort the kill (fail-safe). */
  cpuCoresOver(pid: number, windowMs: number): Promise<number | null>;
  /** Call the classifier model with a prompt (wrapped by the caller in the LlmQueue background lane).
   *  `provenance` is the llm-decision-quality-meter §5.3 enrollment block — the server-side
   *  primitive threads it as `options.provenance` on intelligence.evaluate so the router mints +
   *  settles a decision row for the kill/leave verdict. */
  callModel(prompt: string, provenance?: DecisionProvenanceBlock): Promise<string>;
  /** Raise ONE attention item for the coalesced notices. */
  raiseAttention(item: { title: string; body: string; priority?: 'low' | 'medium' | 'high'; source?: string }): Promise<unknown> | unknown;
  /** A monotonic clock reading (ms). */
  now(): number;
  /** The sentinel's own effective uid. */
  ownEuid(): number;
  /** The server process pid (an instar-owned root of the ownership walk). */
  serverPid(): number;
  /** The pids of live tmux panes (instar-owned session roots). */
  listTmuxPanePids(): Promise<readonly number[]>;
  /** Read the durable armed state (marker + lastDisarmEpoch) — loadArmState(stateDir). */
  loadArm(): { marker: ArmMarker | null; lastDisarmEpoch: number };
  /** The LIVE kill-capability config (read fresh each call). */
  config(): { enabled: boolean; dryRun: boolean };
  /** Append one scrubbed audit row per tick (best-effort). */
  auditRow?(row: unknown): void;
}

export interface ExternalHogAdapterOpts {
  readonly cpuCoreThreshold: number;
  readonly maxAncestorHops: number;
  /** The kill-time CPU re-confirm micro-window (§4.5, ~2.5s) and its core threshold (~0.5) — the
   *  fresh "still pinning cores vs went idle" gate applied at every reReadFacts before a signal. */
  readonly killTimeCpuRecheckWindowMs: number;
  readonly killTimeCpuCoreThreshold: number;
  /** Paths that count as user-document / workspace roots for the fd-skip (kill-time write) check.
   *  Empty → the conservative default (a writable regular file under $HOME but not Library/caches). */
  readonly workspacePathHints?: readonly string[];
  /** Home dir for the default workspace heuristic. */
  readonly homeDir?: string;
}

const PS_TABLE_ARGS = ['-o', 'pid=,ppid=,uid=,lstart=,time=,comm='] as const;

/** Parse `lsof -F fatn` output into fd records. Pure. */
export function parseLsofFdRecords(out: string): Array<{ access: string; type: string; name: string }> {
  const recs: Array<{ access: string; type: string; name: string }> = [];
  let cur: { access: string; type: string; name: string } | null = null;
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'f') { // a new fd record begins
      if (cur) recs.push(cur);
      cur = { access: '', type: '', name: '' };
    } else if (cur) {
      if (tag === 'a') cur.access = val;
      else if (tag === 't') cur.type = val;
      else if (tag === 'n') cur.name = val;
    }
  }
  if (cur) recs.push(cur);
  return recs;
}

/** Does this pid hold an open WRITABLE regular file under a user-document path? Pure over lsof out. */
export function hasWritableUserFile(lsofOut: string, opts: { workspacePathHints?: readonly string[]; homeDir?: string }): boolean {
  const hints = opts.workspacePathHints ?? [];
  const home = opts.homeDir ?? '';
  for (const r of parseLsofFdRecords(lsofOut)) {
    if (r.type !== 'REG') continue;
    if (!(r.access.includes('w') || r.access.includes('u'))) continue; // write or read+write
    const name = r.name;
    if (hints.length > 0) {
      if (hints.some((h) => h && name.startsWith(h))) return true;
      continue;
    }
    // Default heuristic: a writable regular file under $HOME but NOT under a cache/library/system dir.
    if (home && name.startsWith(home)) {
      const rel = name.slice(home.length);
      if (/^\/(Library|\.cache|\.Trash|\.npm|\.cache|Caches)\b/i.test(rel)) continue;
      return true;
    }
  }
  return false;
}

/** Parse `launchctl list` output → the set of pids that are labeled launchd jobs. Pure. */
export function parseLaunchctlPids(out: string): Set<number> {
  const pids = new Set<number>();
  for (const line of out.split('\n')) {
    // Columns: PID  Status  Label. A '-' PID means not-currently-running (skip).
    const m = /^\s*(\d+)\s+\S+\s+\S/.exec(line);
    if (m) {
      const pid = Number(m[1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return pids;
}

/**
 * Build the live `ExternalHogAdapters` from the raw primitives. A short-lived per-tick cache
 * (the last parsed table + resolved ownership + launchctl set) lets the per-candidate `factsFor`
 * calls reuse one ps/launchctl read instead of re-spawning per candidate.
 */
export function createExternalHogAdapters(prims: ExternalHogPrimitives, opts: ExternalHogAdapterOpts): ExternalHogAdapters {
  let lastTable: readonly ProcTableRow[] = [];
  let lastOwned: OwnedRefs = new Map();
  let launchctlCache: { at: number; pids: Set<number> } | null = null;

  async function readProcTable(): Promise<readonly ProcTableRow[]> {
    try {
      lastTable = parseProcTable(await prims.exec('ps', PS_TABLE_ARGS));
    } catch {
      lastTable = []; // a failed ps read → empty table → the sampler heartbeat won't advance (→ on-stale)
    }
    return lastTable;
  }

  async function ownedRefs(): Promise<OwnedRefs> {
    const owned = new Map<number, string>();
    const rootPids: number[] = [prims.serverPid()];
    try { rootPids.push(...(await prims.listTmuxPanePids())); } catch { /* tmux unavailable → server pid only */ }
    for (const pid of rootPids) {
      const row = lastTable.find((r) => r.pid === pid);
      if (row) owned.set(pid, row.startTime);
    }
    lastOwned = owned;
    return owned;
  }

  async function launchctlPids(): Promise<Set<number>> {
    const now = prims.now();
    if (launchctlCache && now - launchctlCache.at < 30_000) return launchctlCache.pids;
    try {
      const pids = parseLaunchctlPids(await prims.exec('launchctl', ['list']));
      launchctlCache = { at: now, pids };
      return pids;
    } catch {
      // @silent-fallback-ok: reviewed decision (round 8) — launchctl failed → EMPTY set.
      // hasLaunchctlLabel:false does NOT open a kill on its own (every OTHER floor invariant
      // must still hold), and a genuinely labeled job that we fail to detect is a rare edge;
      // the conservative alternative (mark everything labeled → never kill) would break the
      // feature entirely. Fail toward the feature working, floor-bounded.
      return new Set();
    }
  }

  async function fetchArgv(pid: number): Promise<string | null> {
    try {
      const out = (await prims.exec('ps', ['-o', 'args=', '-p', String(pid)])).trim();
      return out.length > 0 ? out : null;
    } catch {
      // @silent-fallback-ok: fail-SAFE direction — can't read argv → the caller returns null
      // facts → candidate skipped entirely (a missing fact always blocks, never permits).
      return null;
    }
  }

  async function factsFor(candidate: Candidate, table: readonly ProcTableRow[]): Promise<ExternalHogFacts | null> {
    const row = table.find((r) => r.pid === candidate.pid && r.startTime === candidate.startTime);
    if (!row) return null; // vanished / identity changed since candidacy
    const argv = await fetchArgv(candidate.pid);
    if (argv === null) return null;
    const tree: ProcTree = buildProcTree(table);
    const launchctlLabeledPids = await launchctlPids();
    return buildFacts({
      row, argv, tree, ownedRefs: lastOwned, maxAncestorHops: opts.maxAncestorHops,
      ownEuid: prims.ownEuid(), launchctlLabeledPids,
      sustainedThisWindow: candidate.coreEquivalents >= opts.cpuCoreThreshold,
    });
  }

  function identityFor(_candidate: Candidate, facts: ExternalHogFacts): { commandHash: string; ledgerKey: string; classId: string } | null {
    return buildIdentity(facts);
  }

  async function classify(facts: ExternalHogFacts, provenance?: DecisionProvenanceBlock): Promise<unknown> {
    const classId = matchAllowlistClass(facts.name, facts.argv);
    if (!classId) return null; // not an allowlist class → decider-unavailable → alert (never happens: only classified after identity)
    return prims.callModel(buildClassifierPrompt(facts, classId), provenance);
  }

  function currentClassContentHash(classId: string): string {
    const sources = classRuleSources(classId);
    // A class with no rule sources can't be armed; return a sentinel hash that matches NOTHING in
    // any snapshot (so the arm-scope check fails closed → no kill).
    return sources ? classContentHash(sources) : 'no-such-class';
  }

  const killFunnelDeps: KillFunnelDeps = {
    reReadFacts: async (pid, startTime) => {
      const table = await readProcTable();
      const row = table.find((r) => r.pid === pid && r.startTime === startTime);
      if (!row) return null; // gone or pid reused (startTime mismatch) → identity changed
      const argv = await fetchArgv(pid);
      if (argv === null) return null;
      // §4.5 kill-time CPU re-confirm — a FRESH micro-sample RIGHT NOW: is it still pinning cores,
      // or did it go idle since classify? A null (probe failed / pid gone) or below-threshold
      // reading sets sustainedHighCpu:false → the floor re-check vetoes → the kill aborts (safe).
      const cores = await prims.cpuCoresOver(pid, opts.killTimeCpuRecheckWindowMs);
      const stillHog = cores !== null && Number.isFinite(cores) && cores >= opts.killTimeCpuCoreThreshold;
      return buildFacts({
        row, argv, tree: buildProcTree(table), ownedRefs: lastOwned, maxAncestorHops: opts.maxAncestorHops,
        ownEuid: prims.ownEuid(), launchctlLabeledPids: await launchctlPids(),
        sustainedThisWindow: stillHog,
      });
    },
    reReadArmState: () => {
      const arm = prims.loadArm();
      return { config: prims.config(), marker: arm.marker, lastDisarmEpoch: arm.lastDisarmEpoch };
    },
    currentClassContentHash,
    hasOpenWritableWorkspaceFile: async (pid) => {
      try {
        return hasWritableUserFile(await prims.exec('lsof', ['-p', String(pid), '-F', 'fatn']), opts);
      } catch {
        return true; // lsof error → can't rule out an in-progress write → DEFER (bounded, safe)
      }
    },
    sendSignal: (pid, signal) => { prims.signal(pid, signal); },
    stillAlive: (pid) => prims.signal(pid, 0),
    wait: (ms) => new Promise((res) => setTimeout(res, Math.max(0, ms))),
  };

  function deliverNotices(result: CoalesceResult): void {
    if (!result || result.emitted.length === 0) return;
    const hasKill = result.emitted.some((n) => n.cls === 'kill');
    const body = result.emitted.map((n) => `• ${n.text}`).join('\n');
    void Promise.resolve(prims.raiseAttention({
      title: hasKill ? 'External-hog sentinel: auto-killed a zombie' : 'External-hog sentinel: sustained CPU hog',
      body,
      priority: hasKill ? 'high' : 'medium',
      source: 'external-hog-sentinel',
    })).catch(() => undefined); // delivery is best-effort; never throw into the tick
  }

  function armStatus(): { enabled: boolean; dryRun: boolean; markerValid: boolean } {
    const cfg = prims.config();
    const arm = prims.loadArm();
    return { enabled: cfg.enabled === true, dryRun: cfg.dryRun !== false, markerValid: isMarkerValid(arm.marker, arm.lastDisarmEpoch) };
  }

  return {
    readProcTable,
    ownedRefs,
    factsFor,
    identityFor,
    classify,
    killFunnelDeps,
    deliverNotices,
    armStatus,
    nowMs: () => prims.now(),
    ...(prims.auditRow ? { auditTick: (row) => prims.auditRow!(row) } : {}),
  };
}
