import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import { TelegramOriginService } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import type { OriginServiceStore } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
import { PendingRelayStore } from '../../../src/messaging/pending-relay-store.js';
import { OriginCapacityUnavailable } from '../../../src/messaging/telegram-origin/OriginEgressCapacity.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';

const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); });
async function harness(hidden = false) {
  const stateDir = temporaryState();
  const store = await OriginStore.open({ stateDir, agentId: 'echo' }, worker); stores.push(store);
  const sessions = new OriginSessionRegistry({ stateDir, agentId: 'echo', machineId: 'studio', isSessionLive: () => true });
  await sessions.initialize();
  const onHold = vi.fn();
  const spoolEvidence = vi.fn(async () => { throw new Error('spool unavailable'); });
  const authorize = vi.fn(async () => true);
  const service = new TelegramOriginService({ store, sessions, observer: new RuntimeOriginObserver(),
    sendPolicy: { review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) },
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey: key, keyEpoch: 1, keyId: 'studio-1' }, ownerBootId: 'boot-1',
    display: () => ({ agent: { enabled: !hidden } }), authorize, onHold, spoolEvidence, reviewLegacyRecovery: async () => true });
  const input = { method: 'sendMessage', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, text: 'Original answer' } };
  const network = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {
    message_id: 7, chat: { id: -100123 }, message_thread_id: 42,
  } }), { status: 200 }));
  const send = () => service.runAsAutomation('telegram-server', () => service.sendBot(input, network));
  return { stateDir, store, service, input, network, send, authorize, onHold, spoolEvidence };
}
describe('origin service durable delivery', () => {
  it('replays an accepted logical automation send after worker restart without preparing new delivery custody', async () => {
    const h = await harness();
    const send = (service: TelegramOriginService, logicalId: string, input = h.input) => {
      const token = service.issueAutomationReply('telegram-server', 42, { text: input.params.text }, undefined, logicalId);
      return service.runWithAutomationReply(token, 42, { text: input.params.text }, () => service.sendBot(input, h.network));
    };
    expect((await send(h.service, 'beacon:0')).ok).toBe(true);
    await h.store.close();
    const store = await OriginStore.open({ stateDir: h.stateDir, agentId: 'echo' }, worker); stores.push(store);
    const restarted = new TelegramOriginService({ ...h.service.options, store, ownerBootId: 'boot-2' });
    expect((await send(restarted, 'beacon:0')).ok).toBe(true);
    expect(h.network).toHaveBeenCalledOnce();
    expect((await store.listOrigins()).records).toHaveLength(1);
    await expect(send(restarted, 'beacon:0', { ...h.input, params: { ...h.input.params, text: 'A different intended message' } }))
      .rejects.toMatchObject({ reason: 'logical-send-content-conflict', operationId: null });
    expect((await send(restarted, 'beacon:1')).ok).toBe(true);
    expect(h.network).toHaveBeenCalledTimes(2);
  });
  it('preserves split logical send ordinals across a lost response and worker restart', async () => {
    const h = await harness();
    h.network.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: {
      message_id: 7, chat: { id: -100123 }, message_thread_id: 42 } }))).mockRejectedValue(new Error('response lost'));
    const body = { text: 'First part and second part' };
    const send = (service: TelegramOriginService) => {
      const token = service.issueAutomationReply('telegram-server', 42, body, undefined, 'beacon:split:0');
      return service.runWithAutomationReply(token, 42, body, async () => {
        await service.sendBot({ ...h.input, params: { ...h.input.params, text: 'First part' } }, h.network);
        return service.sendBot({ ...h.input, params: { ...h.input.params, text: 'Second part' } }, h.network);
      });
    };
    let operationId: string | null = null;
    try { await send(h.service); } catch (error) { operationId = (error as { operationId: string }).operationId; }
    expect(operationId).toBeTruthy();
    await h.store.close();
    const store = await OriginStore.open({ stateDir: h.stateDir, agentId: 'echo' }, worker); stores.push(store);
    const restarted = new TelegramOriginService({ ...h.service.options, store, ownerBootId: 'boot-2' });
    await expect(send(restarted)).rejects.toMatchObject({ operationId, outcome: 'outcome-unknown' });
    expect(h.network).toHaveBeenCalledTimes(2);
    expect((await store.listOrigins()).records).toHaveLength(2);
  });
  it('releases a capacity-expired claim before dispatch without spending its retry budget or leaving a live closure', async () => {
    const h = await harness(); const cancel = vi.fn(); const send = vi.fn();
    const transport = Object.assign(h.network, { prepare: async () => ({ valid: () => false, cancel, send }) });
    await expect(h.service.runAsAutomation('telegram-server', () => h.service.sendBot(h.input, transport)))
      .rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(cancel).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled(); expect(h.network).not.toHaveBeenCalled();
    const row = (await h.store.listOrigins()).records[0];
    expect(row.children[0].state).toBe('queued'); expect(row.attempts[0]).toMatchObject({ phase: 'claimed', outcome: 'known-failed' });
    const child = row.children[0];
    const next = await h.store.claim({ childId: child.childId, materializationId: row.attempts[0].materializationId,
      ownerBootId: 'boot-1', leaseMs: 60_000 });
    expect(next.status).toBe('claimed'); if (next.status === 'claimed') expect(next.child.attemptNumber).toBe(1);
  });
  it('retains the charged attempt when capacity expires after durable dispatch intent, with known non-egress evidence', async () => {
    const h = await harness();
    const transport = Object.assign(h.network, { prepare: async () => ({ valid: () => true, cancel: vi.fn(),
      send: async () => { throw new OriginCapacityUnavailable(); } }) });
    await expect(h.service.runAsAutomation('telegram-server', () => h.service.sendBot(h.input, transport)))
      .rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    const row = (await h.store.listOrigins()).records[0];
    expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'known-failed', reason: 'credential-capacity-unavailable' });
    expect(row.children[0].state).toBe('queued'); expect(h.network).not.toHaveBeenCalled();
    expect(await h.store.releaseUndispatchedClaim(row.attempts[0] as never)).toBe(false);
  });
  it('rotates memory-only held candidates and releases expired live capacity with separate bounded history', async () => {
    const h = await harness(); let now = Date.now();
    const service = new TelegramOriginService({ ...h.service.options, now: () => now,
      limits: { maxActiveOperations: 12, deadlineMs: 1000 } });
    vi.spyOn(h.store, 'putEvidence').mockRejectedValue(new Error('recording unavailable'));
    for (let index = 0; index < 12; index++) await expect(service.runAsAutomation('telegram-server', () =>
      service.sendBot({ ...h.input, params: { ...h.input.params, text: `Held ${index}` } }, h.network)))
      .rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable' });
    const first = service.heldOperations().map(operation => operation.record.operationId);
    const second = service.heldOperations().map(operation => operation.record.operationId);
    expect(new Set([...first, ...second]).size).toBe(12);
    now += 1001;
    expect(service.heldOperations()).toEqual([]); expect(service.heldStatus()).toEqual([]);
    expect(service.expiredHeldStatus()).toMatchObject({ totalSinceBoot: 12, retained: expect.any(Array) });
    await expect(service.runAsAutomation('telegram-server', () => service.sendBot(h.input, h.network)))
      .rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable' });
    expect(service.heldStatus()).toHaveLength(1); expect(h.network).not.toHaveBeenCalled();
  });
  it('delegates a lifeline diagnosis without consuming the server supervisor reservation', async () => {
    const h = await harness();
    const diagnose = vi.fn(async () => 'Read-only supervisor diagnosis.');
    const supervisor = new TelegramOriginService({ ...h.service.options, diagnoseUnknown: diagnose });
    h.service.options.diagnosticMode = 'delegate';
    h.service.options.diagnoseUnknown = async (originId, reason) => { supervisor.requestDiagnosis(originId, reason); };
    h.network.mockRejectedValue(new Error('lost response'));
    await expect(h.send()).rejects.toMatchObject({ outcome: 'outcome-unknown' });
    const row = (await h.store.listOrigins()).records[0];
    await vi.waitFor(async () => expect((await h.store.getOrigin(row.record.originId))?.diagnostic)
      .toMatchObject({ state: 'complete', diagnosis: 'Read-only supervisor diagnosis.' }));
    expect(diagnose).toHaveBeenCalledOnce();
    expect(await h.store.undiagnosedOrigins()).toEqual([]);
  });
  it.each([false, true])('renders nested album captions while preserving entities and avoiding companions when hidden=%s', async hidden => {
    const h = await harness(hidden);
    const media = [{ type: 'photo', media: 'file-one', caption: '<b>First</b>', parse_mode: 'HTML' },
      { type: 'photo', media: 'file-two', caption: 'Second', caption_entities: [{ type: 'bold', offset: 0, length: 6 }] }];
    const operation = h.service.runAsAutomation('telegram-server', () => h.service.prepareBot({ method: 'sendMediaGroup',
      accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, media: JSON.stringify(media) } }));
    expect(operation.admission.children).toHaveLength(1);
    const rendered = JSON.parse(JSON.parse(JSON.parse(operation.admission.children[0].materializations[0].requestJson).body).media);
    expect(rendered[0].caption).toBe(hidden ? '<b>First</b>' : '<b>First</b>\n\nEcho · Mac Studio · automation');
    expect(rendered[1].caption_entities).toEqual(media[1].caption_entities);
    expect(rendered[1].caption).toBe(hidden ? 'Second' : 'Second\n\nEcho · Mac Studio · automation');
    expect(media[0].caption).toBe('<b>First</b>');
  });
  it('persists one read-only diagnosis across worker restart and finds an uncertain message by conversation', async () => {
    const h = await harness();
    const diagnose = vi.fn(async () => 'The response was lost; acceptance needs a concrete platform receipt.');
    h.service.options.diagnoseUnknown = diagnose;
    h.network.mockRejectedValue(new Error('connection reset after upload'));
    await expect(h.send()).rejects.toMatchObject({ outcome: 'outcome-unknown' });
    const row = (await h.store.listOrigins({ accountId: 'bot-1', chatId: '-100123', topicId: '42' })).records[0];
    expect(row.attempts[0]).toMatchObject({ reason: 'transport-acceptance-unknown' });
    await vi.waitFor(async () => expect((await h.store.getOrigin(row.record.originId))?.diagnostic)
      .toMatchObject({ state: 'complete', diagnosis: await diagnose.mock.results[0].value }));
    await h.store.close();
    const reopened = await OriginStore.open({ stateDir: h.stateDir, agentId: 'echo' }, worker); stores.push(reopened);
    const restarted = new TelegramOriginService({ ...h.service.options, store: reopened });
    restarted.requestDiagnosis(row.record.originId, 'transport-acceptance-unknown');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(diagnose).toHaveBeenCalledOnce();
    expect((await reopened.getOrigin(row.record.originId))?.diagnostic?.state).toBe('complete');
    expect(await reopened.recoverableAdmissions()).toEqual([]);
  });
  it('schedules only a definite Bot rate-limit refusal using the unchanged outbox budget', async () => {
    const h = await harness();
    h.network.mockResolvedValue(new Response(JSON.stringify({ ok: false, parameters: { retry_after: 61 } }), { status: 429 }));
    const start = Date.now();
    await expect(h.send()).rejects.toMatchObject({ outcome: 'known-failed', reason: 'telegram-429' });
    const row = (await h.store.listOrigins()).records[0];
    expect(row.operation?.state).toBe('admitted');
    expect(row.children[0]).toMatchObject({ attempts: 1, state: 'queued' });
    expect(row.attempts[0].nextAttemptAt).toBeGreaterThanOrEqual(start + 61_000);
    expect(await h.store.recoverableAdmissions()).toEqual([]);
    const recoverable = await h.store.recoverableAdmissions({ now: row.attempts[0].nextAttemptAt! + 1 });
    expect(recoverable[0]).toMatchObject({ operationId: row.operation!.operationId, preparedAt: row.operation!.preparedAt,
      deadlineAt: row.operation!.deadlineAt, maxAttempts: 9 });
    expect(h.network).toHaveBeenCalledOnce();
  });
  it('imports legacy rows in place with unknown authorship, unchanged budgets and fenced stale snapshots', async () => {
    const h = await harness();
    const queue = PendingRelayStore.open('echo', h.stateDir);
    try {
      const preparedAt = Date.now() - 60_000;
      queue.enqueue({ delivery_id: 'legacy-safe', topic_id: 42, text_hash: 'old-hash', text: 'Legacy answer',
        attempted_at: new Date(preparedAt).toISOString(), http_code: 401 });
      queue.enqueue({ delivery_id: 'legacy-unknown', topic_id: 42, text_hash: 'other-hash', text: 'Possibly sent', http_code: 0 });
      const snapshots = await h.store.legacyCandidates();
      const safe = snapshots.find(row => row.deliveryId === 'legacy-safe')!;
      const operation = h.service.prepareImportedLegacy(safe, 'bot-1', '-100123');
      expect(operation.record).toMatchObject({ producerKind: 'imported-legacy', originMachineId: 'legacy-unattributed',
        importedByMachineId: 'studio', machine: { status: 'unknown', value: null }, model: { status: 'unknown', value: null } });
      expect(await h.store.importLegacy({ snapshot: safe, admission: operation.admission })).toBe(true);
      expect(await h.store.importLegacy({ snapshot: safe, admission: operation.admission })).toBe(false);
      expect(queue.findByDeliveryId('legacy-safe')).toMatchObject({ entry_kind: 'telegram-origin', attempts: 1,
        attempted_at: new Date(preparedAt).toISOString() });
      expect((await h.store.getOrigin(operation.record.originId))?.operation?.deadlineAt).toBe(preparedAt + 6 * 60 * 60_000);
      h.service.options.reviewLegacyRecovery = async () => false;
      await expect(h.service.executePreparedBot(operation, h.network)).rejects.toMatchObject({ reason: 'legacy-review-rejected' });
      expect(h.network).not.toHaveBeenCalled();
      h.service.options.reviewLegacyRecovery = async () => true;
      await h.service.executePreparedBot(operation, h.network);
      expect(queue.findByDeliveryId('legacy-safe')?.attempts).toBe(2);
      const uncertain = snapshots.find(row => row.deliveryId === 'legacy-unknown')!;
      const held = h.service.prepareImportedLegacy(uncertain, 'bot-1', '-100123');
      queue.transition('legacy-unknown', 'queued', { attempts: 2 });
      expect(await h.store.importLegacy({ snapshot: uncertain, admission: held.admission })).toBe(false);
      const fresh = (await h.store.legacyCandidates())[0];
      const updated = h.service.prepareImportedLegacy(fresh, 'bot-1', '-100123');
      expect(await h.store.importLegacy({ snapshot: fresh, admission: updated.admission })).toBe(true);
      expect((await h.store.getOrigin(updated.record.originId))?.operation?.state).toBe('outcome-unknown');
      await expect(h.service.executePreparedBot(updated, h.network)).rejects.toMatchObject({ reason: 'outbox-not-ready' });
      expect(h.network).toHaveBeenCalledOnce();
      expect(await h.store.recoverableAdmissions()).toEqual([]);
      expect(queue.selectClaimable(new Date().toISOString())).toEqual([]);
    } finally { queue.close(); }
  });
  it('imports a claimed legacy row as uncertain and fences the old worker without granting a new attempt', async () => {
    const h = await harness(), queue = PendingRelayStore.open('echo', h.stateDir);
    try {
      queue.enqueue({ delivery_id: 'old-claimed', topic_id: 42, text_hash: 'fixture', text: 'Earlier answer', http_code: 401 });
      const row = queue.findByDeliveryId('old-claimed')!;
      expect(queue.claimCas('old-claimed', 'old-worker', { state: row.state, claimed_by: row.claimed_by })).toBe(true);
      const snapshot = (await h.store.legacyCandidates())[0];
      expect(snapshot).toMatchObject({ state: 'claimed', replaySafe: false });
      const operation = h.service.prepareImportedLegacy(snapshot, 'bot-1', '-100123');
      expect(await h.store.importLegacy({ snapshot, admission: operation.admission })).toBe(true);
      expect(queue.transitionClaimed('old-claimed', 'old-worker', 'queued')).toBe(false);
      expect((await h.store.getOrigin(operation.record.originId))?.operation?.state).toBe('outcome-unknown');
      expect(await h.store.recoverableAdmissions()).toEqual([]);
      await expect(h.service.executePreparedBot(operation, h.network)).rejects.toMatchObject({ reason: 'outbox-not-ready' });
      expect(h.network).not.toHaveBeenCalled();
    } finally { queue.close(); }
  });
  it('retains the confirmed subset of skipped forwards while holding the remainder without replay', async () => {
    const h = await harness();
    h.network.mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: [{ message_id: 80 }] })));
    const operation = h.service.runAsAutomation('telegram-server', () => h.service.prepareBot({ method: 'forwardMessages',
      accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, from_chat_id: '-100456', message_ids: [10, 11] } }));
    await h.service.admit(operation);
    await expect(h.service.executePreparedBot(operation, h.network)).rejects.toMatchObject({ reason: 'partial-platform-receipt', outcome: 'outcome-unknown' });
    const audit = await h.store.getOrigin(operation.record.originId);
    expect(JSON.parse(audit!.attempts[0].receiptJson!)).toMatchObject({ partial: true, expectedCount: 2,
      messages: [{ messageId: '80', chatId: '-100123', topicId: '42' }] });
    expect((await h.store.listOrigins({ accountId: 'bot-1', chatId: '-100123', topicId: '42', messageId: '80' })).records[0].record.originId).toBe(operation.record.originId);
    expect(await h.store.recoverableAdmissions()).toHaveLength(0);
    await expect(h.service.executePreparedBot(operation, h.network)).rejects.toMatchObject({ reason: 'outbox-not-ready' });
    expect(h.network).toHaveBeenCalledOnce();
  });
  it.each([false, true])('records captionless media with only the required companion when hidden=%s', async hidden => {
    const h = await harness(hidden);
    const input = { method: 'sendDocument', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, document: 'file-id' } };
    h.network.mockImplementation(async request => new Response(JSON.stringify({ ok: true, result: {
      message_id: request.method === 'sendDocument' ? 70 : 71, chat: { id: -100123 }, message_thread_id: 42 } })));
    const result = await h.service.runAsAutomation('telegram-server', () => h.service.sendBot(input, h.network));
    expect((await result.json() as any).result.message_id).toBe(70);
    expect(h.network).toHaveBeenCalledTimes(hidden ? 1 : 2);
    if (!hidden) expect(JSON.parse(h.network.mock.calls[1][0].body)).toMatchObject({
      text: 'Echo · Mac Studio · automation', reply_parameters: { message_id: 70 } });
    const audit = await h.store.getOrigin(result.headers.get('X-Instar-Origin-Id')!);
    expect(audit?.operation?.state).toBe('accepted');
    expect(audit?.children).toHaveLength(hidden ? 1 : 2);
    if (!hidden) expect(JSON.parse(audit!.record.envelopeJson).childLinks[1].companionOf).toBe(audit!.children[0].childId);
  });
  it('resumes a held companion after its parent receipt without sending the document again', async () => {
    const h = await harness();
    const operation = h.service.runAsAutomation('telegram-server', () => h.service.prepareBot({
      method: 'sendDocument', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, document: 'file-id' } }));
    await h.service.admit(operation);
    h.authorize.mockImplementation(async request => request.method === 'sendDocument');
    await expect(h.service.executePreparedBot(operation, h.network)).rejects.toMatchObject({ reason: 'destination-not-authorized' });
    expect(h.network).toHaveBeenCalledOnce();
    expect(await h.store.recoverableAdmissions()).toHaveLength(1);
    h.authorize.mockResolvedValue(true);
    await h.service.executePreparedBot(operation, h.network);
    expect(h.network.mock.calls.map(([r]) => r.method)).toEqual(['sendDocument', 'sendMessage']);
  });
  it('retains every media-group platform identity and uses one companion for the group', async () => {
    const h = await harness();
    const input = { method: 'sendMediaGroup', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42,
      media: [{ type: 'photo', media: 'photo-1' }, { type: 'photo', media: 'photo-2' }] } };
    const row = (message_id: number) => ({ message_id, chat: { id: -100123 }, message_thread_id: 42 });
    h.network.mockImplementation(async req => new Response(JSON.stringify({ ok: true,
      result: req.method === 'sendMediaGroup' ? [row(80), row(81)] : row(82) })));
    const result = await h.service.runAsAutomation('telegram-server', () => h.service.sendBot(input, h.network));
    expect((await result.json() as any).result).toHaveLength(2);
    expect(h.network).toHaveBeenCalledTimes(2);
    expect((await h.store.listOrigins({ accountId: 'bot-1', messageId: '81' })).records).toHaveLength(1);
    expect(JSON.parse(h.network.mock.calls[1][0].body).reply_parameters.message_id).toBe(80);
  });
  it('does not mistake a forwarded source message ID for the destination receipt', async () => {
    const h = await harness();
    const input = { method: 'forwardMessage', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42,
      from_chat_id: '-100999', message_id: 999 } };
    const result = await h.service.runAsAutomation('telegram-server', () => h.service.sendBot(input, h.network));
    const audit = await h.store.getOrigin(result.headers.get('X-Instar-Origin-Id')!);
    expect(JSON.parse(audit!.record.envelopeJson)).toMatchObject({ forwardedFrom: { chatId: '-100999', messageIds: ['999'] },
      destination: { messageId: null }, producerId: 'telegram-server' });
    expect(h.network).toHaveBeenCalledTimes(2);
  });
  it('indexes a message namespace and appends editor evidence without rewriting its original author', async () => {
    const h = await harness();
    const sent = await h.send();
    const originalId = sent.headers.get('X-Instar-Origin-Id')!;
    const original = await h.store.getOrigin(originalId);
    h.service.registerAutomationProducer('editor');
    const edited = await h.service.runAsAutomation('editor', () => h.service.sendBot({ ...h.input,
      method: 'editMessageText', params: { ...h.input.params, text: 'Edited answer', message_id: 7 } }, h.network));
    const revision = await h.store.getOrigin(edited.headers.get('X-Instar-Origin-Id')!);
    expect(JSON.parse(revision!.record.envelopeJson)).toMatchObject({ revisionOf: originalId, producerId: 'editor' });
    expect(await h.store.getOrigin(originalId)).toEqual(original);
    const history = await h.store.listOrigins({ transport: 'bot-api', accountId: 'bot-1', chatId: '-100123', topicId: '42', messageId: '7' });
    expect(history.records).toHaveLength(2);
    expect((await h.store.listOrigins({ accountId: 'another-bot', messageId: '7' })).records).toEqual([]);
  });
  it.each([false, true])('records before dispatch and keeps audit when display hidden=%s', async hidden => {
    const h = await harness(hidden);
    h.network.mockImplementationOnce(async request => {
      const page = await h.store.listOrigins();
      expect(page.records).toHaveLength(1);
      const audit = await h.store.getOrigin(page.records[0].record.originId);
      expect(audit?.attempts[0].phase).toBe('dispatched');
      expect(JSON.parse(request.body).text).toBe(hidden ? 'Original answer' : 'Original answer\n\nEcho · Mac Studio · automation');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: -100123 }, message_thread_id: 42 } }));
    });
    const response = await h.send();
    const audit = await h.store.getOrigin(response.headers.get('X-Instar-Origin-Id')!);
    expect(audit?.children[0].state).toBe('accepted');
    expect(JSON.parse(audit!.record.envelopeJson)).toMatchObject({ originMachineName: 'Mac Studio',
      producerKind: 'server-automation', model: { status: 'not-applicable' }, display: { enabled: !hidden } });
    expect(h.onHold).not.toHaveBeenCalled();
  });
  it('holds and requests notification when all durable sinks fail', async () => {
    const h = await harness();
    vi.spyOn(h.store, 'putEvidence').mockRejectedValue(new Error('database unavailable'));
    await expect(h.send()).rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable', outcome: 'held' });
    expect(h.spoolEvidence).toHaveBeenCalledOnce(); expect(h.network).not.toHaveBeenCalled();
    expect(h.onHold).toHaveBeenCalledOnce();
  });
  it('a successful evidence fallback never grants an execution claim', async () => {
    const h = await harness();
    vi.spyOn(h.store, 'putEvidence').mockRejectedValue(new Error('database unavailable'));
    h.spoolEvidence.mockResolvedValueOnce(undefined as never);
    vi.spyOn(h.store, 'admit').mockRejectedValue(new Error('outbox unavailable'));
    await expect(h.send()).rejects.toMatchObject({ reason: 'execution-admission-unavailable' });
    expect(h.network).not.toHaveBeenCalled(); expect(h.onHold).toHaveBeenCalledOnce();
  });
  it.each(['wrong-chat', 'wrong-topic', 'zero-id', 'no-receipt', 'timeout'])('preserves uncertain %s without retry', async failure => {
    const h = await harness();
    h.network.mockImplementationOnce(async () => {
      if (failure === 'timeout') throw new Error('timeout after request');
      return new Response(JSON.stringify({ ok: true, result: failure === 'no-receipt' ? true : {
        message_id: failure === 'zero-id' ? 0 : 7,
        chat: { id: failure === 'wrong-chat' ? -999 : -100123 }, message_thread_id: failure === 'wrong-topic' ? 43 : 42,
      } }));
    });
    await expect(h.send()).rejects.toMatchObject({ outcome: 'outcome-unknown' });
    expect(h.network).toHaveBeenCalledOnce();
    const page = await h.store.listOrigins();
    const audit = await h.store.getOrigin(page.records[0].record.originId);
    expect(audit?.children[0].state).toBe('outcome-unknown');
  });
  it('receipt persistence failure remains outcome-unknown after successful network acceptance', async () => {
    const h = await harness();
    vi.spyOn(h.store, 'recordOutcome').mockRejectedValue(new Error('disk failed'));
    await expect(h.send()).rejects.toMatchObject({ outcome: 'outcome-unknown', reason: 'receipt-persistence-unavailable' });
    expect(h.network).toHaveBeenCalledOnce();
  });
  it('refuses changed caller materialization against the actual outbox claim', async () => {
    const h = await harness();
    const operation = h.service.runAsAutomation('telegram-server', () => h.service.prepareBot(h.input));
    await h.service.admit(operation);
    operation.admission.children[0].materializations[0].requestJson += ' ';
    await expect(h.service.executePreparedBot(operation, h.network)).rejects.toMatchObject({ reason: 'sealed-request-mismatch' });
    expect(h.network).not.toHaveBeenCalled();
  });
  it('rechecks destination permission after claiming and freezes authorized bytes', async () => {
    const h = await harness();
    h.authorize.mockImplementationOnce(async request => {
      expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.destination)).toBe(true); return true;
    }).mockResolvedValueOnce(false);
    await expect(h.send()).rejects.toMatchObject({ reason: 'destination-not-authorized' });
    expect(h.network).not.toHaveBeenCalled();
  });
  it('does not prepare a session revoked while its runtime observation refreshes', async () => {
    const h = await harness();
    const token = await h.service.options.sessions.issue({ sessionId: 'session', harnessId: 'codex-cli', projectDir: process.cwd() });
    vi.spyOn(h.service.options.observer, 'refresh').mockImplementation(async () => { await h.service.options.sessions.revoke('session'); });
    await expect(h.service.runWithSessionToken(token, h.send)).rejects.toMatchObject({ reason: 'session-no-longer-authorized' });
    expect(h.network).not.toHaveBeenCalled();
  });
});
