import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  compileWindowSources, verifyCompilationCoverage, classifyExecutor, evaluateExecutor, evaluateObligations,
  evaluateClosure, createLedger, waiverDigest, validateWaiver, evaluateFromAuthorities, evaluateLifecycleTick, ProductionMessageEvidenceAuthority,
  REQUIRED_WINDOW_DUTIES, WINDOW_32_REQUIRED_DUTIES, WINDOW_32_APPROVED_CHARTER_SHA256, RECURRING_DUTY_DEFAULT_GRACE_MS, minimumWindowDutyFixture, materializeCadenceInstances, transitionLedger,
  predicateSatisfied, sourceFreshnessIssues, evaluateLifecycleGuard, applyWaiver,
  runWindowLifecyclePostLiveCheck, deriveFailureRemediation, verifyRequiredDutySources, isW32ReaffirmationBootstrap,
  type Obligation, type EvidenceRecord, type Waiver,
} from '../../src/core/WindowLifecycleObligationLedger.js';

const NOW = '2026-08-28T16:00:00.000Z';
const future = '2026-08-28T19:00:00.000Z';

function evidence(id: string): EvidenceRecord {
  return { authority: 'content-bound-store-row', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', obligationId: id, sourceHashes: ['source'], producer: 'test', timestamp: NOW, nonce: `n-${id}`, canonicalPayloadHash: 'a'.repeat(64), verifierPassed: true, verifiedPayload: JSON.stringify({ obligationId: id, verdict: 'pass', sourceHashes: ['source'] }) };
}
function obligation(overrides: Partial<Obligation> = {}): Obligation {
  const id = overrides.id ?? 'duty';
  return { id, agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', sourceSpans: [{ source: 'tenets', hash: 'source', byteStart: 0, byteEnd: 4, lineStart: 1, lineEnd: 1 }], statement: 'required duty', phase: 'start', coreDuty: true, waiverPolicy: 'non-waivable', responsibleRole: 'echo', deadline: { dueAt: future, graceMs: 0 }, predicate: {}, evidencePolicy: { requiredAuthority: 'content-bound-store-row' }, executorBinding: { kind: 'worker', executorId: 'run-1', owner: 'codey', registryCoordinates: 'runs/run-1', enabled: true, dryRun: false, running: true, heartbeatAt: NOW, heartbeatMaxAgeMs: 60_000, nextAttemptAt: future }, failureAction: 'block', status: 'pending', evidence: [], lastEvaluatedAt: null, ...overrides };
}

describe('WindowLifecycleObligationLedger compiler', () => {
  it('proves the real completion guard and closure consumer reject an omitted landed effect', () => {
    const target = obligation({ id: 'close.no-done-without-effect', phase: 'close', failureAction: 'fail-close', status: 'satisfied', evidence: [evidence('close.no-done-without-effect')] });
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [target] } });
    ledger.nativeEvaluations.push({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', inputHash: 'a'.repeat(64), inputBytes: '{}', storePath: '/tmp/store', storeHash: 'b'.repeat(64), storeBytesLength: 0, evaluatorVersion: 'test', output: { admitted: true }, evaluatedAt: NOW, nonce: 'native-test', mapping: {} });
    expect(runWindowLifecyclePostLiveCheck(ledger)).toMatchObject({ passed: true });
  });
  it.each(REQUIRED_WINDOW_DUTIES.map(d => [d.id, d.failure] as const))('blocks closure when compiled duty %s is omitted and executes failure action %s', (id, failure) => {
    const present = obligation({ id, failureAction: failure, status: 'satisfied', evidence: [evidence(id)] }); const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [present] } });
    ledger.obligations = []; expect(evaluateClosure(ledger).issues).toContain(`census-missing:${id}`);
    const invalid = evidence(id); invalid.verifiedPayload = JSON.stringify({ unrelated: true }); expect(predicateSatisfied(present, invalid)).toBe(false);
    const failed = { ...present, status: 'failed' as const, evidence: [] }; const failureLedger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [failed] } }); const remediation = deriveFailureRemediation(failed);
    expect(remediation.action).toBe(failure);
    expect(Object.entries(remediation).some(([key, value]) => key !== 'obligationId' && key !== 'action' && Boolean(value)), `${id}:${failure}`).toBe(true);
    if (remediation.blockNewScope) expect(evaluateLifecycleGuard(failureLedger, 'new-scope').allowed).toBe(false); if (remediation.blockSend) expect(evaluateLifecycleGuard(failureLedger, 'telegram-send').allowed).toBe(false); if (remediation.blockCompletion) expect(evaluateLifecycleGuard(failureLedger, 'completion-claim').allowed).toBe(false);
  });
  it('maps every compiled failure action to an enforceable runtime consequence', () => {
    for (const action of new Set(REQUIRED_WINDOW_DUTIES.map(d => d.failure))) {
      const remediation = deriveFailureRemediation(obligation({ failureAction: action, status: 'failed' }));
      expect(remediation.blockPhase || remediation.blockNewScope || remediation.blockSend || remediation.blockCompletion || remediation.debtRequired || remediation.repostRequired || remediation.correctionRequired || remediation.scopeReviewRequired, action).toBe(true);
    }
  });
  it('maps source-discovered duties outside the minimum catalog to blocking and visible remediation', () => {
    const remediation = deriveFailureRemediation(obligation({ id: 'source.dynamic', failureAction: 'block-and-surface', status: 'failed' }));
    expect(remediation).toMatchObject({ blockPhase: true, observerTopicId: 43003 });
  });
  it('derives the complete explicit duty catalog from source and preserves policy metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-catalog-')); const tenets = path.join(dir, 'TENETS.md'); const charter = path.join(dir, 'charter.md');
    fs.writeFileSync(tenets, '# Tenets\nTenet 9 must be followed.\n'); fs.writeFileSync(charter, minimumWindowDutyFixture());
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', tenetsPath: tenets, charterPath: charter, now: NOW });
    for (const duty of REQUIRED_WINDOW_DUTIES) { const found = compiled.obligations.find(o => o.id === duty.id); expect(found, duty.id).toBeDefined(); expect(found?.sourceSpans[0].hash).toHaveLength(64); expect(found?.responsibleRole).toBeTruthy(); expect(found?.failureAction).toBeTruthy(); }
  });
  it('compiles W31-approved canonical charter language without compiler-shaped annex vocabulary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-w31-canonical-')); const tenets = path.join(dir, 'TENETS.md'); const charter = path.join(dir, 'WINDOW-31-CHARTER.md');
    fs.writeFileSync(tenets, `# The Tenets\n${minimumWindowDutyFixture().replace('The tenets are compiled and tenets in force; ', '')}`);
    fs.writeFileSync(charter, `# WINDOW 31 CHARTER\nApproved by Justin.\nWindow opens 2026-08-31; ceiling 2026-09-01 20:25 PDT.\nCanonical plan 3a08766f-5738-474f-8857-b713f753a7e2.\n1. REPAIR THE ENGINE, THEN MAKE THE NUMBER MOVE: fix ACT-353, ACT-354, ACT-355, and the compiler source contract so the approved charter compiles AS APPROVED. Then recompile W31's duties from THIS approved charter directly. EXIT TEST: the ENGINE must refuse the close for one omitted duty.\n2. NATIVE RE-GROUND EVIDENCE: the observer re-read, both assessments, and the visible reconciliation become receipt-backed lifecycle evidence the engine consumes.\n3. CLOSE RITUAL AS AN EXECUTABLE RECEIPT-GATED SEQUENCE: a runner refuses skips and resumes from the first unreceipted step.\nStanding debt carried with owners.\nThe run must appear in the LIVE run listing before the opening is declared complete.\n`);
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w31', tenetsPath: tenets, charterPath: charter, now: NOW });
    expect(REQUIRED_WINDOW_DUTIES.every(duty => compiled.obligations.some(o => o.id === duty.id))).toBe(true);
  });
  it('compiles the exact approved W32 charter without diagnostic rendering', () => {
    const tenets = path.resolve('tests/fixtures/window-32-tenets.md');
    const charter = path.resolve('tests/fixtures/window-32-approved-charter.md');
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', tenetsPath: tenets, charterPath: charter, now: NOW });
    expect(compiled.hashes).toMatchObject({
      [tenets]: '2c9ac586f74e1a1b68a7271aed0232bf1a1f3c4b56573b68a7bd65ec4298b104',
      [charter]: WINDOW_32_APPROVED_CHARTER_SHA256,
    });
    expect(compiled.catalogProfile).toBe('w32-approved-a204c07d');
    const charterMappings: Record<string, number> = {
      'preground.native-structural-preflight': 72,
      'w32.start.executor-bound-running': 21,
      'w32.start.heartbeat-fresh': 22,
      'w32.start.delivery-path-reachable': 23,
      'w32.start.durable-work-advanced': 24,
      'w32.continuous.admitted-and-unexpired': 25,
      'w32.continuous.missing-predicate-at-risk': 27,
      'w32.continuous.bounded-recovery': 27,
      'w32.continuous.registration-not-liveness': 27,
      'w32.close.three-advancing-intervals': 33,
      'w32.close.induced-executor-loss': 34,
      'w32.close.resume-once-or-fail-loudly': 35,
      'w32.close.all-reports-delivered': 36,
      'w32.close.zero-false-active': 37,
      'w32.continuous.pre-start-gate-exit': 38,
      'w32.close.expiry-freeze': 39,
      'w32.close.independent-loss-verification': 40,
      'w32.close.immediate-on-pass': 15,
      'w32.close.no-separate-soak': 15,
      'w32.continuous.opening-complete': 72,
    };
    for (const [id, lineStart] of Object.entries(charterMappings)) {
      expect(compiled.obligations.find(duty => duty.id === id)?.sourceSpans[0], id).toMatchObject({ source: charter, lineStart });
    }
    expect(WINDOW_32_REQUIRED_DUTIES.every(duty => compiled.obligations.some(o => o.id === duty.id))).toBe(true);
    expect(compiled.obligations.some(duty => duty.id === 'postlive.verdict.pass-required')).toBe(false);
  });
  it('keeps every W32 start source artifact in the census and rejects a stale compiled source hash', () => {
    const tenets = path.resolve('tests/fixtures/window-32-tenets.md');
    const charter = path.resolve('tests/fixtures/window-32-approved-charter.md');
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', tenetsPath: tenets, charterPath: charter, now: NOW });
    const sourceDuties = compiled.obligations.filter(duty => /^source\./.test(duty.id) && ['pre-start', 'start'].includes(duty.phase));
    expect(sourceDuties).toHaveLength(6);
    for (const omitted of sourceDuties) {
      const coverage = verifyCompilationCoverage({ ...compiled, obligations: compiled.obligations.filter(duty => duty.id !== omitted.id) });
      expect(coverage.issues, omitted.id).toContain(`uncompiled-operative-duty:${omitted.sourceSpans[0].source}:${omitted.sourceSpans[0].lineStart}`);
    }
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', compiled });
    ledger.sourceHashes[tenets] = '0'.repeat(64);
    expect(sourceFreshnessIssues(ledger)).toContain(`stale-source:${tenets}`);
  });
  it('selects the W32 profile only for the byte-exact approved charter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-w32-identity-')); const charter = path.join(dir, 'WINDOW-32-CHARTER.md');
    fs.writeFileSync(charter, fs.readFileSync(path.resolve('tests/fixtures/window-32-approved-charter.md'), 'utf8').replace('APPROVED', 'DRAFT'));
    expect(() => compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', tenetsPath: path.resolve('tests/fixtures/window-32-tenets.md'), charterPath: charter, now: NOW })).toThrow('window-duty-profile-identity-mismatch:w32-approved-charter');
  });
  it.each([
    ['unrelated opening', 'Opening requires: a plain-language kickoff.'],
    ['only registration', 'Opening requires: the run registered.'],
    ['only liveness', 'Opening requires: liveness predicates initially green.'],
    ['negated registration', 'Opening requires: the run not registered, liveness predicates initially green.'],
    ['contrary relationship', "Opening requires: it does not require run registered, liveness predicates initially green."],
  ])('refuses W32 native preflight language with %s', (_case, openingLine) => {
    const nativeDuty = WINDOW_32_REQUIRED_DUTIES.find(duty => duty.id === 'preground.native-structural-preflight')!;
    expect(verifyRequiredDutySources([nativeDuty], [{ kind: 'paragraph', text: openingLine, span: { source: 'charter', hash: 'a'.repeat(64), byteStart: 0, byteEnd: openingLine.length, lineStart: 1, lineEnd: 1 }, operative: true }])).toEqual({ ok: false, issues: ['uncompiled-operative-duty:preground.native-structural-preflight'] });
  });
  it.each(WINDOW_32_REQUIRED_DUTIES)('refuses omission of W32 selected-profile duty $id', duty => {
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', tenetsPath: path.resolve('tests/fixtures/window-32-tenets.md'), charterPath: path.resolve('tests/fixtures/window-32-approved-charter.md'), now: NOW });
    const mutatedAst = compiled.ast!.map(node => {
      let text = node.text;
      for (const pattern of duty.sourcePatterns ?? [duty.sourcePattern]) {
        pattern.lastIndex = 0;
        while (pattern.test(text)) { pattern.lastIndex = 0; text = text.replace(pattern, '[omitted W32 duty]'); pattern.lastIndex = 0; }
      }
      return { ...node, text };
    });
    expect(verifyRequiredDutySources([duty], mutatedAst)).toEqual({ ok: false, issues: [`uncompiled-operative-duty:${duty.id}`] });
  });
  it('gives recurring duties a default grace window while keeping one-shot duties strict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-recurring-grace-')); const tenets = path.join(dir, 'TENETS.md'); const charter = path.join(dir, 'charter.md');
    fs.writeFileSync(tenets, '# Tenets\nEcho must act.\n'); fs.writeFileSync(charter, minimumWindowDutyFixture());
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', tenetsPath: tenets, charterPath: charter, now: NOW });
    const recurring = compiled.obligations.filter(o => o.predicate.recurring);
    expect(recurring.length).toBeGreaterThan(0);
    expect(recurring.every(o => o.deadline.graceMs === RECURRING_DUTY_DEFAULT_GRACE_MS)).toBe(true);
    expect(compiled.obligations.find(o => o.id === 'start.compilation-proof')?.deadline.graceMs).toBe(0);
  });

  it('derives source challenges and changes them when authoritative facts mutate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-facts-')); const tenets = path.join(dir, 'TENETS.md'); const charter = path.join(dir, 'charter.md');
    fs.writeFileSync(tenets, 'must use `justin-telegram` fingerprint 63b1dbb21646e2f5 starting from July 25.\n');
    fs.writeFileSync(charter, `${minimumWindowDutyFixture()}\nPlan 3a08766f-5738-474f-8857-b713f753a7e2 ending 2026-08-28 ~21:55 PDT.`);
    const compile = () => compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', tenetsPath: tenets, charterPath: charter, now: NOW });
    const first = compile(); fs.writeFileSync(tenets, fs.readFileSync(tenets, 'utf8').replace('justin-telegram', 'operator-telegram').replace('July 25', 'July 26')); const second = compile();
    expect(first.challenges?.telegramProfile).toBe('justin-telegram'); expect(second.challenges?.telegramProfile).toBe('operator-telegram'); expect(second.challenges?.pathwayStart).toBe('July 26'); expect(first.challenges?.charterExpiry).toBe('2026-08-28 ~21:55 PDT');
  });
  it.each(['must', 'required', 'cannot', 'every 30 minutes'])('compiles operative %s forms and rejects stale coverage', word => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-compiler-'));
    const tenets = path.join(dir, 'TENETS.md'); const charter = path.join(dir, 'charter.md');
    fs.writeFileSync(tenets, `# Tenets\nEcho ${word} report.\n`); fs.writeFileSync(charter, '# Charter\nStart normally.\n');
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', tenetsPath: tenets, charterPath: charter, now: NOW, requireMinimumCatalog: false });
    expect(compiled.obligations).toHaveLength(1); expect(verifyCompilationCoverage(compiled).ok).toBe(true);
    compiled.obligations = []; expect(verifyCompilationCoverage(compiled).issues[0]).toContain('uncompiled-operative-duty');
  });

  it('rejects another agent before reading source files', () => {
    expect(() => compileWindowSources({ agentId: 'codey', scope: 'echo-window-lifecycle', windowId: 'w28', tenetsPath: '/absent', charterPath: '/absent' })).toThrow('echo-scope-required');
  });
  it('discovers an unknown normative form independently and refuses stale compiler coverage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-discovery-')); const tenets = path.join(dir, 'TENETS.md'); const charter = path.join(dir, 'charter.md');
    fs.writeFileSync(tenets, 'Echo is obligated to publish a new artifact.\n'); fs.writeFileSync(charter, 'plain\n');
    expect(() => compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', tenetsPath: tenets, charterPath: charter, now: NOW, requireMinimumCatalog: false })).toThrow('uncompiled-operative-duty');
  });
});

