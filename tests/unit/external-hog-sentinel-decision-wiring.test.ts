import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { ExternalHogSentinel, type ExternalHogAdapters, type HogOutcomeAnnotation } from '../../src/monitoring/ExternalHogSentinel.js';
import {
  ExternalHogDecisionStore, hogDecisionStorePath,
  HOG_LEAVE_RECURRENCE_RULE_ID, HOG_ENACTED_DISPOSITION_RULE_ID, EXTERNAL_HOG_SENTINEL_COMPONENT,
} from '../../src/monitoring/ExternalHogDecisionStore.js';
import type { ProcTableRow } from '../../src/monitoring/ExternalHogProcTable.js';
import type { ExternalHogFacts } from '../../src/monitoring/ExternalHogFloor.js';
import type { ExternalHogRuntimeOpts } from '../../src/monitoring/ExternalHogSentinel.js';

/**
 * ExternalHogSentinel × ExternalHogDecisionStore wiring (§5.3): every per-candidate decision is
 * persisted durably per tick; grade-on-supersede grade events + the immediate enacted-disposition
 * self-reports route through the injected annotate seam; a store failure is counted, never thrown
 * into the tick. Injected clocks everywhere (scan clock AND the store's wall clock).
 */

const OWN = 501;
const START = 'Wed Jul 2 10:00:00 2026'; // parseable lstart → orderable targetTuple
const T0 = 1_750_000_000_000;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hog-sentinel-dq-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/external-hog-sentinel-decision-wiring.test.ts' }); });

function hogRow(cputime: number): ProcTableRow {
  return { pid: 9000, ppid: 1, uid: OWN, startTime: START, cputimeSeconds: cputime, comm: 'Code Helper (Plugin)' };
}

function facts(): ExternalHogFacts {
  return {
    name: 'Code Helper (Plugin)', argv: '/App/Code Helper (Plugin) --type=extensionHost --parentPid=1',
    pid: 9000, ownerAppRunning: false, sustainedHighCpu: true, isInstarProcess: false,
    ownerRootDaemon: false, hasLaunchctlLabel: false, targetUid: OWN, ownEuid: OWN,
  };
}

const OPTS: ExternalHogRuntimeOpts = {
  sampler: { ownEuid: OWN, cpuCoreThreshold: 1.5, sampleWindowMs: 30_000, maxAncestorHops: 30 },
  sustainedSampleCount: 1,
  maxClassificationsPerScan: 4,
  breaker: { windowMs: 3_600_000, maxPerWindow: 3, keyIsVolatile: false },
  killFunnel: { sigtermGraceMs: 0, maxKillDeferrals: 3 },
  noticeBudgetPerWindow: 4,
  killLedgerRetentionMs: 3_600_000,
  samplerDeadThresholdMs: 120_000,
};

/** Fake adapters: tick N serves table[min(N, last)]; classifier returns `verdict` and mints d-t<N>. */
function makeHarness(verdict: string) {
  let tick = 0;
  let mint = 0;
  const tables = [[hogRow(100)], [hogRow(160)], [hogRow(220)], [hogRow(280)]];
  const adapters: ExternalHogAdapters = {
    readProcTable: async () => tables[Math.min(tick, tables.length - 1)]!,
    ownedRefs: async () => new Map(),
    factsFor: () => facts(),
    identityFor: () => ({ commandHash: 'ch', ledgerKey: 'lk', classId: 'vscode-exthost' }),
    classify: async (_f, provenance) => {
      mint += 1;
      provenance?.onCorrelationId?.(`d-t${mint}`);
      return verdict;
    },
    killFunnelDeps: {
      reReadFacts: () => facts(),
      reReadArmState: () => ({ config: { enabled: true, dryRun: true }, marker: null, lastDisarmEpoch: 0 }),
      currentClassContentHash: () => 'h',
      hasOpenWritableWorkspaceFile: () => false,
      sendSignal: () => {},
      stillAlive: () => true,
      wait: async () => {},
    },
    deliverNotices: () => {},
    armStatus: () => ({ enabled: true, dryRun: true, markerValid: false }),
    nowMs: () => tick * 30_000,
  };
  return { adapters, nextTick: () => { tick += 1; } };
}

function makeStore(wall: () => number): ExternalHogDecisionStore {
  // dryRun:false — this suite verifies the LIVE §5.3 durable-recording path (the
  // store's dryRun flag now defaults TRUE and suppresses the persist, §5.2).
  return new ExternalHogDecisionStore({ stateDir: dir, killLedgerBreakerWindowMs: 3_600_000, nowMs: wall, dryRun: false });
}

