/**
 * GAP-B integration — the composed reaped-session pipeline (spec §7 integration).
 *
 * Re-creates the exact sequence the server's `sessionReaped` handler runs, but
 * with the REAL units (CommitmentTracker, the GAP-B decision, evidenceEligible,
 * ReapLog), so the seams between them are exercised end-to-end without a full
 * server boot:
 *
 *   reap → gapBEligibleForTopic (real CommitmentTracker + shared recency)
 *        → decideGapBInjection (dark-gate)
 *        → candidate reason/evidence (COMMITMENT_ACTIVE_RUN_REASON + strong signal)
 *        → evidenceEligible (the already-shipped revival gate)
 *        → ReapLog.recordReaped (evidenceSource:'commitment')
 *
 * Asserts: an unregistered-but-committed age-limit reap becomes resume-ELIGIBLE
 * and the reap-log row carries `evidenceSource:'commitment'` (LIVE only); the
 * dryRun path is eligible-in-verdict but tags NOTHING; a stale-per-KEEP
 * commitment is the strict no-op (the anti-loop agreement holds end-to-end).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import { evidenceEligible, COMMITMENT_ACTIVE_RUN_REASON } from '../../src/core/WorkEvidence.js';
import {
  gapBEligibleForTopic,
  resolveGapBInjectionGate,
  decideGapBInjection,
} from '../../src/core/gapBCommitmentEvidence.js';

const TOPIC = 7777;
const OWN = 'machine-A';
const FRESH = 6 * 60 * 60_000;
const STALE = 8 * 60 * 60_000;

interface H { dir: string; tracker: CommitmentTracker; reapLog: ReapLog; cleanup: () => void; }

function mk(): H {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapb-int-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '..', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ updates: { autoApply: true } }));
  const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir), originMachineId: OWN });
  const reapLog = new ReapLog(path.join(dir, 'state'), () => OWN);
  return { dir, tracker, reapLog, cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/gapB-commitment-evidence-pipeline.test.ts' }) };
}

function freshCommitment(h: H): void {
  const c = h.tracker.record({ userRequest: 'go autonomous', agentResponse: 'on it', type: 'one-time-action', topicId: TOPIC });
  // Pin createdAt fresh (1h).
  h.tracker.getAll().find((x) => x.id === c.id)!.createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
}

/** Mirror the handler's compose: eligibility → decision → candidate → eligible-gate → reap-log. */
function runHandler(
  h: H,
  opts: { recentUser: boolean; gate: ReturnType<typeof resolveGapBInjectionGate>; stateFilePresent?: boolean },
): { resumeEligible: boolean; loggedEvidenceSource: string | undefined } {
  const deps = {
    ownMachineId: OWN,
    freshCommitmentWindowMs: FRESH,
    staleCommitmentWindowMs: STALE,
    recentUserMessage: () => opts.recentUser,
  };
  const eligible = gapBEligibleForTopic(TOPIC, h.tracker, deps);
  const decision = decideGapBInjection({
    gate: opts.gate,
    reason: 'age-limit',
    stateFilePresent: opts.stateFilePresent ?? false,
    eligible,
  });
  let workEvidence: string[] = [];
  let reason = 'age-limit';
  if (decision.inject) {
    reason = COMMITMENT_ACTIVE_RUN_REASON;
    workEvidence = [...workEvidence, 'build-or-autonomous-active'];
  }
  // The already-shipped revival gate (topic-bound session).
  const resumeEligible = evidenceEligible(workEvidence, /* topicBound */ true);
  h.reapLog.recordReaped({
    session: 'topic-7777',
    tmuxSession: 'agent-topic-7777',
    reason,
    workEvidence,
    ...(decision.inject ? { evidenceSource: 'commitment' as const } : {}),
  });
  const lines = fs.readFileSync(path.join(h.dir, 'state', '..', 'logs', 'reap-log.jsonl'), 'utf-8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  return { resumeEligible, loggedEvidenceSource: last.evidenceSource };
}

describe('GAP-B pipeline — armed + LIVE', () => {
  let h: H;
  beforeEach(() => { h = mk(); });
  afterEach(() => h.cleanup());

  it('an unregistered-but-committed age-limit reap becomes resume-ELIGIBLE + evidenceSource:commitment', () => {
    freshCommitment(h);
    const r = runHandler(h, { recentUser: true, gate: resolveGapBInjectionGate({ enabled: true, dryRun: false }) });
    expect(r.resumeEligible).toBe(true);
    expect(r.loggedEvidenceSource).toBe('commitment');
  });

  it('ANTI-LOOP: a stale-per-KEEP commitment (no recent user msg) is NOT eligible, tags nothing', () => {
    freshCommitment(h);
    const r = runHandler(h, { recentUser: false, gate: resolveGapBInjectionGate({ enabled: true, dryRun: false }) });
    expect(r.resumeEligible).toBe(false);
    expect(r.loggedEvidenceSource).toBeUndefined();
  });

  it('a PRESENT state file ⇒ GAP-B does not fire (registered run handled upstream)', () => {
    freshCommitment(h);
    const r = runHandler(h, { recentUser: true, gate: resolveGapBInjectionGate({ enabled: true, dryRun: false }), stateFilePresent: true });
    expect(r.resumeEligible).toBe(false);
    expect(r.loggedEvidenceSource).toBeUndefined();
  });
});

describe('GAP-B pipeline — DARK (disarmed default) + dryRun', () => {
  let h: H;
  beforeEach(() => { h = mk(); });
  afterEach(() => h.cleanup());

  it('disarmed (omitted config) ⇒ NOT eligible, tags nothing (the containment)', () => {
    freshCommitment(h);
    const r = runHandler(h, { recentUser: true, gate: resolveGapBInjectionGate(undefined) });
    expect(r.resumeEligible).toBe(false);
    expect(r.loggedEvidenceSource).toBeUndefined();
  });

  it('armed + dryRun ⇒ eligible verdict but injects nothing (logs-but-does-not-enqueue)', () => {
    freshCommitment(h);
    // The verdict fires (Part A would surface), but no evidence is tagged → the
    // candidate is NOT resume-eligible → the drainer never spawns.
    const r = runHandler(h, { recentUser: true, gate: resolveGapBInjectionGate({ enabled: true }) });
    expect(r.resumeEligible).toBe(false);
    expect(r.loggedEvidenceSource).toBeUndefined();
  });
});