describe('executor classes', () => {
  it.each(REQUIRED_WINDOW_DUTIES.map(d => [d.id, d.phase] as const))('assigns Section 7 duty %s exactly one applicable class', (id, phase) => {
    const futurePhase = ['mid', 'close', 'post-live'].includes(phase); const duty = obligation({ id, phase, eligibleAt: futurePhase ? future : undefined }); const cls = classifyExecutor(duty, NOW);
    expect(['future-phase', 'pending-executable', 'completed-one-shot'].filter(candidate => candidate === cls)).toHaveLength(1); expect(cls).toBe(futurePhase ? 'future-phase' : 'pending-executable');
  });
  it('maps future -> pending -> completed and applies only class-relevant requirements', () => {
    const futureDuty = obligation({ eligibleAt: future, executorBinding: { kind: 'phase-trigger', executorId: 'mid', owner: 'observer-2', registryCoordinates: 'triggers/mid', enabled: true, dryRun: false, triggerEnabled: true, durableTriggerState: true, eligibilityAt: future } });
    expect(classifyExecutor(futureDuty, NOW)).toBe('future-phase'); expect(evaluateExecutor(futureDuty, NOW).ok).toBe(true);
    const pending = obligation(); expect(classifyExecutor(pending, NOW)).toBe('pending-executable'); expect(evaluateExecutor(pending, NOW).ok).toBe(true);
    const completed = obligation({ status: 'satisfied', evidence: [evidence('duty')] }); expect(classifyExecutor(completed, NOW)).toBe('completed-one-shot'); expect(evaluateExecutor(completed, NOW).ok).toBe(true);
  });

  it('refuses registration without a live, fresh, timely executor', () => {
    const result = evaluateExecutor(obligation({ executorBinding: { kind: 'worker', executorId: 'registered', owner: 'codey', registryCoordinates: 'runs/registered', enabled: true, dryRun: false, running: false, heartbeatAt: '2026-08-28T12:00:00Z', heartbeatMaxAgeMs: 60_000, nextAttemptAt: '2026-08-28T20:00:00Z' } }), NOW);
    expect(result.issues).toEqual(expect.arrayContaining(['executor-not-running', 'heartbeat-stale', 'attempt-not-timely']));
  });

  it('does not demand sink or driver fields from an internal executor', () => expect(evaluateExecutor(obligation(), NOW).ok).toBe(true));
  it('rejects invalid, future, and late timestamps instead of NaN bypass', () => {
    expect(evaluateExecutor(obligation({ deadline: { dueAt: 'not-time', graceMs: 0 } }), NOW).issues).toContain('invalid-timestamp');
    expect(evaluateExecutor(obligation({ executorBinding: { ...obligation().executorBinding, heartbeatAt: future } }), NOW).issues).toContain('heartbeat-stale');
  });
  it('requires durable evidence for a completed one-shot even with a live retry', () => expect(evaluateExecutor(obligation({ status: 'satisfied' }), NOW).issues).toContain('durable-completion-evidence-missing'));
  it.each([
    [{ owner: '', enabled: true, dryRun: false, triggerEnabled: true, durableTriggerState: true, eligibilityAt: future }, 'owner-missing'],
    [{ owner: 'o', enabled: false, dryRun: false, triggerEnabled: true, durableTriggerState: true, eligibilityAt: future }, 'trigger-disabled'],
    [{ owner: 'o', enabled: true, dryRun: false, triggerEnabled: true, durableTriggerState: true, eligibilityAt: '2026-08-28T20:00:00Z' }, 'eligibility-after-deadline'],
  ])('rejects invalid future-phase binding', (binding, issue) => expect(evaluateExecutor(obligation({ eligibleAt: future, executorBinding: { kind: 'trigger', executorId: 't', registryCoordinates: 't', ...binding } }), NOW).issues).toContain(issue));
});

