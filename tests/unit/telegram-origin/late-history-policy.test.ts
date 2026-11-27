import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalOrigin, originDigest, wireDigest } from '../../../src/messaging/telegram-origin/CanonicalOrigin.js';
import { sealOriginAdmission } from '../../../src/messaging/telegram-origin/OriginAdmissionSeal.js';
import { originMessageHistoryText } from '../../../src/messaging/telegram-origin/ForwardedDeliveryHistory.js';
import { lateRecoveredReplyNotice } from '../../../src/messaging/telegram-origin/SessionDeliveryNotice.js';
import type { OriginPreparedBotOperation } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { compileOriginWorker } from '../../helpers/telegramOriginStore.js';
import { lateCapacityHarness } from '../../helpers/telegramLateCapacity.js';

let worker: URL;
const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe('history for a historical reply without retained policy text', () => {
  it('retains the pre-prefix fallback through real late replacement, so history has one late notice', async () => {
    const h = await lateCapacityHarness(worker);
    cleanup.push(h.close);
    const service = h.runtime.service;
    const firstPreparedAt = Date.now() - 7 * 60_000;
    const authored = 'The answer written before delivery was delayed.';
    const previousNow = service.options.now;
    let original: OriginPreparedBotOperation;
    try {
      service.options.now = () => firstPreparedAt;
      original = await service.runWithSessionToken(h.sessionToken, async () => service.prepareBot({
        method: 'sendMessage', accountId: '123',
        params: { chat_id: '-100123', message_thread_id: 42, text: authored },
      }));
    } finally { service.options.now = previousNow; }

    // Today's builder always retains policy text. Model the historical signed
    // shape by removing it BEFORE admission, recomputing its plan/materialization
    // commitments and signing with this fixture's real machine key. The actual
    // service verifies and admits it; no store or verification method is mocked.
    const historicalChildren = original.admission.children.map(child => {
      const materialization = child.materializations[0];
      const request = JSON.parse(materialization.requestJson);
      delete request.policy;
      materialization.requestJson = canonicalOrigin(request);
      materialization.requestDigest = wireDigest(materialization.requestJson);
      return { childId: child.childId, materializationId: materialization.materializationId,
        request, requestDigest: materialization.requestDigest };
    });
    original.record.planDigest = originDigest(historicalChildren);
    original.admission.payloadBytes = historicalChildren.reduce((bytes, child) => bytes + Buffer.byteLength(canonicalOrigin(child.request)), 0);
    sealOriginAdmission(original, service.options.signingKey, firstPreparedAt);
    expect(JSON.parse(original.admission.children[0].materializations[0].requestJson).policy).toBeUndefined();
    await service.admit(original);
    expect((await h.runtime.store.getOperation(original.record.operationId))?.operation?.state).toBe('admitted');

    // Isolate the late-mark stage, not a provider send: exercising full recovery
    // would also test the separately owned policy/replay behavior of old senders.
    const marking = h.runtime as unknown as {
      markLateDirect(operation: OriginPreparedBotOperation): Promise<OriginPreparedBotOperation>;
    };
    const replacement = await marking.markLateDirect(original);
    expect(replacement.record.operationId).not.toBe(original.record.operationId);
    expect((await h.runtime.store.getOperation(original.record.operationId))?.operation?.state).toBe('superseded');
    const persisted = (await h.runtime.store.getOperation(replacement.record.operationId))?.operation;
    expect(persisted).toMatchObject({ state: 'admitted', firstPreparedAt });
    expect(Number.isSafeInteger(persisted?.lateMarkedAt)).toBe(true);
    const line = lateRecoveredReplyNotice(firstPreparedAt, persisted!.lateMarkedAt!)!;
    expect(line).toContain('written more than 7 minutes ago');
    const request = JSON.parse(replacement.admission.children[0].materializations[0].requestJson);
    expect(request.policy.text).toBe(authored);
    expect(JSON.parse(request.body).text).toContain(`${line}\n\n${authored}`);
    const history = originMessageHistoryText(request, { firstPreparedAt, lateMarkedAt: persisted!.lateMarkedAt! });
    expect(history).toBe(`${line}\n\n${authored}`);
    expect(history!.split(line)).toHaveLength(2);
    expect((await marking.markLateDirect(replacement)).record.operationId).toBe(replacement.record.operationId);
    expect(h.network).not.toHaveBeenCalled();
  });
});
