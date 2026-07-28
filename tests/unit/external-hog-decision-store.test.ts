import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import {
  ExternalHogDecisionStore,
  hogDecisionStorePath,
  evaluateHogSustainedRight,
  hogRuleRegistryAgrees,
  HOG_RESPAWN_WRONG_RULE_ID,
  HOG_LEAVE_RECURRENCE_RULE_ID,
  type HogEvidenceScanView,
  type HogEvidenceCandidate,
} from '../../src/monitoring/ExternalHogDecisionStore.js';
import type { HogDecisionSeed } from '../../src/monitoring/ExternalHogScanTick.js';

/**
 * ExternalHogDecisionStore — the durable §5.3 decision carrier (llm-decision-quality-meter):
 * ArmStore at-rest posture (atomic tmp+fsync+rename, 0600, fail-closed reads), hydration at
 * construction, retention derivation max(evidenceWindow+slack, breakerWindow), the
 * latest-plus-in-window-kill slot semantics, and grade-on-supersede ordering (the OUTGOING
 * record is graded BEFORE replacement). Injected wall clock everywhere — no real-time waits.
 */

const T0 = 1_750_000_000_000; // fixed epoch base (injected clock — never the real clock)
const HOUR = 60 * 60 * 1000;

let dir: string;
let wall: number;
const nowMs = () => wall;

function makeStore(over: {
  evidenceWindowHours?: number;
  gradingSlackHours?: number;
  killLedgerBreakerWindowMs?: number;
} = {}): ExternalHogDecisionStore {
  return new ExternalHogDecisionStore({
    stateDir: dir,
    config: {
      provenance: {
        quality: {
          evidenceWindowHours: over.evidenceWindowHours ?? 6,
          gradingSlackHours: over.gradingSlackHours ?? 2,
        },
      },
    },
    killLedgerBreakerWindowMs: over.killLedgerBreakerWindowMs ?? 3_600_000,
    nowMs,
    dryRun: false, // these tests exercise the LIVE persist path (dryRun now defaults TRUE — §5.2)
  });
}

function seed(over: Partial<HogDecisionSeed> = {}): HogDecisionSeed {
  return {
    ledgerKey: 'vscode-exthost:hashA',
    classId: 'vscode-exthost',
    commandHash: 'hashA',
    verdict: 'kill',
    enacted: 'killed',
    correlationId: 'd-kill-1',
    targetTuple: { pid: 900, startTimeMs: T0 - HOUR },
    ownerTuple: { parentPid: 400 },
    floorPermitted: true,
    ...over,
  };
}

function view(cands: HogEvidenceCandidate[] = [], alive: Record<number, number | null> = {}): HogEvidenceScanView {
  return {
    candidates: cands,
    aliveStartTimeMs: (pid) => (pid in alive ? alive[pid] : undefined),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hog-decision-store-'));
  wall = T0;
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/external-hog-decision-store.test.ts' });
});