describe('production authority re-query', () => {
  it('does not let authentic but unrelated content satisfy a semantic duty', () => {
    const duty = obligation({ id: 'start.plan-position', coreDuty: true }); const authentic = evidence(duty.id);
    authentic.verifiedPayload = JSON.stringify({ obligationId: duty.id, verdict: 'pass', sourceHashes: ['source'] });
    expect(predicateSatisfied(duty, authentic)).toBe(false);
    authentic.verifiedPayload = JSON.stringify({ obligationId: duty.id, verdict: 'pass', sourceHashes: ['source'], planNodeId: 'current-work', charterIncluded: true });
    expect(predicateSatisfied(duty, authentic)).toBe(true);
  });
  it('requires every durable all-session stall-inspection field, not generic commitment completion', () => {
    const duty = obligation({ id: 'cadence.stall-check.30m@2026-08-28T16:00:00.000Z', evidencePolicy: { requiredAuthority: 'runtime-registry-proof' } });
    const generic = { ...evidence(duty.id), authority: 'runtime-registry-proof' as const, verifiedPayload: JSON.stringify({ obligationId: duty.id, verdict: 'pass', sourceHashes: ['source'], runtimeCompletion: { executorId: 'c', completedAt: NOW, completionDigest: 'x' } }) };
    expect(predicateSatisfied(duty, generic)).toBe(false);
    generic.verifiedPayload = JSON.stringify({ obligationId: duty.id, verdict: 'pass', sourceHashes: ['source'], runtimeCompletion: {}, watchdogEnabled: true, watchdogPollRevision: 1, watchdogAuthorityEpoch: 'test-epoch', watchdogAuthorityProof: 'b'.repeat(64), activeSessionIds: ['a', 'b'], inspectedSessionIds: ['a', 'b'], sessionResults: [{ name: 'a', outputObserved: true, escalationActive: false, decisionEvaluated: true, decisionEvaluatedAt: NOW }, { name: 'b', outputObserved: true, escalationActive: false, decisionEvaluated: true, decisionEvaluatedAt: NOW }], inspectionHash: 'a'.repeat(64) });
    expect(predicateSatisfied(duty, generic)).toBe(true);
  });
  it('requires lane/machine-associated executed worker evidence and majority share', () => {
    const duty = obligation({ id: 'start.delegation-majority-boundary' }); const row = evidence(duty.id);
    row.verifiedPayload = JSON.stringify({ obligationId: duty.id, verdict: 'pass', sourceHashes: ['source'], workerAssignments: [{ laneId: 'A' }, { laneId: 'B' }], offloadedLaneShare: 1 });
    expect(predicateSatisfied(duty, row)).toBe(false);
    row.verifiedPayload = JSON.stringify({ obligationId: duty.id, verdict: 'pass', sourceHashes: ['source'], workerAssignments: [{ laneId: 'A', transcriptHash: 'a'.repeat(64) }, { laneId: 'B', transcriptHash: 'b'.repeat(64) }], offloadedLaneShare: 1 });
    expect(predicateSatisfied(duty, row)).toBe(true);
  });
  it('rejects machine distribution without associated workers or a verified unavailable-machine blocker', () => {
    const duty = obligation({ id: 'start.machine-model-distribution' }); const row = evidence(duty.id);
    row.verifiedPayload = JSON.stringify({ obligationId: duty.id, verdict: 'pass', sourceHashes: ['source'], workerAssignments: [{ laneId: 'A', machineId: 'studio' }, { laneId: 'B', machineId: 'studio' }], namedBlocker: 'laptop offline' });
    expect(predicateSatisfied(duty, row)).toBe(false);
    row.verifiedPayload = JSON.stringify({ obligationId: duty.id, verdict: 'pass', sourceHashes: ['source'], workerAssignments: [{ laneId: 'A', machineId: 'studio' }, { laneId: 'B', machineId: 'laptop' }], machineBlockerVerified: false });
    expect(predicateSatisfied(duty, row)).toBe(true);
  });
  it('requires reaffirmation message bytes to hash exactly to the compiled source', () => {
    const bytes = 'TENETS\nword for word\n'; const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex'); const duty = obligation({ id: 'start.reaffirmation', sourceSpans: [{ source: 'TENETS.md', hash: sourceHash, byteStart: 0, byteEnd: bytes.length, lineStart: 1, lineEnd: 2 }], evidencePolicy: { requiredAuthority: 'live-requeried-message' } }); const proof = evidence(duty.id); proof.authority = 'live-requeried-message'; proof.sourceHashes = [sourceHash]; proof.verifiedPayload = bytes;
    expect(predicateSatisfied(duty, proof)).toBe(true); proof.verifiedPayload = `${bytes}summary`; expect(predicateSatisfied(duty, proof)).toBe(false);
  });
  it('reconstructs an ordered live multipart reaffirmation and rejects missing, reordered, foreign, or altered parts', () => {
    const source = fs.readFileSync(path.resolve('tests/fixtures/window-32-tenets.md'), 'utf8'); const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
    const markers = ['## Goals 1–8', '## Tenet 5 — REFINEMENT', '## Tenet 9 (complete rewrite', '## Tenet 10 (captured', '## The 80/20 standard', '## Tenet 13 (proposed']; const offsets = markers.map(marker => source.indexOf(marker)); expect(offsets.every(offset => offset > 0)).toBe(true);
    const bodies = [source.slice(0, offsets[0]), ...offsets.slice(0, -1).map((offset, index) => source.slice(offset, offsets[index + 1])), source.slice(offsets.at(-1)!)].map(body => body.replace(/\n\n$/, '').replace(/\n$/, ''));
    const logicalMessageIds = [68736, 68729, 68737, 68732, 68733, 68744, 68734];
    const rows = bodies.map((body, index) => ({ messageId: logicalMessageIds[index], topicId: 36966, text: `[WINDOW 32 START TENET REAFFIRMATION — part ${index + 1}/7, verbatim, byte-validated]\n\n${body}`, fromUser: false, timestamp: new Date(Date.parse(NOW) + index * 1_000).toISOString(), sessionName: 'echo-observer', provenance: 'agent' }));
    const deliveryOrderedRows = [...rows].sort((a, b) => a.messageId - b.messageId); expect(deliveryOrderedRows.map(row => row.messageId)).not.toEqual(logicalMessageIds);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-multipart-reaffirmation-')); const store = path.join(dir, 'telegram-messages.jsonl'); fs.writeFileSync(store, `${deliveryOrderedRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    let liveRows = structuredClone(deliveryOrderedRows); const authority = new ProductionMessageEvidenceAuthority(store, (topicId, messageId) => liveRows.find(row => row.topicId === topicId && row.messageId === messageId) ?? null);
    const duty = obligation({ id: 'start.reaffirmation', windowId: 'w32', sourceSpans: [{ source: 'TENETS.md', hash: sourceHash, byteStart: 0, byteEnd: Buffer.byteLength(source), lineStart: 1, lineEnd: 113 }], evidencePolicy: { requiredAuthority: 'live-requeried-message' } });
    const proof = evidence(duty.id); proof.windowId = 'w32'; proof.authority = 'live-requeried-message'; proof.sourceHashes = [sourceHash]; proof.canonicalPayloadHash = sourceHash; proof.nativeCoordinates = { topicId: 36966, messageId: logicalMessageIds[0], messageIds: logicalMessageIds };
    const verified = authority.requery(proof); expect(verified?.verifiedPayload).toBe(source); expect(predicateSatisfied(duty, verified!)).toBe(true);
    const bootstrap = { catalogProfile: 'w32-approved-a204c07d' as const, obligation: duty, rows, topicId: 36966, reconstructed: source, requestedAuthority: 'live-requeried-message' as const };
    expect(isW32ReaffirmationBootstrap(bootstrap)).toBe(true);
    expect(isW32ReaffirmationBootstrap({ ...bootstrap, catalogProfile: 'legacy-w28-w31' })).toBe(false);
    expect(isW32ReaffirmationBootstrap({ ...bootstrap, obligation: { ...duty, id: 'mid.reaffirmation' } })).toBe(false);
    expect(isW32ReaffirmationBootstrap({ ...bootstrap, topicId: 43003 })).toBe(false);
    expect(isW32ReaffirmationBootstrap({ ...bootstrap, reconstructed: `${source}altered` })).toBe(false);
    expect(isW32ReaffirmationBootstrap({ ...bootstrap, rows: rows.map((row, index) => index === 3 ? { ...row, sessionName: 'echo-worker' } : row) })).toBe(false);
    const missing = structuredClone(proof); missing.nativeCoordinates!.messageIds = missing.nativeCoordinates!.messageIds!.slice(0, -1); expect(authority.requery(missing)).toBeNull();
    const reordered = structuredClone(proof); [reordered.nativeCoordinates!.messageIds![0], reordered.nativeCoordinates!.messageIds![1]] = [reordered.nativeCoordinates!.messageIds![1], reordered.nativeCoordinates!.messageIds![0]]; reordered.nativeCoordinates!.messageId = reordered.nativeCoordinates!.messageIds![0]; expect(authority.requery(reordered)).toBeNull();
    liveRows = structuredClone(deliveryOrderedRows); liveRows[3].topicId = 43003; expect(authority.requery(proof)).toBeNull();
    liveRows = structuredClone(deliveryOrderedRows); liveRows[3].text += ' altered'; expect(authority.requery(proof)).toBeNull();
  });

  it('detects source mutation and disappearance from compiled hashes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fresh-')); const source = path.join(dir, 'TENETS.md'); fs.writeFileSync(source, 'original');
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: { [source]: crypto.createHash('sha256').update('original').digest('hex') }, byteLengths: {}, operativeLines: [], obligations: [] } });
    expect(sourceFreshnessIssues(ledger)).toEqual([]); fs.writeFileSync(source, 'mutated'); expect(sourceFreshnessIssues(ledger)[0]).toContain('stale-source'); fs.renameSync(source, `${source}.moved`); expect(sourceFreshnessIssues(ledger)[0]).toContain('source-unavailable');
  });
  it('ignores caller-asserted runtime booleans and fails when the real registry has no assignment', () => {
    const result = evaluateFromAuthorities([obligation()], { resolve: () => null }, { requery: () => null }, NOW);
    expect(result.admitted).toBe(false); expect(result.issues.join(',')).toContain('runtime-assignment-missing');
  });
  it('evaluates run-liveness duties only through their server authority, never RuntimeRegistry commitments', () => {
    const duty = obligation({ id: 'w32.start.executor-bound-running', evidencePolicy: { requiredAuthority: 'run-liveness-authority' } });
    const proof = evidence(duty.id); proof.authority = 'run-liveness-authority';
    const runtime = { resolve: () => { throw new Error('run-liveness touched legacy RuntimeRegistry'); } };
    const admitted = evaluateFromAuthorities([{ ...duty, evidence: [proof] }], runtime, { requery: record => record }, NOW);
    expect(admitted.admitted).toBe(true);
    const refused = evaluateFromAuthorities([duty], runtime, { requery: () => null }, NOW);
    expect(refused.admitted).toBe(false);
    expect(refused.issues).toEqual(expect.arrayContaining([
      `${duty.id}:run-liveness-authority-unsatisfied`,
      `${duty.id}:predicate-unsatisfied`,
    ]));
    expect(refused.issues.some(issue => issue.includes('runtime-assignment'))).toBe(false);
  });
  it('turns vanished previously-satisfied evidence into unknown', () => {
    const duty = obligation({ status: 'satisfied', evidence: [evidence('duty')] }); const result = evaluateFromAuthorities([duty], { resolve: () => ({ executorId: 'x', owner: 'echo', kind: 'internal', registryCoordinates: 'obligation:duty', enabled: true, dryRun: false, running: false }) }, { requery: () => null }, NOW);
    expect(result.obligations[0].status).toBe('unknown'); expect(result.admitted).toBe(false);
  });
  it('rejects fabricated/unrelated/hash-only rows and earns content authority from matching store text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-evidence-')); const store = path.join(dir, 'telegram-messages.jsonl');
    fs.writeFileSync(store, `${JSON.stringify({ messageId: 7, topicId: 3, text: 'real payload', fromUser: true, timestamp: NOW })}\n`);
    const authority = new ProductionMessageEvidenceAuthority(store); const base = evidence('duty'); base.nativeCoordinates = { topicId: 3, messageId: 7 };
    base.canonicalPayloadHash = 'a'.repeat(64); expect(authority.requery(base)).toBeNull();
    base.canonicalPayloadHash = crypto.createHash('sha256').update('real payload').digest('hex'); expect(authority.requery(base)?.authority).toBe('content-bound-store-row');
    base.nativeCoordinates.messageId = 8; expect(authority.requery(base)).toBeNull();
  });
  it('keeps stable ids path-independent and distinct for duplicate lines', () => {
    const compile = (root: string) => { fs.mkdirSync(root, { recursive: true }); const t = path.join(root, 'TENETS.md'); const c = path.join(root, 'charter.md'); fs.writeFileSync(t, 'Echo must act.\nEcho must act.\n'); fs.writeFileSync(c, 'Echo must act.\nEcho must act.\n'); return compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', tenetsPath: t, charterPath: c, now: NOW, requireMinimumCatalog: false }); };
    const a = compile(fs.mkdtempSync(path.join(os.tmpdir(), 'id-a-'))); const b = compile(fs.mkdtempSync(path.join(os.tmpdir(), 'id-b-')));
    expect(new Set(a.obligations.map(o => o.id)).size).toBe(4); expect(a.obligations.map(o => o.id)).toEqual(b.obligations.map(o => o.id));
  });
});

