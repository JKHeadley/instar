/**
 * Parser/contract test for the FeedbackTriageArbiter and FeedbackTriageSecondOpinion LLM
 * callsites (registered in LLM_PARSER_CONTRACT), plus the triage store and packet floors
 * they rely on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FeedbackDrainStore, DrainConflictError } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import {
  FeedbackTriageArbiter, TriageContractViolation, TriageOutputRejected, secondOpinionSaysIgnore, triagePrompt,
  FEEDBACK_TRIAGE_DECISION_POINT, FEEDBACK_TRIAGE_PROMPT_ID, FEEDBACK_TRIAGE_SCHEMA_ID,
} from '../../../src/feedback-factory/triage/FeedbackTriageArbiter.js';
import { FeedbackTriageStore } from '../../../src/feedback-factory/triage/FeedbackTriageStore.js';
import { buildTriagePacket, nearestNeighbours } from '../../../src/feedback-factory/triage/triagePacket.js';
import { TRIAGE_AUTHORITY_ID, buildTriageAuthorityProposal } from '../../../src/feedback-factory/triage/triageAuthorityProposal.js';
import type { AuthorityRecord } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import type { IntelligenceOptions } from '../../../src/core/types.js';
import { decisionRow, packetsFrom, KEY } from '../../fixtures/feedbackTriageHarness.js';

const authority: AuthorityRecord = {
  authorityId: TRIAGE_AUTHORITY_ID, agentId: 'echo', ownerMachineId: 'm1', ownerEpoch: 1, provider: 'codex-cli', modelFamily: 'gpt-6-astra',
  promptVersion: FEEDBACK_TRIAGE_PROMPT_ID, schemaVersion: FEEDBACK_TRIAGE_SCHEMA_ID, decisionPointId: FEEDBACK_TRIAGE_DECISION_POINT,
  maxBatch: 20, maxTokens: 8000, maxDailySpendUsd: 5, generation: 1, revoked: false,
};
const packet = (id: string) => buildTriagePacket({
  cluster: { clusterId: id, title: 'Scheduler crash', description: '', type: 'bug', reportCount: 1 },
  reports: [{ feedbackId: `fb-${id}`, title: 'Scheduler crash', description: 'it crashed', type: 'bug', clusterId: id }],
  neighbours: [], mergedPrs: [], options: { reportsPerItem: 4, charsPerReport: 1200 }, now: 0,
}).packet;

function provider(answer: (prompt: string) => string, model = 'gpt-6-astra', framework = 'codex-cli') {
  const seen: { options?: IntelligenceOptions } = {};
  return {
    seen,
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      seen.options = options;
      options?.onModel?.({ model, framework });
      options?.provenance?.onCorrelationId?.('d-corr-1');
      return answer(prompt);
    },
  };
}

describe('FeedbackTriageArbiter contract', () => {
  it('returns parsed rows, the correlation id, and enrolls provenance on the feedback-triage decision point', async () => {
    const p = provider((prompt) => JSON.stringify({ decisions: packetsFrom(prompt).map((x) => decisionRow(x.clusterId)) }));
    const result = await new FeedbackTriageArbiter(p).decideBatch(authority, [packet('c1'), packet('c2')]);
    expect(result.rows.map((r) => r.clusterId)).toEqual(['c1', 'c2']);
    expect(result.correlationId).toBe('d-corr-1');
    expect(p.seen.options?.provenance?.decisionPoint).toBe('feedback-triage');
    expect(p.seen.options?.attribution).toMatchObject({ component: 'FeedbackTriageArbiter', category: 'gate', gating: true, injectionExposed: true });
    expect(p.seen.options).toMatchObject({ model: 'gpt-6-astra', strictModelPin: true,
      requiredRoute: { framework: 'codex-cli', modelId: 'gpt-6-astra' } });
  });
  it('wraps evidence as untrusted and carries the severity rubric', () => {
    const prompt = triagePrompt([packet('c1')]);
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('critical = data loss, security exposure');
    expect(prompt.lastIndexOf('<evidence>')).toBeGreaterThan(prompt.indexOf('Return JSON only'));
  });
  it('a different resolved model or framework is a contract violation (needs a new approval)', async () => {
    const answer = (prompt: string) => JSON.stringify({ decisions: packetsFrom(prompt).map((x) => decisionRow(x.clusterId)) });
    await expect(new FeedbackTriageArbiter(provider(answer, 'claude-opus-4-8', 'codex-cli')).decideBatch(authority, [packet('c1')])).rejects.toBeInstanceOf(TriageContractViolation);
    await expect(new FeedbackTriageArbiter(provider(answer, 'gpt-6-astra', 'claude-code')).decideBatch(authority, [packet('c1')])).rejects.toBeInstanceOf(TriageContractViolation);
    await expect(new FeedbackTriageArbiter(provider(answer, 'gpt-6-astra-preview', 'codex-cli')).decideBatch(authority, [packet('c1')])).rejects.toBeInstanceOf(TriageContractViolation);
  });
  it('a prompt/schema/decision-point mismatch is refused before any call', async () => {
    let called = false;
    const p = provider(() => { called = true; return ''; });
    await expect(new FeedbackTriageArbiter(p).decideBatch({ ...authority, promptVersion: 'feedback-triage-v0' }, [packet('c1')])).rejects.toMatchObject({ check: 'canary-mismatch' });
    expect(called).toBe(false);
    await expect(new FeedbackTriageArbiter(p).decideBatch({ ...authority, modelFamily: 'gpt-6-sol' }, [packet('c1')])).rejects.toMatchObject({ check: 'canary-mismatch' });
  });
  it('a batch outside the registered envelope is refused', async () => {
    const p = provider(() => '');
    await expect(new FeedbackTriageArbiter(p).decideBatch({ ...authority, maxBatch: 1 }, [packet('c1'), packet('c2')])).rejects.toMatchObject({ check: 'batch-envelope' });
  });
  it('an answer that fails the closed schema is rejected (never defaulted)', async () => {
    const p = provider(() => JSON.stringify({ decisions: [{ clusterId: 'c1', disposition: 'archive' }] }));
    await expect(new FeedbackTriageArbiter(p).decideBatch(authority, [packet('c1')])).rejects.toBeInstanceOf(TriageOutputRejected);
  });
});

describe('transactional triage call reservations', () => {
  let drain: FeedbackDrainStore;
  afterEach(() => drain?.close());
  const setup = () => {
    let now = Date.UTC(2026, 9, 31, 23, 59, 59);
    drain = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: KEY, clock: () => now });
    const firstRun = drain.startRun({ ownerHost: 'm1', ownerEpoch: 1, leaseMs: 10_000 });
    const { generation, revoked, ...binding } = authority;
    const approved = drain.mutateAuthority({ ...binding, action: 'create', operatorDecisionRef: 'owner-pin-test' });
    return { approved, firstRun, accountEvidence: { accountId: 'pool-account-1', limitFamily: 'codex' as const,
      usedPercent: 10, acquiredAt: now }, advance: (ms: number) => { now += ms; }, now: () => now };
  };

  it('refunds only an unlaunched token, including its original-day retriage debit, exactly once', () => {
    const { approved, accountEvidence, advance, now } = setup();
    const token = drain.reserveTriageCall({ authority: approved, ownerHost: 'm1', ownerEpoch: 1, ...accountEvidence,
      maxCallsPerDay: 1, subcap: { kind: 'retriage', maxCallsPerDay: 1 } });
    expect(token).toBeTruthy();
    expect(drain.authorityCallsToday(approved, now())).toBe(1);
    advance(2_000); // Cross the UTC accounting-day boundary before release.
    expect(drain.releaseTriageCall(token!)).toBe(true);
    expect(drain.releaseTriageCall(token!)).toBe(false);
    expect(drain.authorityCallsToday(approved, now() - 2_000)).toBe(0);
    expect(drain.sharedDatabase().prepare("SELECT calls FROM triage_daily_usage WHERE utc_day='2026-10-31' AND kind='retriage'").get()).toEqual({ calls: 0 });
  });

  it('a launched call cannot be refunded and a release wins only while reserved', () => {
    const { approved, accountEvidence } = setup();
    const token = drain.reserveTriageCall({ authority: approved, ownerHost: 'm1', ownerEpoch: 1, ...accountEvidence, maxCallsPerDay: 1 });
    expect(token).toBeTruthy();
    expect(drain.launchTriageCall(token!, approved, 'm1', 1)).toBe(true);
    expect(drain.releaseTriageCall(token!)).toBe(false);
    expect(drain.launchTriageCall(token!, approved, 'm1', 1)).toBe(false);
    expect(drain.completeTriageCall(token!, 'succeeded')).toBe(true);
    expect(drain.authorityCallsToday(approved)).toBe(1);
    const events = drain.sharedDatabase().prepare("SELECT to_state,reason FROM drain_audit WHERE kind='triage-call' ORDER BY sequence")
      .all() as Array<{ to_state: string; reason: string }>;
    expect(events.map((event) => event.to_state)).toEqual(['reserved', 'launched', 'completed']);
    const provenance = JSON.parse(events[0].reason) as Record<string, unknown>;
    expect(provenance).toMatchObject({ accountId: 'pool-account-1', limitFamily: 'codex', usedPercent: 10,
      generation: approved.generation, source: 'codex-app-server', ownerHost: 'm1', ownerEpoch: 1,
      reservationId: token, attemptId: expect.any(String) });
    expect(events[0].reason).not.toMatch(/auth\.json|configHome|credential|email|loginAccountId/);
    expect(JSON.parse(events[2].reason)).toMatchObject({ outcome: 'succeeded' });
  });

  it('reconstructs a launched call completed after owner handoff from lifecycle events alone', () => {
    const { approved, accountEvidence } = setup();
    const token = drain.reserveTriageCall({ authority: approved, ownerHost: 'm1', ownerEpoch: 1,
      ...accountEvidence, maxCallsPerDay: 1 });
    expect(token).toBeTruthy();
    expect(drain.launchTriageCall(token!, approved, 'm1', 1)).toBe(true);
    expect(drain.completeTriageCall(token!, 'succeeded', Date.now(), { host: 'm2', epoch: 2 })).toBe(true);
    const events = drain.sharedDatabase().prepare("SELECT to_state,reason FROM drain_audit WHERE kind='triage-call' ORDER BY sequence")
      .all() as Array<{ to_state: string; reason: string }>;
    const projections = events.map((event) => JSON.parse(event.reason) as Record<string, unknown>);
    expect(events.map((event) => event.to_state)).toEqual(['reserved', 'launched', 'completed']);
    expect(new Set(projections.map((event) => event.attemptId)).size).toBe(1);
    expect(projections[2]).toMatchObject({ ownerHost: 'm1', ownerEpoch: 1,
      observerHost: 'm2', observerEpoch: 2, handoffObserved: true, reservationId: token });
  });

  it('an owner handoff blocks launch but permits the new owner to refund the old unstarted token', () => {
    const { approved, firstRun, accountEvidence } = setup();
    const token = drain.reserveTriageCall({ authority: approved, ownerHost: 'm1', ownerEpoch: 1, ...accountEvidence, maxCallsPerDay: 1 });
    expect(token).toBeTruthy();
    drain.transitionRun(firstRun.runId, 'accepted', 'running');
    drain.transitionRun(firstRun.runId, 'running', 'succeeded');
    drain.startRun({ ownerHost: 'm2', ownerEpoch: 2, leaseMs: 10_000 });
    expect(drain.launchTriageCall(token!, approved, 'm1', 1)).toBe(false);
    expect(drain.releaseTriageCall(token!)).toBe(true);
    expect(drain.authorityCallsToday(approved)).toBe(0);
  });

  it('a stale owner cannot reserve after the recorded epoch advances', () => {
    const { approved, firstRun, accountEvidence } = setup();
    drain.transitionRun(firstRun.runId, 'accepted', 'running');
    drain.transitionRun(firstRun.runId, 'running', 'succeeded');
    drain.startRun({ ownerHost: 'm2', ownerEpoch: 2, leaseMs: 10_000 });
    const token = drain.reserveTriageCall({ authority: approved, ownerHost: 'm1', ownerEpoch: 1, ...accountEvidence,
      maxCallsPerDay: 1 });
    expect(token).toBeNull();
    expect(drain.authorityCallsToday(approved)).toBe(0);
  });

  it('refuses a stale or exhausted account reading before it debits a call', () => {
    const { approved, accountEvidence } = setup();
    for (const unsafe of [{ ...accountEvidence, usedPercent: 75 },
      { ...accountEvidence, acquiredAt: accountEvidence.acquiredAt - 60_001 }]) {
      expect(drain.reserveTriageCall({ authority: approved, ownerHost: 'm1', ownerEpoch: 1,
        ...unsafe, maxCallsPerDay: 1 })).toBeNull();
    }
    expect(drain.authorityCallsToday(approved)).toBe(0);
  });
});

describe('FeedbackTriageSecondOpinion contract', () => {
  it('true/false from a different family; null for same family, failure or unparseable', async () => {
    expect(await secondOpinionSaysIgnore(provider(() => '{"ignore":true}', 'claude-opus-4-8', 'claude-code'), packet('c1'), 'codex-cli')).toBe(true);
    expect(await secondOpinionSaysIgnore(provider(() => '{"ignore":false}', 'claude-opus-4-8', 'claude-code'), packet('c1'), 'codex-cli')).toBe(false);
    expect(await secondOpinionSaysIgnore(provider(() => '{"ignore":true}', 'gpt-6-astra', 'codex-cli'), packet('c1'), 'codex-cli')).toBeNull();
    expect(await secondOpinionSaysIgnore(provider(() => 'maybe', 'claude-opus-4-8', 'claude-code'), packet('c1'), 'codex-cli')).toBeNull();
    expect(await secondOpinionSaysIgnore({ evaluate: async () => { throw new Error('down'); } }, packet('c1'), 'codex-cli')).toBeNull();
  });
});

describe('triage packet', () => {
  const reports = Array.from({ length: 6 }, (_, i) => ({ feedbackId: `fb-${i}`, title: 't', description: `r${i} ` + 'x'.repeat(i === 5 ? 3_000 : 10), type: 'bug', receivedAt: `2026-10-0${i + 1}T00:00:00Z`, clusterId: 'c' }));
  const cluster = { clusterId: 'c', title: 'Crash', description: '', type: 'bug', reportCount: 6 };
  it('takes newest first plus the first-ever report, cuts the middle of long reports, and names every cut in-band', () => {
    const built = buildTriagePacket({ cluster, reports, neighbours: [], mergedPrs: [], options: { reportsPerItem: 4, charsPerReport: 1200 }, now: 0 });
    expect(built.packet.reports.map((r) => r.n)).toEqual([6, 5, 4, 1]);
    expect(built.truncated).toBe(true);
    expect(built.packet.truncation).toMatch(/^\[evidence truncated: showing 4 of 6 reports; report 6: middle \d+ of \d+ chars removed\]$/);
    expect(built.packet.reports[0].description.length).toBeLessThanOrEqual(1200 + 3);
  });
  it('an item alone gets the whole batch budget', () => {
    const built = buildTriagePacket({ cluster, reports, neighbours: [], mergedPrs: [], options: { reportsPerItem: 4, charsPerReport: 1200 }, alone: { maxChars: 21_000 }, now: 0 });
    expect(built.truncated).toBe(false);
    expect(built.packet.reports).toHaveLength(6);
  });
  it('scrubs credentials and flags them; keyword floor detects security wording', () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(90);
    const built = buildTriagePacket({ cluster, reports: [{ ...reports[0], description: `token ${secret} leak` }], neighbours: [], mergedPrs: [], options: { reportsPerItem: 4, charsPerReport: 1200 }, now: 0 });
    expect(JSON.stringify(built.packet)).not.toContain(secret);
    expect(built.credentialShaped).toBe(true);
    expect(built.keywordFloor).toBe(true);
  });
  it('merged PRs match only on the exact cluster or feedback id; a gh error is "unknown", never empty', () => {
    const prs = [
      { number: 11, title: 'fix', body: 'Fixes feedback cluster c', commits: [] },
      { number: 12, title: 'other', body: 'unrelated', commits: ['mentions fb-3 in a commit'] },
      { number: 13, title: 'noise', body: 'nothing', commits: [] },
    ];
    const built = buildTriagePacket({ cluster, reports, neighbours: [], mergedPrs: prs, options: { reportsPerItem: 4, charsPerReport: 1200 }, now: 0 });
    expect([...built.exactIdPrs!]).toEqual(['11', '12']);
    const unknown = buildTriagePacket({ cluster, reports, neighbours: [], mergedPrs: null, options: { reportsPerItem: 4, charsPerReport: 1200 }, now: 0 });
    expect(unknown.packet.mergedPrs).toBe('unknown');
    expect(unknown.exactIdPrs).toBeNull();
  });
  it('nearest neighbours: up to 8 by title similarity, never itself', () => {
    const others = Array.from({ length: 12 }, (_, i) => ({ clusterId: `n${i}`, title: `scheduler crash ${i}`, description: '' }));
    const result = nearestNeighbours({ clusterId: 'c', title: 'scheduler crash', description: '' }, [{ clusterId: 'c', title: 'scheduler crash', description: '' }, ...others], () => 'work');
    expect(result).toHaveLength(8);
    expect(result.some((n) => n.clusterId === 'c')).toBe(false);
  });
});

describe('triage store', () => {
  let drain: FeedbackDrainStore;
  afterEach(() => drain?.close());
  const setup = () => {
    let now = 1_000;
    drain = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: KEY, clock: () => now });
    const store = new FeedbackTriageStore(drain, { hmacKey: KEY, clock: () => now });
    return { store, advance: (ms: number) => { now += ms; } };
  };
  it('owner-epoch fenced: a stale writer is refused after a newer epoch wrote', () => {
    const { store } = setup();
    store.ensure(2, { initiativeId: 'i1', clusterId: 'c1', feedbackWorkKey: 'feedback-work:c1:1', firstSeenAt: 0, reportCount: 1 });
    expect(() => store.ensure(1, { initiativeId: 'i2', clusterId: 'c2', feedbackWorkKey: 'feedback-work:c2:1', firstSeenAt: 0, reportCount: 1 })).toThrow(DrainConflictError);
    expect(store.get('i2')).toBeNull();
  });
  it('a plan commits once, only with its nonce, only before expiry', () => {
    const { store, advance } = setup();
    const plan = store.createPlan({ action: 'ignore-live', payload: { enabled: true }, renderedText: 'Turn ON' });
    expect(() => store.consumePlan(plan.planId, 'wrong')).toThrow(/nonce/);
    expect(store.consumePlan(plan.planId, plan.nonce).payload).toEqual({ enabled: true });
    expect(() => store.consumePlan(plan.planId, plan.nonce)).toThrow(/already used/);
    const late = store.createPlan({ action: 'ignore-live', payload: {}, renderedText: 'x' });
    advance(16 * 60_000);
    expect(() => store.consumePlan(late.planId, late.nonce)).toThrow(/expired/);
  });
  it('sub-caps refuse past their limit', () => {
    const { store } = setup();
    expect(store.reserveSubcap(1, 'second-opinion', 30, 30)).toBe(true);
    expect(store.reserveSubcap(1, 'second-opinion', 1, 30)).toBe(false);
  });
  it('the triage authority call cap is counted in authority_daily_usage', () => {
    setup();
    const record = drain.mutateAuthority({ ...authority, action: 'create', operatorDecisionRef: 'op-1' });
    expect(drain.reserveAuthorityCalls(record, 1, 2)).toBe(true);
    expect(drain.reserveAuthorityCalls(record, 1, 2)).toBe(true);
    expect(drain.reserveAuthorityCalls(record, 1, 2)).toBe(false);
    expect(drain.authorityCallsToday(record)).toBe(2);
  });
});

describe('triage authority proposal', () => {
  it('derives every binding from the server and blocks without a route', () => {
    const base = { agentId: 'echo', binding: { ownerMachineId: 'm1', ownerEpoch: 3 }, current: null, maxCallsPerDay: 150 };
    const ok = buildTriageAuthorityProposal({ ...base, route: { framework: 'codex-cli', model: 'capable' } });
    expect(ok).toMatchObject({ status: 'none', approveAction: 'create', blockers: [] });
    expect(ok.proposal).toMatchObject({ authorityId: TRIAGE_AUTHORITY_ID, promptVersion: FEEDBACK_TRIAGE_PROMPT_ID, decisionPointId: 'feedback-triage', provider: 'codex-cli' });
    expect(ok.summary).toContain('150 model calls per day');
    const none = buildTriageAuthorityProposal({ ...base, route: null });
    expect(none.approveAction).toBeNull();
    expect(none.blockers.length).toBeGreaterThan(0);
  });
});

describe('triage packet — withheld evidence is a cut', () => {
  it('an oversize report the scrubber withholds marks the packet truncated (so it can never be ignored)', () => {
    const cluster = { clusterId: 'big', title: 'Huge log paste', description: '', type: 'bug', reportCount: 1 };
    const reports = [{ feedbackId: 'fb-big-0', title: 'log', description: 'x'.repeat(70 * 1024), type: 'bug', clusterId: 'big' }];
    const built = buildTriagePacket({ cluster, reports, neighbours: [], mergedPrs: [], options: { reportsPerItem: 4, charsPerReport: 1200 }, now: 0 });
    expect(built.truncated).toBe(true);
    expect(built.packet.truncation).toMatch(/report 1: all \d+ chars withheld/);
  });
});

describe('triage store — re-triage bookkeeping', () => {
  let drain: FeedbackDrainStore;
  afterEach(() => drain?.close());
  const setup = () => {
    drain = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: KEY, clock: () => 1_000 });
    const store = new FeedbackTriageStore(drain, { hmacKey: KEY, clock: () => 1_000 });
    for (const id of ['src', 'tgt', 'other']) store.ensure(1, { initiativeId: `i-${id}`, clusterId: id, feedbackWorkKey: `feedback-work:${id}:1`, firstSeenAt: 0, reportCount: 1 });
    return store;
  };
  const decision = (initiativeId: string, over: Record<string, unknown> = {}) => ({
    initiativeId, tickId: 't', state: 'hold' as const, reason: 'needs-review', wouldIgnoreReason: null, severity: 'high' as const, priority: 50,
    confidence: 0.9, effort: 'm', needsSpec: false, userFacing: true, summary: 's', brief: { component: '', symptom: '', expected: '', reproduction: '' },
    duplicateOf: null, fixedBy: null, evidenceComplete: true, rankTier: 2, rankBand: 1, singleReportCritical: false, floors: [], ruleDefault: 'hold' as const,
    boundReportCount: 2, nextReviewAt: null, authorityGeneration: 1, packetRef: 'pkt-' + 'a'.repeat(24), correlationId: null,
    expectedInitiativeStatus: 'paused', modelDisposition: 'ignore' as const, wouldIgnore: true, shadow: false, keywordFloor: false, ...over,
  });
  it('keeps notifiedAt when a re-triage reaches the same state and reason; clears it when either changes', () => {
    const store = setup();
    store.writeDecision(1, decision('i-src'));
    store.markNotified(1, ['i-src']);
    store.requeue(1, 'i-src', 'new-reports');
    store.writeDecision(1, decision('i-src'));
    expect(store.get('i-src')!.notifiedAt).toBe(1_000);
    store.requeue(1, 'i-src', 'new-reports');
    store.writeDecision(1, decision('i-src', { reason: 'needs-evidence' }));
    expect(store.get('i-src')!.notifiedAt).toBeNull();
  });
  it('applies only the delta of a duplicate contribution and withdraws it when the item stops being a duplicate', () => {
    const store = setup();
    const dup = (n: number, target = 'tgt') => decision('i-src', { state: 'ignored', reason: 'duplicate', duplicateOf: target, duplicateReports: n });
    store.writeDecision(1, dup(3));
    expect(store.get('i-tgt')!.duplicateBonus).toBe(3);
    store.writeDecision(1, dup(3));
    expect(store.get('i-tgt')!.duplicateBonus).toBe(3);
    store.writeDecision(1, dup(5));
    expect(store.get('i-tgt')!.duplicateBonus).toBe(5);
    store.writeDecision(1, dup(5, 'other'));
    expect(store.get('i-tgt')!.duplicateBonus).toBe(0);
    expect(store.get('i-other')!.duplicateBonus).toBe(5);
    store.writeDecision(1, decision('i-src', { state: 'work', reason: 'actionable' }));
    expect(store.get('i-other')!.duplicateBonus).toBe(0);
  });
});
