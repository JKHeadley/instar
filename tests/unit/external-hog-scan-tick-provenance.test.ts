import { describe, it, expect } from 'vitest';
import {
  runScanTick, deriveHogOwnerTuple, buildHogDecisionContext, HOG_CLASSIFIER_PROMPT_ID,
  type ScanState, type ScanDeps, type ScanOpts, type ScanResult,
} from '../../src/monitoring/ExternalHogScanTick.js';
import type { ProcTableRow } from '../../src/monitoring/ExternalHogProcTable.js';
import { EMPTY_SAMPLER_STATE } from '../../src/monitoring/ExternalHogSampler.js';
import { EMPTY_KILL_LEDGER, recordKill, type KillLedgerState } from '../../src/monitoring/ExternalHogKillLedger.js';
import { EMPTY_SUSTAINED_STATE } from '../../src/monitoring/ExternalHogSustained.js';
import { classContentHash, type ArmMarker } from '../../src/monitoring/ExternalHogArmMarker.js';
import { evaluateKillFloor, type ExternalHogFacts } from '../../src/monitoring/ExternalHogFloor.js';
import type { KillFunnelDeps, KillArmState } from '../../src/monitoring/ExternalHogKillFunnel.js';
import type { ProcTree } from '../../src/monitoring/ExternalHogOwnership.js';
import type { DecisionProvenanceBlock } from '../../src/core/decisionQualityTypes.js';
import { DP_EXTERNAL_HOG_KILL_LEAVE } from '../../src/data/provenanceCoverage.js';

/**
 * ExternalHogScanTick — the §5.3 first-customer enrollment (llm-decision-quality-meter):
 * the classifier call carries options.provenance (typed decision point, bounded hog envelope
 * WITHOUT argv, optionsPresented, promptId, onCorrelationId), and every per-candidate outcome
 * carries the ENACTED disposition + the durable decision-store seed with member-wise tuples.
 */

const CLASS = 'vscode-exthost';
const HASH = classContentHash(['^Code Helper \\(Plugin\\)$', 'extensionHost']);
const OWN = 501;
// A parseable lstart-style start time so targetTuple.startTimeMs is orderable.
const START = 'Wed Jul 2 10:00:00 2026';
const SECRET = 'hunter2secret'; // positional-password shape — must NEVER reach the provenance context

function hogRow(cputime: number): ProcTableRow {
  return { pid: 9000, ppid: 1, uid: OWN, startTime: START, cputimeSeconds: cputime, comm: 'Code Helper (Plugin)' };
}

function permitFacts(over: Partial<ExternalHogFacts> = {}): ExternalHogFacts {
  return {
    name: 'Code Helper (Plugin)',
    argv: `/App/Code Helper (Plugin) --type=extensionHost --parentPid=1 --password ${SECRET}`,
    pid: 9000, ownerAppRunning: false, sustainedHighCpu: true, isInstarProcess: false,
    ownerRootDaemon: false, hasLaunchctlLabel: false, targetUid: OWN, ownEuid: OWN,
    ...over,
  };
}

const LIVE_ARM = (dryRun: boolean, marker: ArmMarker | null, lastDisarm = 4): KillArmState => ({
  config: { enabled: true, dryRun }, marker, lastDisarmEpoch: lastDisarm,
});
const validMarker: ArmMarker = { armEpoch: 5, armedBy: 'pin', armedAt: 't', allowlistSnapshot: { [CLASS]: HASH } } as ArmMarker;

interface HarnessCfg {
  verdict?: unknown;                    // classifier raw output (default '{"action":"kill"}')
  arm?: KillArmState;                   // funnel arm state (default watch-only dryRun)
  facts?: ExternalHogFacts | null;      // discovery facts (default permit)
  reReadFacts?: ExternalHogFacts | null; // funnel re-read facts (default = facts)
  alive?: boolean;                      // still alive after grace (default true → SIGKILL when armed)
  hasOpenFile?: boolean;                // fd-skip → deferred
  tree?: ProcTree;                      // ownership tree (ownerTuple derivation input)
  ledger?: KillLedgerState;             // pre-seeded P19 ledger (breaker-held case)
  cap?: number;                         // maxClassificationsPerScan (0 → all over-cap)
  onCorrelationIdValue?: string | null; // classify invokes provenance.onCorrelationId with this
}