describe('ExternalHogDecisionStore — at-rest posture', () => {
  it('writes atomically under <stateDir>/state/, mode 0600, no tmp leftovers', () => {
    const store = makeStore();
    store.record(seed(), view());
    const file = hogDecisionStorePath(dir);
    expect(file).toBe(path.join(dir, 'state', 'external-hog-decisions.json'));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('hydrates at construction: a fresh store instance sees the persisted records', () => {
    makeStore().record(seed(), view());
    const rehydrated = makeStore();
    const slot = rehydrated.get('vscode-exthost:hashA');
    expect(slot?.latest?.correlationId).toBe('d-kill-1');
    expect(slot?.latest?.enacted).toBe('killed');
    expect(slot?.latest?.atMs).toBe(T0);
    expect(slot?.latest?.effectiveWindowMs).toBe(6 * HOUR);
    expect(slot?.kill?.correlationId).toBe('d-kill-1'); // an enacted kill takes the kill slot
    // list(): latest === kill collapses to ONE row (no double-count after hydration).
    expect(rehydrated.list()).toHaveLength(1);
  });

  it('fail-closed reads: garbage / wrong-shape files hydrate EMPTY, never throw', () => {
    const file = hogDecisionStorePath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const content of ['{{{{not json', '"a string"', JSON.stringify({ version: 1, slots: 42 }), JSON.stringify({ version: 1, slots: [1, 2] })]) {
      fs.writeFileSync(file, content);
      const store = makeStore();
      expect(store.list()).toEqual([]);
    }
  });

  it('fail-closed per record: a malformed record is dropped, a valid sibling is kept', () => {
    makeStore().record(seed(), view()); // produce a valid file
    const file = hogDecisionStorePath(dir);
    const shape = JSON.parse(fs.readFileSync(file, 'utf-8')) as { slots: Record<string, unknown> };
    shape.slots['bad-key'] = { latest: { verdict: 'kill', enacted: 'NOT-A-DISPOSITION', atMs: 'yesterday' } };
    fs.writeFileSync(file, JSON.stringify(shape));
    const store = makeStore();
    expect(store.get('vscode-exthost:hashA')?.latest?.correlationId).toBe('d-kill-1');
    expect(store.get('bad-key')).toBeUndefined();
  });
});

describe('ExternalHogDecisionStore — retention derivation (§5.3)', () => {
  it('retention = max(evidenceWindow + gradingSlack, breakerWindow)', () => {
    expect(makeStore().retentionMs).toBe(8 * HOUR); // 6h + 2h > 1h breaker
    expect(makeStore({ evidenceWindowHours: 0.5, gradingSlackHours: 0.25, killLedgerBreakerWindowMs: 2 * HOUR }).retentionMs)
      .toBe(2 * HOUR); // the breaker window dominates
  });

  it('invalid config values fall back to the inline defaults (6h/2h) — never seeded, never NaN', () => {
    const store = new ExternalHogDecisionStore({
      stateDir: dir,
      config: { provenance: { quality: { evidenceWindowHours: -1, gradingSlackHours: Number.NaN } } },
      killLedgerBreakerWindowMs: 3_600_000,
      nowMs,
    });
    expect(store.evidenceWindowMs).toBe(6 * HOUR);
    expect(store.retentionMs).toBe(8 * HOUR);
    // No config at all → same defaults.
    const bare = new ExternalHogDecisionStore({ stateDir: dir, killLedgerBreakerWindowMs: 3_600_000, nowMs });
    expect(bare.retentionMs).toBe(8 * HOUR);
  });

  it('prunes on write at retention: an aged-out record is dropped; an in-retention one survives', () => {
    const store = makeStore();
    store.record(seed({ ledgerKey: 'k1', commandHash: 'h1' }), view());
    wall = T0 + 8 * HOUR - 1; // just inside retention
    store.record(seed({ ledgerKey: 'k2', commandHash: 'h2', correlationId: 'd-2' }), view());
    expect(store.get('k1')).toBeDefined();
    wall = T0 + 8 * HOUR + 1; // past retention for k1
    store.record(seed({ ledgerKey: 'k3', commandHash: 'h3', correlationId: 'd-3' }), view());
    expect(store.get('k1')).toBeUndefined(); // pruned (both slots)
    expect(store.get('k2')).toBeDefined(); // still in retention
  });
});

describe('ExternalHogDecisionStore — slot semantics (§5.3, ADV r3)', () => {
  it('a kill evidence slot is NEVER evicted by a same-key non-kill flood before its window closes', () => {
    const store = makeStore();
    store.record(seed({ correlationId: 'd-kill-orig' }), view());
    for (let i = 0; i < 5; i++) {
      wall = T0 + (i + 1) * 60_000;
      store.record(
        seed({ verdict: 'leave', enacted: 'alert-only-model-spared', correlationId: `d-flood-${i}`, targetTuple: { pid: 910 + i, startTimeMs: T0 } }),
        view(),
      );
    }
    const slot = store.get('vscode-exthost:hashA');
    expect(slot?.kill?.correlationId).toBe('d-kill-orig'); // the kill slot held
    expect(slot?.latest?.correlationId).toBe('d-flood-4'); // latest tracks the newest decision
    // list() carries BOTH retained slots.
    expect(store.list().map((r) => r.slot).sort()).toEqual(['kill', 'latest']);
  });

  it('a newer ENACTED kill takes the kill slot (the outgoing kill was graded at supersede first)', () => {
    const store = makeStore();
    store.record(seed({ correlationId: 'd-kill-1' }), view());
    wall = T0 + HOUR;
    store.record(seed({ correlationId: 'd-kill-2', enacted: 'sigterm-exited', targetTuple: { pid: 901, startTimeMs: T0 } }), view());
    expect(store.get('vscode-exthost:hashA')?.kill?.correlationId).toBe('d-kill-2');
  });
});

describe('ExternalHogDecisionStore — grade-on-supersede (§5.3, ADV/DC r3)', () => {
  it('the OUTGOING leave record is graded BEFORE replacement — same-process re-flag → wrong', () => {
    const store = makeStore();
    const tuple = { pid: 900, startTimeMs: T0 - HOUR };
    store.record(
      seed({ verdict: 'leave', enacted: 'alert-only-model-spared', correlationId: 'd-leave-1', targetTuple: tuple }),
      view(),
    );
    wall = T0 + 30 * 60_000; // 30 min later, in-window
    const events = store.record(
      seed({ verdict: 'leave', enacted: 'alert-only-model-spared', correlationId: 'd-leave-2', targetTuple: tuple }),
      view([{ pid: 900, startTimeMs: T0 - HOUR, commandHash: 'hashA' }]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleId: HOG_LEAVE_RECURRENCE_RULE_ID,
      grade: 'wrong',
      correlationId: 'd-leave-1', // the OUTGOING record's id — graded before replacement
      windowMs: 6 * HOUR,
    });
    // Replacement happened AFTER grading.
    expect(store.get('vscode-exthost:hashA')?.latest?.correlationId).toBe('d-leave-2');
  });

  it('a DIFFERENT process with the same commandHash grades the leave unknown (lookalike spoof cannot fabricate wrong)', () => {
    const store = makeStore();
    store.record(
      seed({ verdict: 'leave', enacted: 'alert-only-model-spared', correlationId: 'd-leave-1', targetTuple: { pid: 900, startTimeMs: T0 - HOUR } }),
      view(),
    );
    wall = T0 + 30 * 60_000;
    const events = store.record(
      seed({ verdict: 'leave', enacted: 'alert-only-model-spared', correlationId: 'd-leave-2', targetTuple: { pid: 950, startTimeMs: T0 } }),
      view(),
    );
    expect(events).toEqual([expect.objectContaining({ ruleId: HOG_LEAVE_RECURRENCE_RULE_ID, grade: 'unknown', correlationId: 'd-leave-1' })]);
  });

  it('respawn evidence at supersede: ordering test TRUE → the outgoing kill grades wrong', () => {
    const store = makeStore();
    store.record(seed({ correlationId: 'd-kill-1', ownerTuple: { parentPid: 400 }, targetTuple: { pid: 900, startTimeMs: T0 - HOUR } }), view());
    wall = T0 + HOUR;
    const events = store.record(
      seed({ verdict: 'kill', enacted: 'would-kill', correlationId: 'd-next', targetTuple: { pid: 951, startTimeMs: T0 + 30 * 60_000 } }),
      // The respawned candidate + a live parent at pid 400 that started BEFORE the killed child.
      view([{ pid: 951, startTimeMs: T0 + 30 * 60_000, commandHash: 'hashA' }], { 400: T0 - 2 * HOUR }),
    );
    expect(events).toContainEqual(expect.objectContaining({ ruleId: HOG_RESPAWN_WRONG_RULE_ID, grade: 'wrong', correlationId: 'd-kill-1' }));
  });

  it('supersede stamps reFlaggedAtMs on the in-window kill slot → window-close right is refused', () => {
    const store = makeStore();
    store.record(seed({ correlationId: 'd-kill-1' }), view());
    wall = T0 + HOUR;
    store.record(
      seed({ verdict: 'leave', enacted: 'alert-only-model-spared', correlationId: 'd-later', targetTuple: { pid: 950, startTimeMs: T0 } }),
      view(),
    );
    const kill = store.get('vscode-exthost:hashA')?.kill;
    expect(kill?.reFlaggedAtMs).toBe(T0 + HOUR);
    // At window close, hog-sustained-right-v1 refuses (negative evidence destroyed).
    expect(evaluateHogSustainedRight(kill!, T0 + 6 * HOUR + 1)).toBeNull();
  });

  it('an un-superseded enacted kill grades right at window close (the grading job path)', () => {
    const store = makeStore();
    store.record(seed({ correlationId: 'd-kill-1' }), view());
    const kill = store.get('vscode-exthost:hashA')?.kill;
    expect(evaluateHogSustainedRight(kill!, T0 + 6 * HOUR - 1)).toBeNull(); // window still open
    expect(evaluateHogSustainedRight(kill!, T0 + 6 * HOUR + 1)).toBe('right'); // closed, no re-flag
  });

  it('re-flag persists across hydration (the marker is durable, not in-memory)', () => {
    const store = makeStore();
    store.record(seed({ correlationId: 'd-kill-1' }), view());
    wall = T0 + HOUR;
    store.record(seed({ verdict: 'leave', enacted: 'alert-only-model-spared', correlationId: 'd-x', targetTuple: { pid: 950, startTimeMs: T0 } }), view());
    const rehydrated = makeStore();
    expect(rehydrated.get('vscode-exthost:hashA')?.kill?.reFlaggedAtMs).toBe(T0 + HOUR);
  });
});

describe('rule registry agreement (§5.4.2 owner pins)', () => {
  it('the sentinel-emitted rules are registered to ExternalHogSentinel; sustained-right to DecisionGrading', () => {
    expect(hogRuleRegistryAgrees()).toBe(true);
  });
});

/**
 * §5.2/§5.7 dryRun stage (the wiring-integrity + threat-shaped test the P7 build
 * requires): while the seam is in dryRun (the SAFE default), the store SUPPRESSES
 * its durable persist — the spec's "dry-run suppresses all durable writes"
 * invariant — but STILL runs grade-on-supersede in-memory so the annotate seam's
 * would-write soak stays complete. The metadata-only would-write line is the only
 * output. dryRun:false is the LIVE persist path.
 */
describe('ExternalHogDecisionStore — §5.2 dryRun suppresses the durable persist', () => {
  function dryRunStore(log?: (m: string) => void): ExternalHogDecisionStore {
    return new ExternalHogDecisionStore({
      stateDir: dir,
      config: { provenance: { quality: { evidenceWindowHours: 6, gradingSlackHours: 2 } } },
      killLedgerBreakerWindowMs: 3_600_000,
      nowMs,
      // dryRun OMITTED → defaults TRUE (the recorder's `!== false` safe default).
      ...(log ? { log } : {}),
    });
  }

  it('dryRun (the default) writes NO store file, yet records in-memory + logs a METADATA-ONLY would-write line', () => {
    const logs: string[] = [];
    const store = dryRunStore((m) => logs.push(m));
    const events = store.record(seed(), view());

    // 1. THREAT: no durable write — the ground-truth file is never created.
    expect(fs.existsSync(hogDecisionStorePath(dir))).toBe(false);
    // 2. In-memory grade-on-supersede still ran — the record is queryable in-process.
    expect(store.get('vscode-exthost:hashA')?.latest?.correlationId).toBe('d-kill-1');
    expect(store.list()).toHaveLength(1);
    expect(events).toEqual([]); // first write for the key → no outgoing record to grade
    // 3. The would-write line fired and is metadata-only (counts + byte size —
    //    NEVER the pid / commandHash / correlation id / argv).
    const wouldWrite = logs.find((l) => l.includes('dryRun would-persist hog-store'));
    expect(wouldWrite).toBeDefined();
    expect(wouldWrite).toMatch(/ledgerKeys=1 bytes=\d+/);
    expect(wouldWrite).not.toContain('hashA');
    expect(wouldWrite).not.toContain('d-kill-1');
    expect(wouldWrite).not.toContain('900'); // no pid
  });

  it('a same-key supersede in dryRun still grades the outgoing decision in-memory — and STILL writes no file', () => {
    const store = dryRunStore();
    // leave (model-spared, floor-permitted), then the SAME process re-flags → leave-recurrence 'wrong'.
    const base = { verdict: 'leave' as const, enacted: 'alert-only-model-spared' as const, targetTuple: { pid: 950, startTimeMs: T0 } };
    store.record(seed({ ...base, correlationId: 'd-leave-1' }), view());
    const events = store.record(seed({ ...base, correlationId: 'd-leave-2' }), view());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ruleId: HOG_LEAVE_RECURRENCE_RULE_ID, grade: 'wrong', correlationId: 'd-leave-1' });
    expect(fs.existsSync(hogDecisionStorePath(dir))).toBe(false); // durable write STILL suppressed
  });

  it('dryRun:false is the LIVE path — the store file IS written and hydrates', () => {
    const store = new ExternalHogDecisionStore({
      stateDir: dir,
      config: { provenance: { quality: { evidenceWindowHours: 6, gradingSlackHours: 2 } } },
      killLedgerBreakerWindowMs: 3_600_000,
      nowMs,
      dryRun: false,
    });
    store.record(seed(), view());
    expect(fs.existsSync(hogDecisionStorePath(dir))).toBe(true);
    // A fresh LIVE instance hydrates the persisted record (proves a real durable write).
    const rehydrated = new ExternalHogDecisionStore({
      stateDir: dir,
      config: { provenance: { quality: { evidenceWindowHours: 6, gradingSlackHours: 2 } } },
      killLedgerBreakerWindowMs: 3_600_000,
      nowMs,
      dryRun: false,
    });
    expect(rehydrated.get('vscode-exthost:hashA')?.latest?.correlationId).toBe('d-kill-1');
  });
});
