import { describe, it, expect } from 'vitest';
import { ExternalHogSentinel, buildProcTree, type ExternalHogAdapters, type ExternalHogRuntimeOpts } from '../../src/monitoring/ExternalHogSentinel.js';
import type { ProcTableRow } from '../../src/monitoring/ExternalHogProcTable.js';
import type { ExternalHogFacts } from '../../src/monitoring/ExternalHogFloor.js';
import type { KillFunnelDeps, KillArmState } from '../../src/monitoring/ExternalHogKillFunnel.js';
import { classContentHash, type ArmMarker } from '../../src/monitoring/ExternalHogArmMarker.js';

/**
 * ExternalHogSentinel — the composition shell (CMT-1901). It adds NO kill decision (that stays in
 * the reviewed orchestrator/funnel); it holds cross-tick state + bridges the real I/O. These
 * tests prove the shell responsibilities: watch-only ride-through, live kill when armed, the
 * cross-tick DEFERRAL count (the maxKillDeferrals bound that only the shell can persist), notice
 * delivery every tick, and the honest §8 guard posture (on-dry-run / on-confirmed / on-stale).
 */

const CLASS = 'vscode-exthost';
const HASH = classContentHash(['^Code Helper \\(Plugin\\)$', 'extensionHost']);
const OWN = 501;
const LEDGER_KEY = 'lk-exthost-9000';

function hogRow(cputime: number): ProcTableRow {
  return { pid: 9000, ppid: 1, uid: OWN, startTime: 'S9000', cputimeSeconds: cputime, comm: 'Code Helper (Plugin)' };
}
function permitFacts(): ExternalHogFacts {
  return {
    name: 'Code Helper (Plugin)', argv: '/App/Code Helper (Plugin) --type=extensionHost --parentPid=1',
    pid: 9000, ownerAppRunning: false, sustainedHighCpu: true, isInstarProcess: false,
    ownerRootDaemon: false, hasLaunchctlLabel: false, targetUid: OWN, ownEuid: OWN,
  };
}
const validMarker: ArmMarker = { armEpoch: 5, armedBy: 'pin', armedAt: 't', allowlistSnapshot: { [CLASS]: HASH } } as ArmMarker;
const LIVE_ARM = (dryRun: boolean): KillArmState => ({ config: { enabled: true, dryRun }, marker: validMarker, lastDisarmEpoch: 4 });

interface Cfg {
  dryRun?: boolean;          // arm/config dryRun (default true → watch-only)
  writing?: boolean;         // funnel: open writable workspace file (drives 'deferred')
  alive?: boolean;           // funnel: still alive after grace (default true)
  psFails?: boolean;         // readProcTable always returns [] (a ps that never parses)
}

/** A sentinel over fakes with a MUTABLE clock and a two-entry table (baseline, then hog). */
function mkSentinel(cfg: Cfg = {}) {
  const signals: Array<{ pid: number; signal: string }> = [];
  const delivered: number[] = []; // count of emitted notices per deliverNotices call
  const audits: Array<{ candidates: number; killed: number; deferred: number }> = [];
  let clock = 0;
  // A SUSTAINED hog: cumulative cputime climbs +60 cpu-sec every 30s window → a steady 2 cores,
  // tick after tick (a frozen cputime would make the cross-tick delta zero → no candidate).
  const tableAt = () => [hogRow(100 + (clock / 30_000) * 60)];
  const arm = () => LIVE_ARM(cfg.dryRun ?? true);

  const killFunnelDeps: KillFunnelDeps = {
    reReadFacts: () => permitFacts(),
    reReadArmState: () => arm(),
    currentClassContentHash: () => HASH,
    hasOpenWritableWorkspaceFile: () => cfg.writing ?? false,
    sendSignal: (pid, signal) => signals.push({ pid, signal }),
    stillAlive: () => cfg.alive ?? true,
    wait: async () => {},
  };
  const adapters: ExternalHogAdapters = {
    readProcTable: async () => (cfg.psFails ? [] : tableAt()),
    ownedRefs: async () => new Map(),
    factsFor: () => permitFacts(),
    identityFor: () => ({ commandHash: 'ch', ledgerKey: LEDGER_KEY, classId: CLASS }),
    classify: async () => '{"action":"kill"}',
    killFunnelDeps,
    deliverNotices: (r) => delivered.push(r.emitted.length),
    armStatus: () => ({ enabled: true, dryRun: cfg.dryRun ?? true, markerValid: true }),
    nowMs: () => clock,
    auditTick: (row) => audits.push({ candidates: row.candidates, killed: row.killed, deferred: row.deferred }),
  };
  const opts: ExternalHogRuntimeOpts = {
    sampler: { ownEuid: OWN, cpuCoreThreshold: 1.5, sampleWindowMs: 30_000, maxAncestorHops: 30 },
    sustainedSampleCount: 1, // single-window = sustained here; the N-window gate is covered in the sustained + scan-tick suites
    maxClassificationsPerScan: 4,
    breaker: { windowMs: 3_600_000, maxPerWindow: 3, keyIsVolatile: false },
    killFunnel: { sigtermGraceMs: 12_000, maxKillDeferrals: 3 },
    noticeBudgetPerWindow: 4,
    killLedgerRetentionMs: 3_600_000,
    samplerDeadThresholdMs: 300_000,
  };
  const sentinel = new ExternalHogSentinel(adapters, opts);
  return {
    sentinel, signals, delivered, audits,
    setClock: (v: number) => { clock = v; },
  };
}