/** Runs two ticks (baseline @0, hog @30000); returns tick-2's result + captured classify calls. */
async function runTwoTicks(cfg: HarnessCfg = {}) {
  const signals: Array<{ pid: number; signal: string }> = [];
  const classifyCalls: Array<{ facts: ExternalHogFacts; provenance?: DecisionProvenanceBlock }> = [];
  let call = 0;
  const tables = [[hogRow(100)], [hogRow(160)]]; // +60 CPU-sec / 30s = 2 cores
  const facts = cfg.facts === undefined ? permitFacts() : cfg.facts;
  const killFunnelDeps: KillFunnelDeps = {
    reReadFacts: () => (cfg.reReadFacts === undefined ? facts : cfg.reReadFacts),
    reReadArmState: () => cfg.arm ?? LIVE_ARM(true, validMarker),
    currentClassContentHash: () => HASH,
    hasOpenWritableWorkspaceFile: () => cfg.hasOpenFile ?? false,
    sendSignal: (pid, signal) => signals.push({ pid, signal }),
    stillAlive: () => cfg.alive ?? true,
    wait: async () => {},
  };
  const deps: ScanDeps = {
    readProcTable: () => tables[Math.min(call, 1)]!,
    buildOwnership: () => ({ tree: cfg.tree ?? new Map(), owned: new Map() }),
    factsFor: () => facts,
    identityFor: () => ({ commandHash: 'ch', ledgerKey: 'lk', classId: CLASS }),
    classify: async (f, provenance) => {
      classifyCalls.push({ facts: f, provenance });
      if (cfg.onCorrelationIdValue !== null) provenance?.onCorrelationId?.(cfg.onCorrelationIdValue ?? 'd-test-1');
      return cfg.verdict === undefined ? '{"action":"kill"}' : cfg.verdict;
    },
    killFunnelDeps,
    nowMs: () => call * 30_000,
    deferralsFor: () => 0,
  };
  const opts: ScanOpts = {
    sampler: { ownEuid: OWN, cpuCoreThreshold: 1.5, sampleWindowMs: 30_000, maxAncestorHops: 30 },
    sustainedSampleCount: 1,
    maxClassificationsPerScan: cfg.cap ?? 4,
    breaker: { windowMs: 3_600_000, maxPerWindow: 3, keyIsVolatile: false },
    killFunnel: { sigtermGraceMs: 12_000, maxKillDeferrals: 3 },
    noticeBudgetPerWindow: 4,
    killLedgerRetentionMs: 3_600_000,
  };
  let state: ScanState = { sampler: EMPTY_SAMPLER_STATE, ledger: cfg.ledger ?? EMPTY_KILL_LEDGER, sustained: EMPTY_SUSTAINED_STATE };
  state = (await runScanTick(state, deps, opts)).nextState; call = 1; // tick 1: baseline
  const r2: ScanResult = await runScanTick(state, deps, opts);        // tick 2: hog
  return { r2, signals, classifyCalls };
}

const one = (r2: ScanResult) => {
  expect(r2.outcomes).toHaveLength(1);
  return r2.outcomes[0]!;
};