describe('admission, closure and waivers', () => {
  it('enforces concrete new-scope, send, and completion mutation doors', () => {
    const duties = [
      obligation({ id: 'cadence.report.3h', phase: 'cadence', failureAction: 'block-new-scope-and-escalate', status: 'open-unexecuted' }),
      obligation({ id: 'continuous.telegram.signature-verified', phase: 'continuous', failureAction: 'block-send', status: 'unknown' }),
      obligation({ id: 'continuous.save-before-words', phase: 'continuous', failureAction: 'block-completion-claim', status: 'failed' }),
    ];
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: duties } });
    expect(evaluateLifecycleGuard(ledger, 'new-scope').allowed).toBe(false); expect(evaluateLifecycleGuard(ledger, 'telegram-send').allowed).toBe(false); expect(evaluateLifecycleGuard(ledger, 'completion-claim').allowed).toBe(false);
  });

  it('native structural proof cannot satisfy semantic or authenticity duties', () => {
    const semantic = obligation({ id: 'preground.visible-discussion.pathway', evidencePolicy: { requiredAuthority: 'live-requeried-message' } }); const native = evidence(semantic.id); native.authority = 'native-local-store-presence'; native.verifiedPayload = JSON.stringify({ obligationId: semantic.id, verdict: 'pass', sourceHashes: ['source'], visibleTopicId: 43003 });
    expect(predicateSatisfied(semantic, native)).toBe(true); expect(evaluateObligations([{ ...semantic, status: 'satisfied', evidence: [native] }], NOW).issues.join(',')).toContain('predicate-unsatisfied');
  });
  it('materializes distinct missed cadence intervals into the immutable census', () => {
    const recurring = obligation({ id: 'cadence.report.3h', predicate: { recurring: true }, deadline: { dueAt: NOW, graceMs: 0 } });
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [recurring] } });
    const next = materializeCadenceInstances(ledger, '2026-08-28T22:00:00.000Z'); const instances = next.obligations.filter(o => o.id.includes('@'));
    expect(instances).toHaveLength(3); expect(new Set(instances.map(o => o.id)).size).toBe(3); expect(evaluateClosure(next).state).toBe('close_blocked');
  });
  it('retains every skipped 30-minute interval as a distinct failed census item', () => {
    const recurring = obligation({ id: 'cadence.stall-check.30m', phase: 'cadence', predicate: { recurring: true }, deadline: { dueAt: NOW, graceMs: 0 } }); const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [recurring] } });
    const next = materializeCadenceInstances(ledger, '2026-08-28T17:30:00.000Z'); expect(next.obligations.filter(o => o.id.includes('@'))).toHaveLength(4); expect(evaluateClosure(next).issues.some(i => i.includes('cadence.stall-check.30m@'))).toBe(true);
  });
  it('preserves the recurring grace on materialized cadence instances', () => {
    const recurring = obligation({ id: 'cadence.stall-check.30m', phase: 'cadence', predicate: { recurring: true }, deadline: { dueAt: NOW, graceMs: RECURRING_DUTY_DEFAULT_GRACE_MS } }); const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [recurring] } });
    const next = materializeCadenceInstances(ledger, '2026-08-28T16:30:00.000Z'); expect(next.obligations.filter(o => o.id.includes('@')).every(o => o.deadline.graceMs === RECURRING_DUTY_DEFAULT_GRACE_MS)).toBe(true);
  });
  it('materializes W32 cadence only as time becomes due and freezes the census at close or ceiling', () => {
    const compiled = compileWindowSources({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', tenetsPath: path.resolve('tests/fixtures/window-32-tenets.md'), charterPath: path.resolve('tests/fixtures/window-32-approved-charter.md'), now: NOW });
    const initial = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', compiled });
    expect(initial.obligations.filter(duty => duty.id.includes('@'))).toHaveLength(0);
    const atNinetyMinutes = '2026-08-28T17:30:00.000Z';
    const ticked = evaluateLifecycleTick(initial, { resolve: () => null }, { requery: () => null }, atNinetyMinutes).ledger;
    const dueInstances = ticked.obligations.filter(duty => duty.id.includes('@'));
    expect(dueInstances).toHaveLength(4);
    expect(dueInstances.every(duty => Date.parse(duty.deadline.dueAt) <= Date.parse(atNinetyMinutes))).toBe(true);

    ticked.state = 'active_mid_satisfied'; ticked.obligations.filter(duty => duty.phase === 'mid').forEach(duty => { duty.status = 'waived-for-phase-transition'; });
    const closing = transitionLedger(ticked, 'close_due', { now: atNinetyMinutes });
    expect(closing.recurrenceFrozenAt).toBe(atNinetyMinutes);
    expect(materializeCadenceInstances(closing, '2026-08-29T12:00:00.000Z').compiledObligationIds).toEqual(closing.compiledObligationIds);

    const expired = materializeCadenceInstances(initial, '2026-08-30T16:00:00.000Z');
    expect(expired.recurrenceFrozenAt).toBe(initial.windowCeilingAt);
    expect(expired.obligations.filter(duty => duty.id.includes('@')).every(duty => Date.parse(duty.deadline.dueAt) <= Date.parse(initial.windowCeilingAt!))).toBe(true);
    expect(materializeCadenceInstances(expired, '2026-09-01T16:00:00.000Z').compiledObligationIds).toEqual(expired.compiledObligationIds);
  });

  it('refuses active and terminal transition bypasses', () => {
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [obligation()] } });
    expect(() => transitionLedger(ledger, 'active_start')).toThrow('admission-not-proven'); expect(() => transitionLedger(ledger, 'closed_clean')).toThrow('invalid-lifecycle-transition');
  });
  it('turns a pending ownerless duty into open-unexecuted and refuses admission', () => {
    const result = evaluateObligations([obligation({ executorBinding: { kind: 'none', executorId: '', owner: '', registryCoordinates: '', enabled: false, dryRun: true } })], NOW);
    expect(result.admitted).toBe(false); expect(result.obligations[0].status).toBe('open-unexecuted');
  });
  it.each(['pending', 'open-unexecuted'] as const)('blocks closure for %s and omitted census entries', status => {
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [obligation({ status })] } });
    ledger.compiledObligationIds.push('omitted'); const result = evaluateClosure(ledger, []); expect(result.state).toBe('close_blocked'); expect(result.issues).toContain('census-missing:omitted');
  });
  it('allows clean closure only with a complete satisfied census', () => {
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [obligation({ status: 'satisfied', evidence: [evidence('duty')] })] } });
    ledger.nativeEvaluations.push({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', inputHash: 'a', inputBytes: '{}', storePath: 's', storeHash: 'b', storeBytesLength: 1, evaluatorVersion: 'v', output: { admitted: true }, evaluatedAt: NOW, nonce: 'native-1', mapping: {} });
    expect(evaluateClosure(ledger, ['duty']).state).toBe('closed_clean');
  });
  it('rejects replay, wrong principal, pre-approval, wildcard, expiry, wrong window, digest alteration and core waiver', () => {
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [obligation()] } }); ledger.usedNonces.push('used');
    const payload = { id: 'w', obligationIds: ['*'], reason: 'x', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'wrong', phase: 'start' as const, permit: 'phase-transition' as const, expiresAt: NOW, nonce: 'used', nonTransferable: true as const, createdAt: NOW };
    const waiver: Waiver = { ...payload, digest: waiverDigest(payload), operatorPrincipalId: 'wrong', approvedDigest: 'changed', approvedAt: NOW };
    expect(validateWaiver(waiver, ledger, 'operator', NOW)).toEqual(expect.arrayContaining(['wrong-window', 'wildcard-or-empty', 'nonce-replay', 'waiver-expired', 'wrong-principal', 'approval-unbound-or-precreated']));
  });
  it('rejects an otherwise valid waiver for a core duty', () => {
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [obligation()] } });
    const payload = { id: 'w', obligationIds: ['duty'], reason: 'x', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', phase: 'start' as const, permit: 'debt-only' as const, expiresAt: future, nonce: 'new', nonTransferable: true as const, createdAt: '2026-08-28T15:00:00Z' };
    const digest = waiverDigest(payload); expect(validateWaiver({ ...payload, digest, operatorPrincipalId: 'operator', approvedDigest: digest, approvedAt: NOW, approvalCoordinates: { topicId: 1, messageId: 2 } }, ledger, 'operator', NOW)).toContain('core-duty-non-waivable:duty');
  });
  it('applies an exact phase waiver and can reach only closed with operator waiver', () => {
    const duty = obligation({ coreDuty: false, waiverPolicy: 'phase-transition', phase: 'continuous', status: 'failed' });
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [duty] } });
    ledger.nativeEvaluations.push({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', inputHash: 'a', inputBytes: '{}', storePath: 's', storeHash: 'b', storeBytesLength: 1, evaluatorVersion: 'v', output: { admitted: true }, evaluatedAt: NOW, nonce: 'native-1', mapping: {} });
    const payload = { id: 'waiver-ok', obligationIds: ['duty'], reason: 'operator accepted bounded non-core gap', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', phase: 'continuous' as const, permit: 'phase-transition' as const, expiresAt: future, nonce: 'waiver-ok-1', nonTransferable: true as const, createdAt: '2026-08-28T15:00:00Z' }; const digest = waiverDigest(payload);
    const next = applyWaiver(ledger, { ...payload, digest, operatorPrincipalId: 'telegram:1', approvedDigest: digest, approvedAt: NOW, approvalCoordinates: { topicId: 36966, messageId: 7 } }, 'telegram:1', NOW);
    expect(evaluateClosure(next, undefined, { now: NOW, requeryWaiverApproval: () => true }).state).toBe('closed_with_operator_waiver');
  });

  it('never lets post-live failure reach clean closure', () => {
    const post = obligation({ id: 'postlive.verdict.pass-required', phase: 'post-live', status: 'failed' }); const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [post] } });
    expect(evaluateClosure(ledger).state).toBe('close_blocked');
  });
});
