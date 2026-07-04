import { describe, it, expect } from 'vitest';
import { runScanTick, type ScanState, type ScanDeps, type ScanOpts } from '../../src/monitoring/ExternalHogScanTick.js';
import type { ProcTableRow } from '../../src/monitoring/ExternalHogProcTable.js';
import { EMPTY_SAMPLER_STATE } from '../../src/monitoring/ExternalHogSampler.js';
import { EMPTY_KILL_LEDGER } from '../../src/monitoring/ExternalHogKillLedger.js';
import { EMPTY_SUSTAINED_STATE } from '../../src/monitoring/ExternalHogSustained.js';
import { classContentHash, type ArmMarker } from '../../src/monitoring/ExternalHogArmMarker.js';
import type { ExternalHogFacts } from '../../src/monitoring/ExternalHogFloor.js';
import type { KillFunnelDeps, KillArmState } from '../../src/monitoring/ExternalHogKillFunnel.js';

/**
 * ExternalHogScanTick — the orchestrator composing every module into one scan tick (CMT-1901).
 * End-to-end over injected I/O: a synthetic hog flows discovery→classify→floor→funnel→ledger→
 * notices. Watch-only (dryRun) → would-kill + no signal; armed → killed.
 */

const CLASS = 'vscode-exthost';
const HASH = classContentHash(['^Code Helper \\(Plugin\\)$', 'extensionHost']);
const OWN = 501;

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

const LIVE_ARM = (dryRun: boolean, marker: ArmMarker | null, lastDisarm = 4): KillArmState => ({
  config: { enabled: true, dryRun }, marker, lastDisarmEpoch: lastDisarm,
});
const validMarker: ArmMarker = { armEpoch: 5, armedBy: 'pin', armedAt: 't', allowlistSnapshot: { [CLASS]: HASH } } as ArmMarker;

interface HarnessCfg {
  verdict?: unknown;               // classifier raw output (default '{"action":"kill"}')
  arm?: KillArmState;              // funnel arm state (default watch-only dryRun)
  facts?: ExternalHogFacts | null; // floor facts (default permit)
  alive?: boolean;                 // still alive after grace (default true → SIGKILL when armed)
  nullIdentity?: boolean;          // identityFor returns null (present hog, not kill-eligible)
  sustainedSampleCount?: number;   // N-window confirmation (default 1 → single window = sustained)
}

/** Runs two ticks (baseline @0, hog @30000) and returns tick-2's result + the recorded signals. */
async function runTwoTicks(cfg: HarnessCfg = {}) {
  const signals: Array<{ pid: number; signal: string }> = [];
  let call = 0;
  const tables = [[hogRow(100)], [hogRow(160)]]; // +60 CPU-sec / 30s = 2 cores
  const killFunnelDeps: KillFunnelDeps = {
    reReadFacts: () => (cfg.facts === undefined ? permitFacts() : cfg.facts),
    reReadArmState: () => cfg.arm ?? LIVE_ARM(true, validMarker),
    currentClassContentHash: () => HASH,
    hasOpenWritableWorkspaceFile: () => false,
    sendSignal: (pid, signal) => signals.push({ pid, signal }),
    stillAlive: () => cfg.alive ?? true,
    wait: async () => {},
  };
  const deps: ScanDeps = {
    readProcTable: () => tables[Math.min(call, 1)]!,
    buildOwnership: () => ({ tree: new Map(), owned: new Map() }),
    factsFor: () => (cfg.facts === undefined ? permitFacts() : cfg.facts),
    identityFor: () => (cfg.nullIdentity ? null : { commandHash: 'ch', ledgerKey: 'lk', classId: CLASS }),
    classify: async () => (cfg.verdict === undefined ? '{"action":"kill"}' : cfg.verdict),
    killFunnelDeps,
    nowMs: () => call * 30_000,
    deferralsFor: () => 0,
  };
  const opts: ScanOpts = {
    sampler: { ownEuid: OWN, cpuCoreThreshold: 1.5, sampleWindowMs: 30_000, maxAncestorHops: 30 },
    sustainedSampleCount: cfg.sustainedSampleCount ?? 1,
    maxClassificationsPerScan: 4,
    breaker: { windowMs: 3_600_000, maxPerWindow: 3, keyIsVolatile: false },
    killFunnel: { sigtermGraceMs: 12_000, maxKillDeferrals: 3 },
    noticeBudgetPerWindow: 4,
    killLedgerRetentionMs: 3_600_000,
  };
  let state: ScanState = { sampler: EMPTY_SAMPLER_STATE, ledger: EMPTY_KILL_LEDGER, sustained: EMPTY_SUSTAINED_STATE };
  state = (await runScanTick(state, deps, opts)).nextState; call = 1; // tick 1: baseline
  const r2 = await runScanTick(state, deps, opts);                     // tick 2: hog
  return { r2, signals };
}

describe('runScanTick — watch-only (shipped dryRun state)', () => {
  it('a hog classified kill → would-kill, NO signal, surfaced as left-alive', async () => {
    const { r2, signals } = await runTwoTicks({ arm: LIVE_ARM(true, validMarker) });
    expect(signals).toHaveLength(0); // watch-only: nothing signalled
    const o = r2.outcomes.find((x) => x.pid === 9000)!;
    expect(o.verdict).toBe('kill');
    expect(o.outcome).toMatchObject({ action: 'would-kill', reason: 'dry-run' });
    // The observability floor still surfaces it.
    expect(r2.notices.emitted.some((n) => n.cls === 'hog-left-alive')).toBe(true);
  });
});