describe('runScanTick — §5.3 provenance enrollment on the classifier call', () => {
  it('classify receives the options.provenance block: typed decision point, kill/leave options, prompt id', async () => {
    const { classifyCalls } = await runTwoTicks();
    expect(classifyCalls).toHaveLength(1);
    const p = classifyCalls[0]!.provenance!;
    expect(p.decisionPoint).toBe(DP_EXTERNAL_HOG_KILL_LEAVE);
    expect(p.optionsPresented).toEqual(['kill', 'leave']);
    expect(p.promptId).toBe(HOG_CLASSIFIER_PROMPT_ID);
    expect(typeof p.onCorrelationId).toBe('function');
  });

  it('the context is the bounded hog envelope — identity + verdict fields, NEVER raw argv', async () => {
    const { classifyCalls } = await runTwoTicks();
    const ctx = classifyCalls[0]!.provenance!.context!;
    expect(ctx).toMatchObject({
      commandHash: 'ch', ledgerKey: 'lk', classId: CLASS,
      name: 'Code Helper (Plugin)', floorPermitted: true,
      ownerAppRunning: false, sustainedHighCpu: true, isInstarProcess: false,
      ownerRootDaemon: false, hasLaunchctlLabel: false,
      coreEquivalents: 2, pid: 9000,
    });
    const json = JSON.stringify(ctx);
    expect(json).not.toContain(SECRET);          // a positional password in argv never crosses
    expect(json).not.toContain('extensionHost'); // no argv fragment of any kind
    expect(json).not.toContain('argv');
  });

  it('onCorrelationId is persisted into the decision seed', async () => {
    const { r2 } = await runTwoTicks({ onCorrelationIdValue: 'd-abc123' });
    expect(one(r2).decision.correlationId).toBe('d-abc123');
  });

  it('no mint (router bypassed / provider degraded) → correlationId null, never fabricated', async () => {
    const { r2 } = await runTwoTicks({ onCorrelationIdValue: null });
    expect(one(r2).decision.correlationId).toBeNull();
  });

  it('a floor-vetoed candidate still enrolls (the verdict is graded against what was ENACTED, not skipped)', async () => {
    const { classifyCalls } = await runTwoTicks({ facts: permitFacts({ ownerAppRunning: true }) });
    const ctx = classifyCalls[0]!.provenance!.context! as Record<string, unknown>;
    expect(ctx.floorPermitted).toBe(false);
    expect(ctx.floorVetoReason).toBe('owner-app-running');
  });
});

describe('runScanTick — the enacted-disposition space (§5.3, 10 values)', () => {
  it('watch-only kill → would-kill', async () => {
    const { r2 } = await runTwoTicks({ arm: LIVE_ARM(true, validMarker) });
    const o = one(r2);
    expect(o.enacted).toBe('would-kill');
    expect(o.decision).toMatchObject({ verdict: 'kill', enacted: 'would-kill', floorPermitted: true, ledgerKey: 'lk', classId: CLASS, commandHash: 'ch' });
  });

  it('armed kill → killed', async () => {
    const { r2 } = await runTwoTicks({ arm: LIVE_ARM(false, validMarker) });
    expect(one(r2).enacted).toBe('killed');
  });

  it('armed + exits during grace → sigterm-exited', async () => {
    const { r2 } = await runTwoTicks({ arm: LIVE_ARM(false, validMarker), alive: false });
    expect(one(r2).enacted).toBe('sigterm-exited');
  });

  it('armed + open workspace file → deferred', async () => {
    const { r2 } = await runTwoTicks({ arm: LIVE_ARM(false, validMarker), hasOpenFile: true });
    expect(one(r2).enacted).toBe('deferred');
  });

  it('armed + identity changed mid-funnel → aborted', async () => {
    const { r2 } = await runTwoTicks({ arm: LIVE_ARM(false, validMarker), reReadFacts: null });
    expect(one(r2).enacted).toBe('aborted');
  });

  it('model spared (leave) → alert-only-model-spared with floorPermitted recorded true', async () => {
    const { r2 } = await runTwoTicks({ verdict: '{"action":"leave"}' });
    const o = one(r2);
    expect(o.enacted).toBe('alert-only-model-spared');
    expect(o.decision).toMatchObject({ verdict: 'leave', floorPermitted: true });
  });

  it('kill verdict vetoed by the floor → alert-only-floor-veto (never graded as an executed kill)', async () => {
    const { r2 } = await runTwoTicks({ facts: permitFacts({ ownerAppRunning: true }) });
    const o = one(r2);
    expect(o.enacted).toBe('alert-only-floor-veto');
    expect(o.decision).toMatchObject({ verdict: 'kill', floorPermitted: false });
  });

  it('P19 breaker tripped → alert-only-breaker-held', async () => {
    let ledger = EMPTY_KILL_LEDGER;
    for (let i = 0; i < 3; i++) ledger = recordKill(ledger, { key: 'lk', classId: CLASS, atMs: 1_000 + i }, 3_600_000, 1_000 + i);
    const { r2 } = await runTwoTicks({ ledger });
    expect(one(r2).enacted).toBe('alert-only-breaker-held');
  });

  it('decider unavailable → decider-unavailable (verdict AND enacted)', async () => {
    const { r2 } = await runTwoTicks({ verdict: null });
    const o = one(r2);
    expect(o.enacted).toBe('decider-unavailable');
    expect(o.decision.verdict).toBe('decider-unavailable');
  });

  it('over-cap degrade → decider-unavailable, NO classify call, null correlation id, floorPermitted false', async () => {
    const { r2, classifyCalls } = await runTwoTicks({ cap: 0 });
    const o = one(r2);
    expect(classifyCalls).toHaveLength(0);
    expect(o.enacted).toBe('decider-unavailable');
    expect(o.decision).toMatchObject({ verdict: 'decider-unavailable', correlationId: null, floorPermitted: false });
    // The identity tuples still ride the seed (the store can carry re-flag evidence).
    expect(o.decision.targetTuple.pid).toBe(9000);
  });
});