describe('ExternalHogSentinel — durable decision recording (§5.3)', () => {
  it('persists every per-candidate decision into the store, with the minted correlation id', async () => {
    let wall = T0;
    const store = makeStore(() => wall);
    const { adapters, nextTick } = makeHarness('{"action":"kill"}');
    const sentinel = new ExternalHogSentinel(adapters, OPTS, { decisionStore: store });

    await sentinel.tick(); nextTick(); // baseline — no candidate yet
    wall += 30_000;
    await sentinel.tick();            // the hog decision lands
    const slot = store.get('lk');
    expect(slot?.latest).toMatchObject({
      verdict: 'kill', enacted: 'would-kill', correlationId: 'd-t1',
      targetTuple: { pid: 9000, startTimeMs: Date.parse(START) },
      ownerTuple: { parentPid: 1 }, floorPermitted: true, commandHash: 'ch',
    });
    expect(fs.existsSync(hogDecisionStorePath(dir))).toBe(true);
    const status = sentinel.status();
    expect(status.decisionQuality).toMatchObject({ storeWired: true, annotateBound: false, recordsWritten: 1, storeErrors: 0 });
  });

  it('routes the enacted self-report + supersede grade events through the annotate seam', async () => {
    let wall = T0;
    const store = makeStore(() => wall);
    const annotations: HogOutcomeAnnotation[] = [];
    const { adapters, nextTick } = makeHarness('{"action":"leave"}');
    const sentinel = new ExternalHogSentinel(adapters, OPTS, { decisionStore: store, annotate: (a) => annotations.push(a) });

    await sentinel.tick(); nextTick(); // baseline
    wall += 30_000;
    await sentinel.tick(); nextTick(); // leave decision 1 (model spared, floor permitted)
    expect(annotations).toHaveLength(1); // the immediate enacted-disposition self-report
    expect(annotations[0]).toMatchObject({
      correlationId: 'd-t1',
      gradedBy: { component: EXTERNAL_HOG_SENTINEL_COMPONENT, ruleId: HOG_ENACTED_DISPOSITION_RULE_ID },
      grade: 'unknown',
      evidence: { kind: 'hog-enacted-disposition', enacted: 'alert-only-model-spared' },
    });

    wall += 30_000;
    await sentinel.tick(); // the SAME process re-flags → supersede grades the outgoing leave wrong
    const gradeAnnotations = annotations.filter((a) => a.gradedBy.ruleId === HOG_LEAVE_RECURRENCE_RULE_ID);
    expect(gradeAnnotations).toHaveLength(1);
    expect(gradeAnnotations[0]).toMatchObject({
      correlationId: 'd-t1', // the OUTGOING (graded) decision, not the new one
      grade: 'wrong',
      evidence: { kind: 'hog-evidence', windowMs: store.evidenceWindowMs },
    });
    expect(sentinel.status().decisionQuality.gradeEvents).toBe(1);
  });

  it('a store failure is counted in status(), never thrown into the tick', async () => {
    const throwing = { record: () => { throw new Error('disk full'); } } as unknown as ExternalHogDecisionStore;
    const { adapters, nextTick } = makeHarness('{"action":"kill"}');
    const sentinel = new ExternalHogSentinel(adapters, OPTS, { decisionStore: throwing });
    await sentinel.tick(); nextTick();
    await expect(sentinel.tick()).resolves.toBeDefined(); // the tick survives
    expect(sentinel.status().decisionQuality.storeErrors).toBe(1);
  });

  it('a throwing annotate seam is contained (the tick and the store write both survive)', async () => {
    let wall = T0;
    const store = makeStore(() => wall);
    const { adapters, nextTick } = makeHarness('{"action":"leave"}');
    const sentinel = new ExternalHogSentinel(adapters, OPTS, {
      decisionStore: store,
      annotate: () => { throw new Error('chokepoint rejected'); },
    });
    await sentinel.tick(); nextTick();
    wall += 30_000;
    await expect(sentinel.tick()).resolves.toBeDefined();
    expect(store.get('lk')?.latest?.correlationId).toBe('d-t1'); // the durable record still landed
  });

  it('unwired decision-quality deps are an honest no-op (no store file, counted in status)', async () => {
    const { adapters, nextTick } = makeHarness('{"action":"kill"}');
    const sentinel = new ExternalHogSentinel(adapters, OPTS); // no third arg — pre-wiring construction
    await sentinel.tick(); nextTick();
    await sentinel.tick();
    expect(fs.existsSync(hogDecisionStorePath(dir))).toBe(false);
    expect(sentinel.status().decisionQuality).toMatchObject({ storeWired: false, annotateBound: false, recordsWritten: 0 });
  });
});
