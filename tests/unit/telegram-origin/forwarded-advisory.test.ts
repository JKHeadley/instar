/**
 * native-conversation-forwarded-advisory (slice 3g) — Tier 1: the classifier, the
 * verdict column on the real origin-store worker, the author's reading of the
 * holder's answers, and the session line.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { policyVerdictClass, classifyPolicyRefusal, isVerdictRule } from '../../../src/messaging/telegram-origin/OriginPolicyClassifier.js';
import { advisoryReference, advisorySessionLine, cleanSuggestion, isOperationReference, readPolicyVerdict } from '../../../src/messaging/telegram-origin/OriginPolicyVerdict.js';
import { classifyHolderReceipt, forwardExpiryArm, recoverForwardedHold, submitOriginToHolder } from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardRecoveryDeps, HeldForwardDetail } from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import { classifyOperationOutcome } from '../../../src/messaging/telegram-origin/OriginOperationOutcome.js';
import { definiteSessionLine } from '../../../src/messaging/telegram-origin/SessionDeliveryNotice.js';
import { refreshHeldReplyAdvisoryAwareness, telegramOriginHeldLateAwareness, HELD_REPLY_ADVISORY_AWARENESS_MARKER } from '../../../src/messaging/telegram-origin/OriginAwareness.js';
import { admission, compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
import type { HeldOperationRow, OriginAuditRecord } from '../../../src/messaging/telegram-origin/StoreTypes.js';
import type { OriginSendPolicyDecision } from '../../../src/messaging/telegram-origin/OriginSendPolicy.js';

type Refusal = Extract<OriginSendPolicyDecision, { ok: false }>;
const refusal = (body: Record<string, unknown>, reason = String(body.error ?? body.blockedBy ?? 'refused')): Refusal => ({ ok: false, status: 422, reason, body });
const ADVISORY = refusal({ error: 'tone-gate-advisory', notSent: true, rule: 'B11_STYLE_MISMATCH', issue: 'private reasoning about the text',
  suggestion: 'Shorter.\nUse `plain` words.', decisionRef: 'dq-123' });

let worker: URL;
const stores: OriginStore[] = [], dirs: string[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); }, 30_000);
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/telegram-origin/forwarded-advisory.test.ts:cleanup' });
});
async function open(stateDir = temporaryState()) {
  dirs.push(stateDir);
  const store = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker); stores.push(store);
  return { store, stateDir };
}
const verdict = (cls: 'advisory' | 'refused' = 'advisory') => cls === 'advisory'
  ? { class: 'advisory', rule: 'B11_STYLE_MISMATCH', suggestion: 'Shorter.', decisionRef: 'dq-123', at: Date.now(), machineId: 'holder' }
  : { class: 'refused', rule: 'credential-exposure-guard', at: Date.now(), machineId: 'holder' };

describe('item 1 — the classifier', () => {
  it('reads every refusal body by allow-list', () => {
    expect(policyVerdictClass(ADVISORY)).toBe('advisory');
    expect(policyVerdictClass(refusal({ error: 'Message blocked: credential', blockedBy: 'credential-exposure-guard', overridable: false }))).toBe('refused');
    expect(policyVerdictClass(refusal({ error: 'Message blocked: local link', blockedBy: 'localhost-link-guard' }))).toBe('refused');
    expect(policyVerdictClass(refusal({ error: 'tone-gate-advisory-reason-required', rule: 'B11_STYLE_MISMATCH' }))).toBe('refused');
    expect(policyVerdictClass(refusal({ error: 'tone-gate-blocked', rule: 'B1_CLI_COMMAND' }))).toBe('refused');
    // An advisory demoted for lack of evidence recording is a definite refusal at the script, so here too.
    expect(policyVerdictClass(refusal({ error: 'tone-gate-blocked', rule: 'B11_STYLE_MISMATCH', advisoryUnavailable: 'no-decision-ref' }))).toBe('refused');
    // The deterministic floor caught a real rule during an outage: a verdict.
    expect(policyVerdictClass(refusal({ error: 'tone-gate-blocked', rule: 'B1_CLI_COMMAND', failedClosed: true, degradedToDeterministic: true }))).toBe('refused');
  });
  it('never reads a review that produced no verdict as an ending', () => {
    for (const rule of ['CAPACITY_UNAVAILABLE', 'GATE_UNAVAILABLE', 'GATE_TIMEOUT', 'NOT_A_REAL_RULE', undefined]) {
      expect(policyVerdictClass(refusal({ error: 'tone-gate-blocked', ...(rule ? { rule } : {}) }))).toBe('retain');
    }
    // A real rule on a pure fail-closed hold (no floor catch) is an outage, not a verdict.
    expect(policyVerdictClass(refusal({ error: 'tone-gate-blocked', rule: 'B1_CLI_COMMAND', failedClosed: true }))).toBe('retain');
    for (const reason of ['content-reservation-pending', 'duplicate-content', 'content-dedup-unavailable', 'telegram-session-stood-down']) {
      expect(policyVerdictClass(refusal({ error: reason }, reason))).toBe('retain');
    }
    expect(policyVerdictClass(null)).toBe('retain');
    expect(isVerdictRule('CAPACITY_UNAVAILABLE')).toBe(false);
    expect(isVerdictRule('B11_STYLE_MISMATCH')).toBe(true);
  });
  it('records class, rule, reference and a cleaned suggestion; never the issue; a refusal keeps class and rule only', () => {
    const recorded = classifyPolicyRefusal(ADVISORY, 'holder', 5)!;
    expect(recorded).toEqual({ class: 'advisory', rule: 'B11_STYLE_MISMATCH', suggestion: "Shorter. Use 'plain' words.", decisionRef: 'dq-123', at: 5, machineId: 'holder' });
    expect(JSON.stringify(recorded)).not.toContain('private reasoning');
    expect(classifyPolicyRefusal(refusal({ error: 'x', blockedBy: 'credential-exposure-guard', credentialKind: 'github-token' }), 'holder', 5))
      .toEqual({ class: 'refused', rule: 'credential-exposure-guard', at: 5, machineId: 'holder' });
    expect(classifyPolicyRefusal(refusal({ error: 'tone-gate-blocked', rule: 'CAPACITY_UNAVAILABLE' }), 'holder', 5)).toBeNull();
    expect(cleanSuggestion('a'.repeat(900))).toHaveLength(500);
    expect(readPolicyVerdict('{"class":"advisory"}')).toBeNull();
  });
});

describe('item 2 — the verdict column', () => {
  it('survives a re-hold and a restart, refuses admitted, and the first verdict wins', async () => {
    const stateDir = temporaryState();
    const { store } = await open(stateDir);
    const a = admission('advisory-local'); await store.admit(a);
    expect(await store.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'tone-advisory', policyVerdict: verdict() })).toBe(true);
    // A later verdict never overwrites the first (a losing writer answers custody).
    expect(await store.recordOperationState({ operationId: a.operationId, state: 'suppressed', holdReason: 'policy-refused', policyVerdict: verdict('refused') })).toBe(false);
    expect(await store.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: { kind: 'x' } })).toBe(true);
    expect(await store.recordOperationState({ operationId: a.operationId, state: 'admitted' })).toBe(false);
    await store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = (await open(stateDir)).store;
    const audit = await reopened.getOperation(a.operationId);
    expect(audit?.operation?.state).toBe('held');
    expect(audit?.operation?.policyVerdict).toMatchObject({ class: 'advisory', rule: 'B11_STYLE_MISMATCH', decisionRef: 'dq-123' });
    expect(classifyOperationOutcome(a.operationId, audit, [])).toMatchObject({ outcome: 'not-delivered', safeToResend: false, reason: 'tone-advisory' });
  });
  it('a claimed row refuses the verdict-and-end write (the claim won)', async () => {
    const { store } = await open();
    const a = admission('claimed'); await store.admit(a);
    const claim = await store.claim({ childId: a.children[0].childId, materializationId: a.children[0].materializations[0].materializationId, ownerBootId: 'boot-1', leaseMs: 60_000 });
    expect(claim.status).toBe('claimed');
    expect(await store.recordOperationState({ operationId: a.operationId, state: 'suppressed', holdReason: 'tone-advisory', policyVerdict: verdict() })).toBe(false);
    expect((await store.getOperation(a.operationId))?.operation?.policyVerdict).toBeUndefined();
  });
  it('an advisory row is never recovered, never due, never counted as will-be-delivered; refused rows end', async () => {
    const { store } = await open();
    const held = admission('held-advisory'); await store.admit(held);
    const plain = admission('plain'); await store.admit(plain);
    expect(await store.recordOperationState({ operationId: held.operationId, state: 'held', holdReason: 'tone-advisory', policyVerdict: verdict() })).toBe(true);
    const recoverable = await store.takeRecoverableAdmissions({ limit: 10 });
    expect(recoverable.map(r => r.operationId)).toEqual([plain.operationId]);
    expect(await store.reserveRecoveryAttempt({ operationId: held.operationId })).toBe(false);
    expect((await store.listHeldOperations({ advisory: 'exclude' })).map(r => r.operationId)).not.toContain(held.operationId);
    expect((await store.listHeldOperations({ advisory: 'only' })).map(r => r.operationId)).toEqual([held.operationId]);
    const refused = admission('refused'); await store.admit(refused);
    expect(await store.recordOperationState({ operationId: refused.operationId, state: 'suppressed', holdReason: 'policy-refused', policyVerdict: verdict('refused') })).toBe(true);
    expect(classifyOperationOutcome(refused.operationId, await store.getOperation(refused.operationId), [])).toMatchObject({ outcome: 'not-delivered', safeToResend: false, failure: 'refused', reason: 'policy-refused' });
  });
  it('markForwardAdvisory keeps the text, marks outcome-unknown, leaves the due ladder; once', async () => {
    const { store } = await open();
    const a = admission('forward'); await store.admit(a);
    const detail = { kind: 'forward-to-holder', lastAttempt: 'refused', machineId: 'holder', topicId: 12, chatId: '-100123', text: 'The authored answer.', reason: 'x', at: 1,
      noticeDelivered: false, ladder: { attempts: 0, nextAt: Date.now() - 1 } };
    expect(await store.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: detail })).toBe(true);
    expect((await store.heldForwardAdmissions({ limit: 10 })).length).toBe(1);
    expect(await store.markForwardAdvisory({ operationId: a.operationId, verdict: verdict() })).toBe(true);
    expect(await store.markForwardAdvisory({ operationId: a.operationId, verdict: verdict() })).toBe(false);
    const op = (await store.getOperation(a.operationId))!.operation!;
    expect(op.holdDetail).toMatchObject({ text: 'The authored answer.', lastAttempt: 'outcome-unknown', machineId: 'holder', ladder: { nextAt: null } });
    expect(await store.heldForwardAdmissions({ limit: 10 })).toEqual([]);
    expect((await store.getMetrics()).counts['advisory-handed-back']).toBe(1);
  });
  it('more advisory rows than the due batch never hide a deliverable forward behind them', async () => {
    const { store } = await open();
    const past = Date.now() - 1;
    for (let i = 0; i < 12; i++) {
      const a = admission(`advisory-${i}`); await store.admit(a);
      await store.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: { kind: 'forward-to-holder', text: 't', chatId: '-1', topicId: 1, ladder: { attempts: 0, nextAt: past } } });
      expect(await store.markForwardAdvisory({ operationId: a.operationId, verdict: verdict() })).toBe(true);
    }
    const deliverable = admission('deliverable'); await store.admit(deliverable);
    await store.recordOperationState({ operationId: deliverable.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: { kind: 'forward-to-holder', text: 't', chatId: '-1', topicId: 1, ladder: { attempts: 0, nextAt: past } } });
    expect((await store.heldForwardAdmissions({ limit: 10 })).map(d => d.admission.operationId)).toEqual([deliverable.operationId]);
    expect((await store.listHeldOperations({ holdReason: 'lease-not-held', limit: 500, advisory: 'exclude' })).map(r => r.operationId)).toEqual([deliverable.operationId]);
  });
  it('sums the answer delay once per answer', async () => {
    const { store } = await open();
    expect(await store.recordOperationSum({ eventId: 'op-1:answer-delay', metric: 'advisory-answer-delay-s', amount: 40 })).toBe(true);
    expect(await store.recordOperationSum({ eventId: 'op-1:answer-delay', metric: 'advisory-answer-delay-s', amount: 40 })).toBe(false);
    expect(await store.recordOperationSum({ eventId: 'op-2:answer-delay', metric: 'advisory-answer-delay-s', amount: 2 })).toBe(true);
    expect((await store.getMetrics()).counts['advisory-answer-delay-s']).toBe(42);
    expect((await store.getFederatedMetrics('m1')).counts['advisory-answer-delay-s']).toBe(42);
  });
});

describe('item 3 — the author reads the holder', () => {
  const answer = (result: Record<string, unknown>) => classifyHolderReceipt({ ok: true, result: { ok: true, operationId: 'op-1', outcome: 'not-delivered', ...result } }, 'op-1', 'holder');
  it('receipt: tone-advisory with a verdict is owner-advisory; policy-refused or an unreadable verdict is a policy refusal', () => {
    expect(answer({ state: 'suppressed', reason: 'tone-advisory', policyVerdict: verdict() })).toMatchObject({ state: 'owner-advisory', verdict: { rule: 'B11_STYLE_MISMATCH' } });
    expect(answer({ state: 'suppressed', reason: 'tone-advisory' })).toEqual({ state: 'owner-verdict', failure: 'refused', policyRule: null });
    expect(answer({ state: 'suppressed', reason: 'policy-refused', policyVerdict: verdict('refused') })).toEqual({ state: 'owner-verdict', failure: 'refused', policyRule: 'credential-exposure-guard' });
  });
  it('submit: a policy refusal without copyEnded (an older holder keeps its row) is custody, never "not sent"', async () => {
    const send = async (command: { action: string }) => command.action === 'capabilities'
      ? { ok: true, result: { ok: true, protocol: 'instar-telegram-origin-v1', credentialOwner: true, accountId: '1', executionOwnerMachineId: 'holder' } }
      : { ok: true, result: { ok: false, reason: 'tone-gate-advisory', outcome: 'held', operationId: 'op-1', policyRefusal: ADVISORY } };
    const operation = { record: { operationId: 'op-1', originId: 'o', originMachineId: 'author' }, admission: {} } as never;
    expect(await submitOriginToHolder({ operation, send: send as never, expectedOwner: 'holder' })).toMatchObject({ ok: false, outcome: 'outcome-unknown', admittedAtHolder: true });
    const ended = async (command: { action: string }) => command.action === 'capabilities' ? send(command)
      : { ok: true, result: { ok: false, reason: 'tone-gate-advisory', outcome: 'held', operationId: 'op-1', policyRefusal: ADVISORY, copyEnded: true, policyVerdict: verdict() } };
    expect(await submitOriginToHolder({ operation, send: ended as never, expectedOwner: 'holder' })).toMatchObject({ ok: false, copyEnded: true, policyVerdict: { class: 'advisory' } });
  });
  it('forwardExpiryArm reads an advisory row as definite (deadline), before its outcome-unknown marker', () => {
    const holdDetail = { lastAttempt: 'outcome-unknown' } as Record<string, unknown>;
    expect(forwardExpiryArm({ holdDetail })).toEqual({ arm: 'uncertain' });
    expect(forwardExpiryArm({ holdDetail, policyVerdict: verdict() })).toEqual({ arm: 'definite', cause: 'deadline' });
  });
  function recoveryHarness(row: Partial<HeldOperationRow>, submitResult?: unknown) {
    const detail: HeldForwardDetail = { kind: 'forward-to-holder', lastAttempt: 'refused', machineId: 'holder', topicId: 12, chatId: '-1', text: 'The authored answer.',
      reason: 'x', at: 1, noticeDelivered: false, ladder: { attempts: 3, nextAt: null } };
    const full: HeldOperationRow = { operationId: 'op-1', originId: 'o', state: 'held', holdReason: 'lease-not-held', holdDetail: detail as never, preparedAt: Date.now(),
      deadlineAt: Date.now() + 3_600_000, executionOwnerMachineId: 'holder', destination: { accountId: '1', chatId: '-1', topicId: '12' }, recovery: null, expiryReportedAt: null,
      producerKind: 'session', ...row };
    const deps = {
      lease: { selfMachineId: 'author', leaseHolder: () => 'holder', holdsLease: () => false, isHolderHealthy: () => true },
      prepare: vi.fn(), submit: vi.fn(async () => submitResult), receipt: vi.fn(), settleUnknown: vi.fn(), resolve: vi.fn(async () => true),
      rehold: vi.fn(async () => true), supersede: vi.fn(), sendLocal: vi.fn(), mergeDetail: vi.fn(async () => true), onOwnerVerdict: vi.fn(),
      markAdvisory: vi.fn(async () => true), onAdvisory: vi.fn(), audit: () => undefined, now: Date.now,
    } satisfies Partial<ForwardRecoveryDeps>;
    const operation = { record: { operationId: 'op-1', executionOwnerMachineId: 'holder', producerKind: 'session', operationKind: 'sendMessage', originMachineId: 'author' },
      admission: { children: [{}], preparedAt: Date.now() } } as never;
    return { deps, run: () => recoverForwardedHold(deps as unknown as ForwardRecoveryDeps, full, operation) };
  }
  it('an advisory row is skipped outright: no submit, no local send, no supersede', async () => {
    const h = recoveryHarness({ policyVerdict: verdict() });
    expect(await h.run()).toBe('skipped');
    expect(h.deps.submit).not.toHaveBeenCalled(); expect(h.deps.sendLocal).not.toHaveBeenCalled(); expect(h.deps.supersede).not.toHaveBeenCalled();
  });
  it('a re-forward answered "copy ended, advisory" records the advisory and is never re-forwarded', async () => {
    const h = recoveryHarness({}, { ok: false, reason: 'tone-gate-advisory', outcome: 'held', retryable: false, policyRefusal: ADVISORY, copyEnded: true, policyVerdict: verdict() });
    expect(await h.run()).toBe('settled');
    expect(h.deps.markAdvisory).toHaveBeenCalledWith('op-1', expect.objectContaining({ class: 'advisory' }));
    expect(h.deps.onAdvisory).toHaveBeenCalledOnce();
    expect(h.deps.submit).toHaveBeenCalledOnce();
  });
  it('a re-forward answered "copy ended, refused" records a policy refusal (ownerVerdict refused by policy)', async () => {
    const h = recoveryHarness({}, { ok: false, reason: 'credential-exposure-guard', outcome: 'held', retryable: false, policyRefusal: refusal({ blockedBy: 'credential-exposure-guard' }),
      copyEnded: true, policyVerdict: verdict('refused') });
    expect(await h.run()).toBe('settled');
    expect(h.deps.mergeDetail).toHaveBeenCalledWith('op-1', { ownerVerdict: expect.objectContaining({ failure: 'refused', refusedBy: 'policy', rule: 'credential-exposure-guard' }) });
    expect(h.deps.markAdvisory).not.toHaveBeenCalled();
  });
});

describe('item 4 — the session line', () => {
  it('names the rule, the suggestion, the deadline and the reference, for both reference forms', () => {
    const at = Date.UTC(2026, 10, 12, 18, 5);
    const line = advisorySessionLine({ operationId: 'op-1', rule: 'B11_STYLE_MISMATCH', suggestion: 'Shorter', deadlineAt: at, ref: advisoryReference({ decisionRef: 'dq-9' }, 'op-2') });
    expect(line).toBe('Your reply `op-1` was not sent. The outbound check has a suggestion (`B11_STYLE_MISMATCH`): Shorter. It stays held until you answer and ends undelivered at 18:05 UTC. ' +
      'To send a revised version, send it with `--tone-complied B11_STYLE_MISMATCH --tone-decision-ref dq-9`. To send it as written, resend its text with ' +
      '`--tone-ack B11_STYLE_MISMATCH --tone-reason "<why>" --tone-decision-ref dq-9`. A reply sent without that reference is a separate message and leaves this one held. ' +
      'Its text is at `GET /telegram/origins/operations/op-1/text`.');
    const own = advisoryReference({ decisionRef: null }, 'op-2');
    expect(own).toBe('op:op-2'); expect(isOperationReference(own)).toBe(true); expect(isOperationReference('dq-9')).toBe(false);
    expect(advisorySessionLine({ operationId: 'op-1', rule: 'B11_STYLE_MISMATCH', deadlineAt: at, ref: own })).toContain('--tone-decision-ref op:op-2');
  });
  it('the definite lines: a policy refusal names the check, and an unanswered advisory says what to do if it was revised', () => {
    expect(definiteSessionLine({ operationId: 'op-1', ageMs: 120_000, cause: 'refused', policyRule: 'B1_CLI_COMMAND' }))
      .toMatch(/was not delivered \(the outbound check refused it \(`B1_CLI_COMMAND`\)\) and will not be retried\..*Rewrite it before sending again\.$/);
    expect(definiteSessionLine({ operationId: 'op-1', ageMs: 120_000, cause: 'deadline', advisoryExpired: true })).toMatch(/If you already sent a revised version, do nothing\.$/);
    expect(definiteSessionLine({ operationId: 'op-1', ageMs: 120_000, cause: 'refused' })).toContain('Telegram refused it');
  });
});

describe('item 7 — awareness', () => {
  it('the held-reply paragraph names the advisory line; an installed paragraph gains it once', () => {
    const current = telegramOriginHeldLateAwareness();
    expect(current).toContain(HELD_REPLY_ADVISORY_AWARENESS_MARKER);
    const installed = current.replace(/ A reply the outbound check handed back while it was held[^]*?nothing else ever sends it\./, '');
    expect(installed).not.toContain(HELD_REPLY_ADVISORY_AWARENESS_MARKER);
    const refreshed = refreshHeldReplyAdvisoryAwareness(`# Agent\n\n${installed}`);
    expect(refreshed).toBe(`# Agent\n\n${current}`);
    expect(refreshHeldReplyAdvisoryAwareness(refreshed)).toBe(refreshed);
    expect(refreshHeldReplyAdvisoryAwareness('# no paragraph')).toBe('# no paragraph');
  });
});

describe('the outcome classifier reads the column first', () => {
  it('a held row with an advisory, and a suppressed tone-advisory copy, are never safe to resend', () => {
    const base = { sequence: 1, record: { envelopeJson: '{}' } as never, children: [], attempts: [] } as unknown as OriginAuditRecord;
    const held = { ...base, operation: { operationId: 'a', preparedAt: 1, deadlineAt: 2, maxAttempts: 1, state: 'held', holdReason: 'lease-not-held', holdDetail: {}, policyVerdict: verdict() } };
    expect(classifyOperationOutcome('a', held, [])).toMatchObject({ outcome: 'not-delivered', safeToResend: false, reason: 'tone-advisory' });
    const copy = { ...base, operation: { operationId: 'a', preparedAt: 1, deadlineAt: 2, maxAttempts: 1, state: 'suppressed', holdReason: 'tone-advisory', holdDetail: null } };
    expect(classifyOperationOutcome('a', copy, [])).toMatchObject({ outcome: 'not-delivered', safeToResend: false, reason: 'tone-advisory' });
  });
});
