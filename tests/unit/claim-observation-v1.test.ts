import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyClaimCriticalityFloor,
  assessClaim,
  buildClaimCandidates,
  parseGeneralClaimEnvelope,
  prepareClaimObservation,
  protectedCueGaps,
  ClaimObservationRecorder,
  ClaimObservationHousekeeper,
  type ExtractedClaim,
} from '../../src/monitoring/ClaimObservation.js';
import { ClaimObservationAdmissionQueue } from '../../src/monitoring/ClaimObservationAdmissionQueue.js';

const capacityClaim = (overrides: Partial<ExtractedClaim> = {}): ExtractedClaim => ({
  clauseId: 0,
  kind: 'capacity-limit',
  subjectKind: 'capacity-model',
  predicate: 'capacity.limit',
  operand: { type: 'integer', value: 4, unit: 'lanes' },
  comparator: 'eq',
  subjectSelector: { type: 'unresolved' },
  consequence: { relation: 'none', actionClass: 'none' },
  sourceStartByte: 0,
  sourceEndByte: 23,
  referencedEntityHints: [],
  endorsed: true,
  negated: false,
  hedged: false,
  quoted: false,
  suggestedCriticality: 'low',
  confidence: 0.99,
  tenseScope: 'current',
  ...overrides,
});

describe('claim observation v1 dark core', () => {
  it('owns per-topic admission, attempt idempotency, and queue caps outside the verifier', () => {
    const queue = new ClaimObservationAdmissionQueue({ maxQueued: 2, maxQueuedPerTopic: 1, maxConcurrent: 1 });
    queue.setWorker(async () => new Promise<void>(() => {}));
    const base = { message: 'one', evidence: { hadToolCalls: false, toolCalls: [], truncated: false,
      unavailable: false, canaryOk: true }, context: { topicId: 7, messageAttemptId: 'attempt-1' } };
    expect(queue.enqueue(base, 'fingerprint-1')).toEqual({ accepted: true });
    expect(queue.enqueue(base, 'fingerprint-1')).toEqual({ accepted: true });
    expect(queue.enqueue({ ...base, message: 'collision' }, 'fingerprint-2')).toMatchObject({ accepted: false, reason: 'attempt-id-collision' });
    expect(queue.enqueue({ ...base, context: { topicId: 7, messageAttemptId: 'attempt-2' } }, 'fingerprint-2'))
      .toMatchObject({ accepted: false, reason: 'topic-queue-full' });
  });
  it('scrubs provider-bound content and recomputes candidates over scrubbed bytes', () => {
    const prepared = prepareClaimObservation(
      'Capacity is four. token=ghp_abcdefghijklmnopqrstuvwxyz123456',
      { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true },
    );
    expect(prepared.policy).toBe('standard-scrubbed');
    expect(prepared.message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(prepared.message).toContain('[REDACTED_SECRET_');
    expect(prepared.candidates).toEqual(buildClaimCandidates(prepared.message));
  });

  it('rejects invalid offsets and caps general extraction at four claims', () => {
    const message = 'We are capped at four lanes.';
    const good = capacityClaim({ sourceEndByte: Buffer.byteLength(message) });
    expect(parseGeneralClaimEnvelope(JSON.stringify({ schemaVersion: 1, claims: [good] }), message)?.claims).toHaveLength(1);
    expect(parseGeneralClaimEnvelope(JSON.stringify({ schemaVersion: 1, claims: [{ ...good, sourceEndByte: 999 }] }), message)).toBeNull();
    expect(parseGeneralClaimEnvelope(JSON.stringify({ schemaVersion: 1, claims: [good, good, good, good, good] }), message)).toBeNull();
  });

  it('never lets hedging or model suggestion lower protected criticality floors', () => {
    expect(applyClaimCriticalityFloor(capacityClaim({ hedged: true, suggestedCriticality: 'low' }))).toBe('high');
    expect(applyClaimCriticalityFloor(capacityClaim({
      consequence: { relation: 'premise-for', actionClass: 'production-deploy', actionStartByte: 24, actionEndByte: 30 },
    }))).toBe('irreversible-precondition');
  });

  it('keeps unsupported capacity and PR assertions unverifiable', () => {
    expect(assessClaim(capacityClaim(), { evidence: { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true } })).toMatchObject({
      verdict: 'unverifiable', reasonCode: 'no-canonical-oracle', sourceKind: 'none',
    });
    expect(assessClaim(capacityClaim({ predicate: 'pull-request.merged', kind: 'state-fact', subjectKind: 'pull-request' }), {
      evidence: { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true },
    })).toMatchObject({ verdict: 'unverifiable', reasonCode: 'no-canonical-oracle' });
  });

  it('corroborates same-turn completion only from matching structural evidence', () => {
    const claim = capacityClaim({
      kind: 'completion', subjectKind: 'tool-action', predicate: 'tool-action.completed',
      subjectSelector: { type: 'same-turn-action', actionIndex: 0 }, operand: { type: 'boolean', value: true },
      tenseScope: 'past',
    });
    const result = assessClaim(claim, { evidence: { hadToolCalls: true, truncated: false, unavailable: false, canaryOk: true,
      toolCalls: [{ tool: 'Bash', actionKind: 'pushed', ok: true }] } });
    expect(result).toMatchObject({ verdict: 'supported', reasonCode: 'same-turn-evidence', sourceKind: 'turn-evidence' });
  });

  it('uses only fresh exact session, commitment, and guard snapshots', () => {
    const now = new Date('2026-07-20T20:00:00.000Z');
    const evidence = { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true };
    const elapsed = capacityClaim({ kind: 'temporal', subjectKind: 'session', predicate: 'session.elapsed-ms',
      operand: { type: 'duration-ms', value: 3_600_000 }, comparator: 'eq', subjectSelector: { type: 'current-session' } });
    expect(assessClaim(elapsed, { evidence, now, sessionSnapshot: { state: 'running', elapsedMs: 3_900_000,
      revision: 'session-r1', observedAt: now.toISOString() } })).toMatchObject({ verdict: 'supported', sourceRevision: 'session-r1' });

    const commitment = capacityClaim({ kind: 'state-fact', subjectKind: 'commitment', predicate: 'commitment.state',
      operand: { type: 'state-enum', value: 'verified', enumVersion: 'commitment-v1' }, comparator: 'eq',
      subjectSelector: { type: 'explicit-id', entityKind: 'commitment', id: 'CMT-7' } });
    expect(assessClaim(commitment, { evidence, now, commitmentSnapshots: {
      'CMT-7': { state: 'pending', revision: 'CMT-7:pending:r2', observedAt: now.toISOString() },
    } })).toMatchObject({ verdict: 'refuted', sourceKind: 'commitment-registry' });

    const guard = capacityClaim({ kind: 'state-fact', subjectKind: 'guard', predicate: 'guard.state',
      operand: { type: 'state-enum', value: 'on', enumVersion: 'guard-v1' }, comparator: 'eq',
      subjectSelector: { type: 'explicit-id', entityKind: 'guard', id: 'monitoring.example.enabled' } });
    expect(assessClaim(guard, { evidence, now, guardSnapshots: {
      'monitoring.example.enabled': { state: 'on', revision: 'guard-r3', observedAt: now.toISOString() },
    } })).toMatchObject({ verdict: 'supported', sourceRevision: 'guard-r3' });
  });

  it('records deterministic protected-cue extraction gaps without inventing a verdict', () => {
    const message = 'We are capped at four lanes and ready.';
    const gaps = protectedCueGaps(message, []);
    expect(gaps).toContain('capacity');
  });

  it('writes only scrubbed structural corpus metadata and keeps it automation-ineligible', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-corpus-'));
    const recorder = new ClaimObservationRecorder({ stateDir: dir, pseudonymKey: Buffer.alloc(32, 7) });
    const claim = capacityClaim();
    const assessment = assessClaim(claim, { evidence: { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true } });
    expect(recorder.record({ messageAttemptId: '018f47a0-1234-7abc-8def-123456789abc', topicId: 42,
      claim, assessment, finalCriticality: 'high', dryRun: true, bootId: 'boot-test' })).toBe(true);
    const raw = fs.readFileSync(path.join(dir, 'state', 'claim-verification', 'claim-benchmark-v1.jsonl'), 'utf8');
    expect(raw).not.toContain('We are capped');
    expect(JSON.parse(raw)).toMatchObject({ predicate: 'capacity.limit', criticality: 'high',
      labelTrustClass: 'none', automationEligible: false });
    expect(fs.statSync(path.join(dir, 'state', 'claim-verification', 'claim-benchmark-v1.jsonl')).mode & 0o777).toBe(0o600);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'claim-corpus-test' });
  });

  it('settles T0 only from a later exact authoritative outcome receipt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-t0-'));
    const recorder = new ClaimObservationRecorder({ stateDir: dir, pseudonymKey: Buffer.alloc(32, 3) });
    const claim = capacityClaim({ kind: 'completion', subjectKind: 'tool-action', predicate: 'tool-action.completed',
      subjectSelector: { type: 'same-turn-action', actionIndex: 0 }, operand: { type: 'boolean', value: true }, tenseScope: 'past' });
    const assessment = assessClaim(claim, { evidence: { hadToolCalls: true, truncated: false, unavailable: false,
      canaryOk: true, toolCalls: [{ tool: 'Bash', actionKind: 'pushed', ok: true }] } });
    expect(recorder.record({ messageAttemptId: '018f47a0-1234-7abc-8def-123456789abc', topicId: 7, claim, assessment,
      finalCriticality: 'high', dryRun: true, bootId: 'boot-test' })).toBe(true);
    const claimId = String(recorder.readAudit()[0].claimId);
    expect(recorder.recordAuthoritativeOutcome({ claimId, predicate: 'tool-action.completed',
      sourceRevision: 'wrong-revision', verdict: 'supported', observedAt: new Date().toISOString() })).toBe(false);
    expect(recorder.recordAuthoritativeOutcome({ claimId, predicate: 'tool-action.completed',
      sourceRevision: 'turn-evidence-v1', verdict: 'supported', observedAt: new Date().toISOString() })).toBe(true);
    const rows = fs.readFileSync(path.join(dir, 'state', 'claim-verification', 'claim-benchmark-v1.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({ labelTrustClass: 'T0', settlementState: 'settled',
      groundTruthVerdict: 'supported', correctness: true, outcomeRevision: 'turn-evidence-v1' });
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'claim-t0-test' });
  });

  it('repairs young legacy mode and deletes only expired exact legacy files with a receipt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-retention-'));
    const logs = path.join(dir, 'logs'); fs.mkdirSync(logs, { recursive: true });
    const old = path.join(logs, 'completion-claim-audit.jsonl');
    const young = path.join(logs, 'completion-claim-audit.jsonl.1');
    fs.writeFileSync(old, '{"legacy":true}\n', { mode: 0o644 });
    fs.writeFileSync(young, '{"young":true}\n', { mode: 0o644 });
    const now = Date.now(); fs.utimesSync(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000));
    const result = new ClaimObservationHousekeeper({ stateDir: dir, now: () => now }).sweep();
    expect(result).toMatchObject({ deleted: 1, failures: 0 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.statSync(young).mode & 0o777).toBe(0o600);
    const receipt = fs.readFileSync(path.join(dir, 'state', 'claim-verification', 'retention-receipts-v1.jsonl'), 'utf8');
    expect(receipt).toContain('legacy-completion-claim-audit');
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'claim-retention-test' });
  });
});
