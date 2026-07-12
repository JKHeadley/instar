/**
 * ExternalHogServerPrimitives — builds the real-OS ExternalHogPrimitives the server injects into
 * createExternalHogAdapters (CMT-1901). Kept OUT of the giant server command so the one non-trivial
 * composed primitive — the §4.5 kill-time CPU micro-probe — is unit-testable in isolation.
 *
 * Everything here is thin over injected low-level deps (an async `exec`, `process.kill`, a monotonic
 * clock, a `sleep`, the intelligence `evaluate`, the `raiseAttention` sink, the resolved config
 * getter, the arm-file loader). The server passes the real implementations; a test passes fakes.
 */

import { monotonicNowMs, computeCoreEquivalents, isUnknown, type CpuSample } from './ExternalHogCpuDelta.js';
import { parseProcTable } from './ExternalHogProcTable.js';
import { loadArmState } from './ExternalHogArmStore.js';
import type { ExternalHogPrimitives } from './ExternalHogRealAdapters.js';
import type { ArmMarker } from './ExternalHogArmMarker.js';
import type { DecisionProvenanceBlock } from '../core/decisionQualityTypes.js';

/** The low-level deps the server wires in. */
export interface ServerPrimitiveDeps {
  /** Run a command off the event loop → stdout (execFile-based; rejects on non-zero exit). */
  exec(cmd: string, args: readonly string[]): Promise<string>;
  /** Send a signal (0 = aliveness probe). */
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0): boolean;
  /** The classifier model call (intelligence.evaluate, routed off-Claude by default).
   *  `provenance` (llm-decision-quality-meter §5.3): the server's lambda MUST forward it —
   *  `sharedIntelligence.evaluate(prompt, { model: 'fast',
   *    attribution: { component: 'ExternalHogClassifier' },
   *    ...(provenance ? { provenance } : {}) })`
   *  — so the kill/leave verdict is enrolled with the router's correlation spine. A lambda
   *  that ignores the second parameter still compiles but silently un-enrolls the sentinel's
   *  highest-consequence decision (the wiring-integrity test guards the shipped callsite). */
  evaluate(prompt: string, provenance?: DecisionProvenanceBlock): Promise<string>;
  /** Raise ONE attention item (already mapped to the platform's createAttentionItem in the server). */
  raiseAttention(item: { title: string; body: string; priority?: 'low' | 'medium' | 'high'; source?: string }): Promise<unknown> | unknown;
  /** The LIVE, dev-gate-RESOLVED kill-capability config (enabled resolved, dryRun from config). */
  config(): { enabled: boolean; dryRun: boolean };
  readonly stateDir: string;
  readonly ownEuid: number;
  readonly serverPid: number;
  /** Await ms (injected so tests don't really sleep). */
  sleep(ms: number): Promise<void>;
  auditRow?(row: unknown): void;
}

const CPU_PROBE_PS_ARGS = ['-o', 'pid=,ppid=,uid=,lstart=,time=,comm='] as const;

/**
 * Build the §4.5 kill-time CPU re-confirm probe: sample a pid's cumulative cputime TWICE over
 * `windowMs` (monotonic Δwall) and resolve core-equivalents RIGHT NOW. Returns null (→ the caller
 * aborts the kill, fail-safe) if the pid vanished, is unreadable, was pid-REUSED mid-window
 * (startTime changed), or the delta is UNKNOWN (non-positive/implausible window per the reviewed
 * CPU-delta guards). Pure over the injected exec/now/sleep — testable with fakes.
 */
export function makeCpuCoresOver(
  exec: (cmd: string, args: readonly string[]) => Promise<string>,
  nowMs: () => number,
  sleep: (ms: number) => Promise<void>,
): (pid: number, windowMs: number) => Promise<number | null> {
  return async (pid, windowMs) => {
    const readOne = async (): Promise<{ cpu: number; start: string; at: number } | null> => {
      try {
        const at = nowMs();
        const row = parseProcTable(await exec('ps', [...CPU_PROBE_PS_ARGS, '-p', String(pid)]))[0];
        if (!row || row.cputimeSeconds === undefined || !Number.isFinite(row.cputimeSeconds)) return null;
        return { cpu: row.cputimeSeconds, start: row.startTime, at };
      } catch {
        // @silent-fallback-ok: fail-SAFE direction — a probe that can't read the process
        // yields null = an uncertain reading, which the measurement REFUSES to trust (no kill).
        return null;
      }
    };
    const a = await readOne();
    if (!a) return null;
    await sleep(Math.max(0, windowMs));
    const b = await readOne();
    if (!b) return null;
    if (b.start !== a.start) return null; // pid reused mid-window → identity changed → abort
    const prev: CpuSample = { cumulativeCpuSeconds: a.cpu, monotonicWallMs: a.at };
    const curr: CpuSample = { cumulativeCpuSeconds: b.cpu, monotonicWallMs: b.at };
    const cores = computeCoreEquivalents(prev, curr, { intendedWindowMs: windowMs });
    return isUnknown(cores) ? null : cores;
  };
}

/** Parse `tmux list-panes -a -F '#{pane_pid}'` output into pids. Pure. */
export function parseTmuxPanePids(out: string): number[] {
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0) pids.push(n);
  }
  return pids;
}

/** Assemble the full ExternalHogPrimitives from the low-level server deps. */
export function createExternalHogServerPrimitives(deps: ServerPrimitiveDeps): ExternalHogPrimitives {
  const now = monotonicNowMs;
  return {
    exec: deps.exec,
    signal: deps.signal,
    cpuCoresOver: makeCpuCoresOver(deps.exec, now, deps.sleep),
    callModel: (prompt, provenance) => deps.evaluate(prompt, provenance),
    raiseAttention: deps.raiseAttention,
    now,
    ownEuid: () => deps.ownEuid,
    serverPid: () => deps.serverPid,
    listTmuxPanePids: async () => {
      try {
        return parseTmuxPanePids(await deps.exec('tmux', ['list-panes', '-a', '-F', '#{pane_pid}']));
      } catch {
        // @silent-fallback-ok: no tmux server / tmux unavailable → empty pane set. The server
        // pid remains an owned root, and any process a lost pane hosted still has a LIVING
        // parent (the tmux server), so the orphan floor invariant blocks a kill regardless.
        return [];
      }
    },
    loadArm: (): { marker: ArmMarker | null; lastDisarmEpoch: number } => {
      const s = loadArmState(deps.stateDir);
      return { marker: s.marker, lastDisarmEpoch: s.lastDisarmEpoch };
    },
    config: deps.config,
    ...(deps.auditRow ? { auditRow: deps.auditRow } : {}),
  };
}