describe('runScanTick — member-wise ownerTuple (§5.3, ADV r4/r5)', () => {
  it('a floor-VETOED null-parse kill verdict writes WITHOUT parentPid — no throw, nothing hard-asserted', async () => {
    const facts = permitFacts({ argv: `/App/Code Helper (Plugin) --type=extensionHost --password ${SECRET}`, ownerAppRunning: true });
    // Sanity: the floor really does veto this shape (owner cannot be established).
    expect(evaluateKillFloor(facts).permitted).toBe(false);
    const { r2 } = await runTwoTicks({ facts });
    const o = one(r2);
    expect(o.enacted).toBe('alert-only-floor-veto');
    expect(o.decision.ownerTuple).toEqual({}); // member-wise: absent, not fabricated
  });

  it('orphan kill (parent dead): parentPid recorded, parentStartTimeMs absent', async () => {
    const { r2 } = await runTwoTicks(); // tree has no pid 1 → parent dead
    expect(one(r2).decision.ownerTuple).toEqual({ parentPid: 1 });
  });

  it('live parent with parseable lstart: both members recorded', async () => {
    const parentStart = 'Wed Jul 2 08:00:00 2026';
    const tree: ProcTree = new Map([[1, { pid: 1, ppid: 0, startTime: parentStart }]]);
    const { r2 } = await runTwoTicks({ tree, facts: permitFacts({ ownerAppRunning: true }) });
    expect(one(r2).decision.ownerTuple).toEqual({ parentPid: 1, parentStartTimeMs: Date.parse(parentStart) });
  });

  it('targetTuple carries the candidate identity with the lstart parsed for ordering', async () => {
    const { r2 } = await runTwoTicks();
    expect(one(r2).decision.targetTuple).toEqual({ pid: 9000, startTimeMs: Date.parse(START) });
  });
});

describe('pure helpers', () => {
  it('deriveHogOwnerTuple: no provenance token → {}; dead parent → pid only; live parseable parent → both', () => {
    const tree: ProcTree = new Map([[7, { pid: 7, ppid: 1, startTime: 'Wed Jul 2 08:00:00 2026' }]]);
    expect(deriveHogOwnerTuple('/bin/thing --no-token', tree)).toEqual({});
    expect(deriveHogOwnerTuple('/bin/thing --parentPid=99', tree)).toEqual({ parentPid: 99 });
    expect(deriveHogOwnerTuple('/bin/thing --parentPid=7', tree)).toEqual({ parentPid: 7, parentStartTimeMs: Date.parse('Wed Jul 2 08:00:00 2026') });
    // A live parent with an un-parseable lstart records the pid member only.
    const opaque: ProcTree = new Map([[7, { pid: 7, ppid: 1, startTime: 'S7' }]]);
    expect(deriveHogOwnerTuple('/bin/thing --parentPid=7', opaque)).toEqual({ parentPid: 7 });
  });

  it('buildHogDecisionContext clamps the name and never includes argv', () => {
    const ctx = buildHogDecisionContext({
      id: { commandHash: 'ch', ledgerKey: 'lk', classId: CLASS },
      facts: permitFacts({ name: 'x'.repeat(500) }),
      floor: { permitted: true, matchedClass: CLASS },
      coreEquivalents: 2.5,
      targetTuple: { pid: 9000, startTimeMs: 123 },
      ownerTuple: { parentPid: 1 },
    });
    expect((ctx.name as string).length).toBe(200);
    expect(JSON.stringify(ctx)).not.toContain(SECRET);
    expect(ctx.parentPid).toBe(1);
  });
});