describe('runScanTick — armed (live kill)', () => {
  it('a hog classified kill → funnel kills it → kill notice + no left-alive', async () => {
    const { r2, signals } = await runTwoTicks({ arm: LIVE_ARM(false, validMarker) });
    expect(signals).toContainEqual({ pid: 9000, signal: 'SIGKILL' });
    const o = r2.outcomes.find((x) => x.pid === 9000)!;
    expect(o.outcome).toMatchObject({ action: 'killed' });
    expect(r2.notices.emitted.some((n) => n.cls === 'kill')).toBe(true);
  });
});

describe('runScanTick — the N-window anti-spike gate (sustainedSampleCount)', () => {
  it('a SINGLE-window hog with sustainedSampleCount=2 is NOT killed — the floor vetoes (not yet sustained)', async () => {
    // runTwoTicks presents the hog for exactly ONE window (tick 2). At N=2 the streak is 1 < 2,
    // so the orchestrator forces sustainedHighCpu:false → the floor's hard veto downgrades it to
    // alert-only. This is the anti-spike guarantee: a transient burst is never killed.
    const { r2, signals } = await runTwoTicks({ sustainedSampleCount: 2, arm: LIVE_ARM(false, validMarker) });
    expect(signals).toHaveLength(0);
    expect(r2.outcomes.find((o) => o.pid === 9000)?.outcome).toBe('alert-only');
    expect(r2.notices.emitted.some((n) => n.cls === 'floor-veto-downgrade')).toBe(true);
  });

  it('a degraded fact builder emitting a TRUTHY NON-boolean sustainedHighCpu is NOT laundered into a kill', async () => {
    // Phase-5 reviewer (category B): `x && sustained` would coerce a degraded `sustainedHighCpu = 1`
    // into boolean true, defeating the floor's strict-boolean `field-unknown` veto. The gate must
    // apply ONLY to a genuine `=== true`; a malformed value is PRESERVED so the floor still vetoes.
    const malformed = { ...permitFacts(), sustainedHighCpu: 1 as unknown as boolean };
    const { r2, signals } = await runTwoTicks({ facts: malformed, sustainedSampleCount: 1, arm: LIVE_ARM(false, validMarker) });
    expect(signals).toHaveLength(0); // NOT killed — the floor still vetoes the non-boolean field
    expect(r2.outcomes.find((o) => o.pid === 9000)?.outcome).toBe('alert-only');
    expect(r2.notices.emitted.some((n) => n.cls === 'floor-veto-downgrade')).toBe(true);
  });
});

describe('runScanTick — the model spares / floor vetoes / decider unavailable', () => {
  it('model says leave → alert-only, NO signal, surfaced', async () => {
    const { r2, signals } = await runTwoTicks({ verdict: '{"action":"leave"}', arm: LIVE_ARM(false, validMarker) });
    expect(signals).toHaveLength(0);
    const o = r2.outcomes.find((x) => x.pid === 9000)!;
    expect(o.verdict).toBe('leave');
    expect(o.outcome).toBe('alert-only');
    expect(r2.notices.emitted.some((n) => n.cls === 'hog-left-alive')).toBe(true);
  });
  it('decider unavailable (classify null) → decider-unavailable notice, NO signal', async () => {
    const { r2, signals } = await runTwoTicks({ verdict: null, arm: LIVE_ARM(false, validMarker) });
    expect(signals).toHaveLength(0);
    expect(r2.outcomes.find((x) => x.pid === 9000)!.verdict).toBe('decider-unavailable');
    expect(r2.notices.emitted.some((n) => n.cls === 'decider-unavailable')).toBe(true);
  });
  it('floor vetoes (now root-owned) → alert-only + floor-veto notice, NO signal', async () => {
    const { r2, signals } = await runTwoTicks({ facts: { ...permitFacts(), ownerRootDaemon: true }, arm: LIVE_ARM(false, validMarker) });
    expect(signals).toHaveLength(0);
    expect(r2.outcomes.find((x) => x.pid === 9000)!.outcome).toBe('alert-only');
    expect(r2.notices.emitted.some((n) => n.cls === 'floor-veto-downgrade')).toBe(true);
  });
});

describe('runScanTick — a PRESENT hog that is not kill-eligible is still SURFACED (no invisible hog)', () => {
  it('a present sustained hog with a null identity (non-allowlist class) → surfaced, NO signal', async () => {
    // The round-13 fix: facts are live (present hog) but identityFor is null (not kill-eligible)
    // — it must be surfaced as hog-left-alive, never silently dropped, and never killed.
    const { r2, signals } = await runTwoTicks({ nullIdentity: true, arm: LIVE_ARM(false, validMarker) });
    expect(signals).toHaveLength(0);
    // It is NOT in outcomes (never classified/killed) but IS surfaced.
    expect(r2.outcomes.find((x) => x.pid === 9000)).toBeUndefined();
    expect(r2.notices.emitted.some((n) => n.cls === 'hog-left-alive' && n.signature.includes('9000'))).toBe(true);
  });
});

describe('runScanTick — no hog → nothing', () => {
  it('an idle machine (no candidate) emits no notices and no signals', async () => {
    const { r2, signals } = await runTwoTicks({ facts: null }); // factsFor null → no enriched candidate
    expect(signals).toHaveLength(0);
    expect(r2.outcomes).toHaveLength(0);
    expect(r2.notices.emitted).toHaveLength(0);
  });
});