describe('buildProcTree', () => {
  it('builds pid→node from a parsed table, skipping non-positive pids', () => {
    const tree = buildProcTree([
      { pid: 10, ppid: 1, uid: 501, startTime: 'A', cputimeSeconds: 1, comm: 'a' },
      { pid: 0, ppid: 1, uid: 501, startTime: 'B', cputimeSeconds: 1, comm: 'b' },
    ]);
    expect(tree.size).toBe(1);
    expect(tree.get(10)).toMatchObject({ pid: 10, ppid: 1, startTime: 'A' });
  });
});

describe('ExternalHogSentinel — watch-only (shipped dryRun)', () => {
  it('a hog classified kill → NO signal, notices delivered every tick, posture on-dry-run', async () => {
    const h = mkSentinel({ dryRun: true });
    h.setClock(0); await h.sentinel.tick();       // baseline
    h.setClock(30_000); const r = await h.sentinel.tick(); // hog
    expect(h.signals).toHaveLength(0);            // watch-only: nothing signalled
    expect(r.outcomes.find((o) => o.pid === 9000)?.outcome).toMatchObject({ action: 'would-kill' });
    expect(h.delivered).toHaveLength(2);          // delivery every tick (incl. the empty baseline)
    expect(h.sentinel.status().effectiveState).toBe('on-dry-run');
  });
});

describe('ExternalHogSentinel — armed (live kill)', () => {
  it('a hog classified kill → SIGKILL, posture on-confirmed, deferral count stays 0', async () => {
    const h = mkSentinel({ dryRun: false, writing: false });
    h.setClock(0); await h.sentinel.tick();
    h.setClock(30_000); await h.sentinel.tick();
    expect(h.signals).toContainEqual({ pid: 9000, signal: 'SIGKILL' });
    const st = h.sentinel.status();
    expect(st.effectiveState).toBe('on-confirmed');
    expect(st.trackedDeferrals).toBe(0); // killed → nothing lingering
  });
});

describe('ExternalHogSentinel — cross-tick deferral persistence (the maxKillDeferrals bound)', () => {
  it('an open-workspace-file hog defers ACROSS ticks, then proceeds to SIGKILL at the cap', async () => {
    // This is the state ONLY the shell can hold: the per-signature deferral count persists across
    // ticks, so maxKillDeferrals (3) actually bounds a target that is deferred each scan for an
    // open workspace file. The proof is behavioral — no SIGKILL while under the cap, SIGKILL once
    // the cap is reached — since `trackedDeferrals` reports the number of DISTINCT signatures
    // mid-deferral (1 here), not the internal per-key count that climbs 1→2→3 and drives the kill.
    const h = mkSentinel({ dryRun: false, writing: true, alive: true });
    h.setClock(0); await h.sentinel.tick();       // baseline (no candidate yet)
    for (const t of [30_000, 60_000, 90_000]) {   // deferrals #1..#3 (under the cap)
      h.setClock(t); await h.sentinel.tick();
      expect(h.signals).not.toContainEqual({ pid: 9000, signal: 'SIGKILL' });
      expect(h.sentinel.status().trackedDeferrals).toBe(1); // one signature is mid-deferral
    }
    // currentDeferrals has now reached maxKillDeferrals (3) → this tick proceeds to SIGKILL.
    h.setClock(120_000); await h.sentinel.tick();
    expect(h.signals).toContainEqual({ pid: 9000, signal: 'SIGKILL' });
    expect(h.sentinel.status().trackedDeferrals).toBe(0); // terminal → the signature is cleared
  });
});

describe('ExternalHogSentinel — the honest §8 posture degrades to on-stale when blind', () => {
  it('after a successful tick, a clock jump past the sampler-dead threshold reads on-stale', async () => {
    const h = mkSentinel({ dryRun: false });
    h.setClock(0); await h.sentinel.tick();       // sets the sampler heartbeat + lastTickAt
    expect(h.sentinel.status().samplerDead).toBe(false);
    h.setClock(1_000_000);                         // >> samplerDeadThresholdMs (300000)
    const st = h.sentinel.status();
    expect(st.samplerDead).toBe(true);
    expect(st.effectiveState).toBe('on-stale');    // blind overrides the on-confirmed config
  });

  it('a boot where ps NEVER parses reads on-stale, NEVER a false on-confirmed (reviewer note D)', async () => {
    // The Phase-5 honesty fix: armed (enabled && !dryRun && marker-valid) but `ps` fails from the
    // start so NO parse ever succeeds → the feature is blind → posture must be on-stale, not the
    // falsely-reassuring on-confirmed. on-confirmed REQUIRES a fresh successful parse.
    const h = mkSentinel({ dryRun: false, psFails: true });
    h.setClock(0); await h.sentinel.tick();       // ticks, but the empty table never advances the heartbeat
    h.setClock(30_000); await h.sentinel.tick();
    const st = h.sentinel.status();
    expect(st.samplerDead).toBe(true);
    expect(st.effectiveState).toBe('on-stale');    // blind, though config would say on-confirmed
    expect(h.signals).toHaveLength(0);             // and nothing is ever killed while blind
  });
});
