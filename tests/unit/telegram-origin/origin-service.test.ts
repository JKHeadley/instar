import { withNotificationEnvelope } from '../../../src/messaging/notificationStampers.js';
import { NotificationSelectivityGate, QuietRecordedError, isVerifiedJobEnvelope, verifiedInboundMirrorEnvelope, verifiedJobEnvelope, verifiedReplyEnvelope } from '../../../src/messaging/NotificationSelectivityGate.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import { TelegramOriginService } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import type { OriginServiceStore } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
import { PendingRelayStore } from '../../../src/messaging/pending-relay-store.js';
import { OriginCapacityUnavailable } from '../../../src/messaging/telegram-origin/OriginEgressCapacity.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';
import { isBootBeaconBody } from '../../../src/messaging/telegram-origin/OriginLegacy.js';

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
  it('preserves waiting state across a signed human media mirror and completes it for the actual answer', async () => {
    const h = await harness();
    const gate = new NotificationSelectivityGate(h.stateDir, 'studio', () => ({ enabled: true, dryRun: false }));
    h.service.notificationGate = gate; gate.observeInbound(42, 'human-input');
    const presence = { origin: 'automated' as const, category: 'presence-standby' as const, sourceContext: 'presence', inboundMessageId: 'human-input' };
    try {
      await withNotificationEnvelope(verifiedInboundMirrorEnvelope('test-admitted-human'), () => h.service.runAsAutomation('telegram-server',
        () => h.service.sendBot({ method: 'sendPhoto', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, photo: 'file-id', caption: 'Human photo' } }, h.network)));
      expect(h.network).toHaveBeenCalledOnce();
      const rows = (await h.store.listOrigins()).records;
      const record = JSON.parse(rows[0].record.envelopeJson);
      expect(record.notification).toMatchObject({ origin: 'verified-reply', inboundMirror: true });
      h.service.completeNotification(record);
      expect(gate.decide(42, presence).decision).toBe('deliver');
      await withNotificationEnvelope(verifiedReplyEnvelope('test-real-answer'), () => h.service.runAsAutomation('telegram-server',
        () => h.service.sendBot({ ...h.input, params: { ...h.input.params, text: 'The actual answer resolves the waiting turn.' } }, h.network)));
      expect(gate.decide(42, presence).decision).toBe('record');
    } finally { await gate.close(); }
  });
  describe('per-job opt-in provenance', () => {
    async function jobHarness(push: { jobs: Record<string, boolean>; jobTopics?: Record<string, number> }, sessionSlug?: string) {
      const h = await harness(); const gate = new NotificationSelectivityGate(h.stateDir, 'studio', () => ({ enabled: true, dryRun: false, push }));
      gate.pushDestination = () => ({ chatId: String(h.input.params.chat_id), topicId: 7000 });
      h.service.notificationGate = gate;
      h.service.notificationJobSession = id => id === 'job-session' && !!sessionSlug;
      h.service.notificationJobSlug = id => id === 'job-session' ? sessionSlug : undefined;
      const token = await h.service.options.sessions.issue({ sessionId: 'job-session', harnessId: 'codex-cli', projectDir: h.stateDir });
      h.service.options.observer.track(h.service.options.sessions.getBinding('job-session')!);
      return { h, gate, token };
    }
    const sealed = async (h: Awaited<ReturnType<typeof harness>>) => JSON.parse((await h.store.listOrigins()).records[0].record.envelopeJson);
    const claim = (slug: string) => ({ origin: 'automated' as const, category: 'job-status' as const, sourceContext: slug });
    it('delivers an opted-in job session through the sealed record, in the topic the operator chose', async () => {
      const topic = Number(((await harness()).input.params as { message_thread_id?: number }).message_thread_id ?? 1);
      const { h, gate, token } = await jobHarness({ jobs: { 'instar2-checkin': true }, jobTopics: { 'instar2-checkin': topic } }, 'instar2-checkin');
      try {
        await h.service.runWithSessionToken(token, () => withNotificationEnvelope(claim('instar2-checkin'), () => h.service.sendBot(h.input, h.network)));
        expect(h.network).toHaveBeenCalledOnce();
        const record = await sealed(h);
        expect(record.notification).toMatchObject({ category: 'job-status', sourceContext: 'instar2-checkin', verifiedJobSlug: 'instar2-checkin' });
        expect(record.destination.topicId).toBe(String(topic));
      } finally { await gate.close(); }
    });
    it('an opted-in job addressing any other topic is sent to the hub', async () => {
      const { h, gate, token } = await jobHarness({ jobs: { 'instar2-checkin': true }, jobTopics: { 'instar2-checkin': 999 } }, 'instar2-checkin');
      try {
        // The fixture's canned receipt names the original topic, so a retargeted send is held after dispatch.
        await h.service.runWithSessionToken(token, () => withNotificationEnvelope(claim('instar2-checkin'), () => h.service.sendBot(h.input, h.network))).catch(() => undefined);
        expect(h.network).toHaveBeenCalledOnce();
        expect((await sealed(h)).destination.topicId).toBe('7000');
      } finally { await gate.close(); }
    });
    it('a job session claiming another job is named by its own session and stays quiet', async () => {
      const { h, gate, token } = await jobHarness({ jobs: { 'instar2-checkin': true } }, 'bugs-overseer');
      try {
        await expect(h.service.runWithSessionToken(token, () => withNotificationEnvelope(claim('instar2-checkin'), () => h.service.sendBot(h.input, h.network)))).rejects.toBeInstanceOf(QuietRecordedError);
        expect(h.network).not.toHaveBeenCalled();
        expect((await sealed(h)).notification).toMatchObject({ sourceContext: 'bugs-overseer', verifiedJobSlug: 'bugs-overseer' });
      } finally { await gate.close(); }
    });
    it('a claimed sealed field from a session with no scheduler job is stripped and stays quiet', async () => {
      const { h, gate, token } = await jobHarness({ jobs: { 'instar2-checkin': true } });
      try {
        await expect(h.service.runWithSessionToken(token, () => withNotificationEnvelope({ ...claim('instar2-checkin'), verifiedJobSlug: 'instar2-checkin' }, () => h.service.sendBot(h.input, h.network)))).rejects.toBeInstanceOf(QuietRecordedError);
        expect(h.network).not.toHaveBeenCalled();
        expect((await sealed(h)).notification).not.toHaveProperty('verifiedJobSlug');
      } finally { await gate.close(); }
    });
    it('a scheduler notice keeps its identity through the seal with no session', async () => {
      const topic = Number(((await harness()).input.params as { message_thread_id?: number }).message_thread_id ?? 1);
      const { h, gate } = await jobHarness({ jobs: { 'nightly': true }, jobTopics: { 'nightly': topic } });
      try {
        await withNotificationEnvelope(verifiedJobEnvelope('nightly'), () => h.service.runAsAutomation('telegram-server', () => h.service.sendBot(h.input, h.network)));
        expect(h.network).toHaveBeenCalledOnce();
      } finally { await gate.close(); }
    });
    it('restores a peer record from its sealed field, and only a job-status envelope', async () => {
      const { h, gate } = await jobHarness({ jobs: {} });
      try {
        const peer = { sessionId: 'job-session', producerKind: 'session', originMachineId: 'other-machine' } as never;
        h.service.notificationJobSlug = () => 'same-id-local-job'; // a coincident local session id must not rename a peer's job
        const restored = h.service.restoreJobEnvelope(peer, { ...claim('a'), verifiedJobSlug: 'a', relayedOrigin: true, contextTopicId: 5 });
        expect(isVerifiedJobEnvelope(restored)).toBe(true);
        expect(restored?.sourceContext).toBe('a');
        expect(restored).toMatchObject({ relayedOrigin: true, contextTopicId: 5 });
        expect(isVerifiedJobEnvelope(h.service.restoreJobEnvelope(peer, claim('a')))).toBe(false);
        const other = { origin: 'automated' as const, category: 'spend-alert' as const, sourceContext: 'a', verifiedJobSlug: 'a' };
        expect(h.service.restoreJobEnvelope(peer, other)).toBe(other);
      } finally { await gate.close(); }
    });
  });
  it('preserves the existing release promotion only for a trusted upgrade session', async () => {
    const h = await harness(); const gate = new NotificationSelectivityGate(h.stateDir, 'studio', () => ({ enabled: true, dryRun: false }));
    h.service.notificationGate = gate; h.service.notificationJobSession = () => true;
    h.service.notificationPromotedUpgradeSession = id => id === 'approved-upgrade';
    const token = await h.service.options.sessions.issue({ sessionId: 'approved-upgrade', harnessId: 'codex-cli', projectDir: h.stateDir });
    h.service.options.observer.track(h.service.options.sessions.getBinding('approved-upgrade')!);
    try {
      await h.service.runWithSessionToken(token, () => h.service.sendBot(h.input, h.network));
      expect(h.network).toHaveBeenCalledOnce();
      const rows = (await h.store.listOrigins()).records;
      expect(JSON.parse(rows[0].record.envelopeJson).notification).toMatchObject({ category: 'update-announcement', releaseAudiencePromoted: true });
      expect(h.service.runAsAutomation('telegram-server', () => h.service.notificationForCurrentProducer())).not.toHaveProperty('releaseAudiencePromoted');
    } finally { await gate.close(); }
  });

  it.each([
    { enabled: true, dryRun: false, quiet: true },
    { enabled: true, dryRun: true, quiet: false },
    { enabled: false, dryRun: false, quiet: false },
  ])('characterizes PR 2819 delivery-notice gating: %j', async ({ enabled, dryRun, quiet }) => {
    const h = await harness();
    const gate = new NotificationSelectivityGate(h.stateDir, 'studio', () => ({ enabled, dryRun }));
    h.service.notificationGate = gate;
    h.service.registerAutomationProducer('reply-delivery-notice');
    const body = { text: 'A reply I wrote is delayed by a delivery interruption.' };
    const token = h.service.issueAutomationReply('reply-delivery-notice', 42, body, undefined, 'reply-delivery-notice:original:delayed');
    try {
      const send = h.service.runWithAutomationReply(token, 42, body, () => h.service.sendBot({ ...h.input,
        params: { ...h.input.params, text: body.text } }, h.network));
      if (quiet) {
        await expect(send).rejects.toBeInstanceOf(QuietRecordedError);
        expect(h.network).not.toHaveBeenCalled();
        expect(await h.store.recoverableAdmissions()).toEqual([]);
      } else {
        await send;
        expect(h.network).toHaveBeenCalledOnce();
      }
    } finally { await gate.close(); }
  });

  it('terminally records quiet automation and replays its receipt after worker restart', async () => {
    const h = await harness();
    const gate = new NotificationSelectivityGate(h.stateDir, 'studio', () => ({ enabled: true, dryRun: false }));
    h.service.notificationGate = gate;
    const prepared = vi.spyOn(h.service, 'prepareBot');
    const send = (service: TelegramOriginService) => {
      const token = service.issueAutomationReply('telegram-server', 42, { text: h.input.params.text }, undefined, 'quiet:one');
      return service.runWithAutomationReply(token, 42, { text: h.input.params.text }, () => service.sendBot(h.input, h.network));
    };
    let quietId: string | undefined;
    try { await send(h.service); throw new Error('Expected a quiet receipt'); }
    catch (error) { expect(error).toBeInstanceOf(QuietRecordedError); quietId = (error as QuietRecordedError).receipt.quietId; }
    expect(h.network).not.toHaveBeenCalled();
    const rows = (await h.store.listOrigins()).records;
    const row = await h.store.getOrigin(rows[0].record.originId);
    expect(row?.operation).toMatchObject({ state: 'suppressed', holdReason: 'quiet-notification-recorded', holdDetail: { quietId } });
    expect(await h.store.recoverableAdmissions()).toEqual([]);
    const route = vi.spyOn(gate, 'route').mockRejectedValueOnce(new Error('Must not reclassify terminal quiet receipt'));
    await expect(h.service.executePreparedBot(prepared.mock.results[0].value, h.network)).rejects.toBeInstanceOf(QuietRecordedError);
    expect(route).not.toHaveBeenCalled(); route.mockRestore();
    await h.store.close();
    const store = await OriginStore.open({ stateDir: h.stateDir, agentId: 'echo' }, worker); stores.push(store);
    const restarted = new TelegramOriginService({ ...h.service.options, store, ownerBootId: 'boot-2' });
    restarted.notificationGate = gate;
    await expect(send(restarted)).rejects.toMatchObject({ receipt: { recorded: true, quietId } });
    expect(h.network).not.toHaveBeenCalled();
    await gate.close();
  });

  it('replays an accepted logical automation send after worker restart without preparing new delivery custody', async () => {
    const h = await harness();
    const send = (service: TelegramOriginService, logicalId: string, input = h.input) => {
      const token = service.issueAutomationReply('telegram-server', 42, { text: input.params.text }, undefined, logicalId);
      return service.runWithAutomationReply(token, 42, { text: input.params.text }, () => service.sendBot(input, h.network));
    };
    expect((await send(h.service, 'beacon:0')).ok).toBe(true);
    const stableOperation=h.service.automationOperationId('telegram-server',42,'beacon:0');
    expect((await h.store.getOperation(stableOperation))?.operation?.operationId).toBe(stableOperation);
    await h.store.close();
    const store = await OriginStore.open({ stateDir: h.stateDir, agentId: 'echo' }, worker); stores.push(store);
    const restarted = new TelegramOriginService({ ...h.service.options, store, ownerBootId: 'boot-2' });
    expect(restarted.automationOperationId('telegram-server',42,'beacon:0')).toBe(stableOperation);
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
  it('keeps an unproven transport refusal charged and uncertain after durable dispatch intent', async () => {
    const h = await harness();
    const transport = Object.assign(h.network, { prepare: async () => ({ valid: () => true, cancel: vi.fn(),
      send: async () => { throw new OriginCapacityUnavailable(); } }) });
    await expect(h.service.runAsAutomation('telegram-server', () => h.service.sendBot(h.input, transport)))
      .rejects.toMatchObject({ reason: 'transport-acceptance-unknown' });
    const row = (await h.store.listOrigins()).records[0];
    expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'outcome-unknown', reason: 'transport-acceptance-unknown' });
    expect(row.children[0]).toMatchObject({ state: 'outcome-unknown', attempts: 1 }); expect(h.network).not.toHaveBeenCalled();
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
  it('a reply refused by the boot beacon (server still starting) is replayable; any other 503 stays uncertain', async () => {
    const h = await harness(), queue = PendingRelayStore.open('echo', h.stateDir);
    try {
      const beacon = '{"status":"warming","phase":"booting"}';
      queue.enqueue({ delivery_id: 'boot-refused', topic_id: 42, text_hash: 'h1', text: 'Sent while starting', http_code: 503, error_body: beacon });
      queue.enqueue({ delivery_id: 'real-503', topic_id: 42, text_hash: 'h2', text: 'Handler failed', http_code: 503, error_body: '{"error":"origin-unavailable"}' });
      queue.enqueue({ delivery_id: 'beacon-lookalike', topic_id: 42, text_hash: 'h3', text: 'Extra field', http_code: 503,
        error_body: '{"status":"warming","phase":"booting","sent":true}' });
      queue.enqueue({ delivery_id: 'beacon-body-wrong-code', topic_id: 42, text_hash: 'h4', text: 'Odd code', http_code: 502, error_body: beacon });
      const byId = new Map((await h.store.legacyCandidates()).map(row => [row.deliveryId, row]));
      expect(byId.get('boot-refused')?.replaySafe).toBe(true);
      expect(byId.get('real-503')?.replaySafe).toBe(false);
      expect(byId.get('beacon-lookalike')?.replaySafe).toBe(false);
      expect(byId.get('beacon-body-wrong-code')?.replaySafe).toBe(false);
      const safe = byId.get('boot-refused')!;
      const operation = h.service.prepareImportedLegacy(safe, 'bot-1', '-100123');
      expect(await h.store.importLegacy({ snapshot: safe, admission: operation.admission })).toBe(true);
      expect((await h.store.getOrigin(operation.record.originId))?.operation?.state).not.toBe('outcome-unknown');
      h.service.options.reviewLegacyRecovery = async () => true;
      await h.service.executePreparedBot(operation, h.network);
      expect(h.network).toHaveBeenCalledOnce();
    } finally { queue.close(); }
  });
  it('replays a row refused while being prepared (config unreadable / issues routing) exactly once', async () => {
    const h = await harness();
    const queue = PendingRelayStore.open('echo', h.stateDir);
    try {
      const at = new Date(Date.now() - 60_000).toISOString();
      // The exact bodies the reply route returns for these pre-dispatch refusals.
      queue.enqueue({ delivery_id: 'refused-unknown', topic_id: 42, text_hash: 'h1', text: 'Backlog note', attempted_at: at, http_code: 503,
        error_body: JSON.stringify({ error: 'origin-config-unavailable', reason: 'origin-config-reader-timeout', retryable: true,
          message: 'This machine could not read its current messaging config, so nothing was sent. It will be retried.' }) });
      queue.enqueue({ delivery_id: 'refused-issues', topic_id: 42, text_hash: 'h2', text: 'Issues note', attempted_at: at, http_code: 500,
        error_body: JSON.stringify({ error: 'issues-chat-not-configured: topic 10000000001 belongs to the issues group, but this process has no messaging config issuesChatId. Refusing to send it to the main group.' }) });
      queue.enqueue({ delivery_id: 'refused-issues-named', topic_id: 42, text_hash: 'h7', text: 'Named issues note', attempted_at: at, http_code: 500,
        error_body: JSON.stringify({ error: 'issues-chat-not-configured: topic 10000000001 "Issues" belongs to the issues group, but this process has no messaging config issuesChatId. Refusing to send it to the main group.' }) });
      queue.enqueue({ delivery_id: 'refused-issues-unresolved', topic_id: 42, text_hash: 'h8', text: 'Unresolved issues note', attempted_at: at, http_code: 500,
        error_body: JSON.stringify({ error: 'issues-chat-not-configured: topic 10000000001 (name unresolved) belongs to the issues group, but this process has no messaging config issuesChatId. Refusing to send it to the main group.' }) });
      queue.enqueue({ delivery_id: 'refused-display', topic_id: 42, text_hash: 'h5', text: 'Display note', attempted_at: at, http_code: 500,
        error_body: JSON.stringify({ error: 'origin-display-authority-unavailable' }) });
      queue.enqueue({ delivery_id: 'display-503', topic_id: 42, text_hash: 'h6', text: 'Wrong code', attempted_at: at, http_code: 503,
        error_body: JSON.stringify({ error: 'origin-display-authority-unavailable' }) });
      // Lookalikes stay uncertain: a generic 500, a relayed body, an extra key.
      queue.enqueue({ delivery_id: 'generic-500', topic_id: 42, text_hash: 'h3', text: 'Maybe sent', attempted_at: at, http_code: 500,
        error_body: JSON.stringify({ error: 'telegram send failed' }) });
      queue.enqueue({ delivery_id: 'relayed-503', topic_id: 42, text_hash: 'h4', text: 'Relayed', attempted_at: at, http_code: 503,
        error_body: JSON.stringify({ error: 'origin-config-unavailable', reason: 'x', retryable: true, message: 'm', relayedFromHolder: true }) });
      const snapshots = await h.store.legacyCandidates();
      const safe = Object.fromEntries(snapshots.map(row => [row.deliveryId, row.replaySafe]));
      expect(safe).toEqual({ 'refused-unknown': true, 'refused-issues': true, 'refused-issues-named': true, 'refused-issues-unresolved': true, 'refused-display': true, 'display-503': false,
        'generic-500': false, 'relayed-503': false });
      const row = snapshots.find(item => item.deliveryId === 'refused-unknown')!;
      const operation = h.service.prepareImportedLegacy(row, 'bot-1', '-100123');
      expect(await h.store.importLegacy({ snapshot: row, admission: operation.admission })).toBe(true);
      expect((await h.store.getOrigin(operation.record.originId))?.operation?.state).not.toBe('outcome-unknown');
      expect(queue.findByDeliveryId('refused-unknown')?.state).not.toBe('delivered-ambiguous');
      await h.service.executePreparedBot(operation, h.network);
      expect(h.network).toHaveBeenCalledOnce();
    } finally { queue.close(); }
  });
  it('a reply queued during boot recovers with its real session label, even after the restart re-issued the credential', async () => {
    const h = await harness(), queue = PendingRelayStore.open('echo', h.stateDir);
    try {
      const launch = { sessionId: 'instar-app', harnessId: 'claude-code' as const, projectDir: h.stateDir, configuredModel: 'claude-opus-5-5' };
      const before = await h.service.options.sessions.issue(launch);
      // The server restart re-enrolls the surviving session with a NEW credential.
      await h.service.options.sessions.issue(launch);
      h.service.options.observer.track(h.service.options.sessions.getBinding('instar-app')!);
      const digest = createHash('sha256').update(before).digest('hex');
      const beacon = '{"status":"warming","phase":"booting"}';
      queue.enqueue({ delivery_id: 'boot-session', topic_id: 42, text_hash: 'h1', text: 'Sent while starting', http_code: 503,
        error_body: beacon, origin_session_digest: digest });
      queue.enqueue({ delivery_id: 'boot-no-session', topic_id: 42, text_hash: 'h2', text: 'Old script row', http_code: 503, error_body: beacon });
      queue.enqueue({ delivery_id: 'boot-foreign', topic_id: 42, text_hash: 'h3', text: 'Unknown credential', http_code: 503,
        error_body: beacon, origin_session_digest: 'f'.repeat(64) });
      const byId = new Map((await h.store.legacyCandidates()).map(row => [row.deliveryId, row]));
      expect(byId.get('boot-session')?.originSessionDigest).toBe(digest);

      const attributed = await h.service.attributeLegacy(byId.get('boot-session')!);
      const operation = h.service.prepareImportedLegacy(byId.get('boot-session')!, 'bot-1', '-100123', attributed);
      expect(operation.record).toMatchObject({ producerKind: 'imported-legacy', originMachineId: 'legacy-unattributed', sessionId: 'instar-app',
        originMachineName: 'Mac Studio', machine: { status: 'observed', value: 'Mac Studio' },
        harness: { status: 'observed', value: 'claude-code' }, model: { status: 'configured', value: 'claude-opus-5-5' } });
      expect(operation.admission.children[0].materializations[0].requestJson).toContain('Echo · Mac Studio · Claude Code · claude-opus-5-5 (configured)');
      expect(await h.store.importLegacy({ snapshot: byId.get('boot-session')!, admission: operation.admission })).toBe(true);
      await h.service.executePreparedBot(operation, h.network);
      expect(h.network).toHaveBeenCalledOnce();

      // No digest (older script) and an unmatched digest: the machine is still known.
      for (const id of ['boot-no-session', 'boot-foreign']) {
        const snapshot = byId.get(id)!;
        const machineOnly = h.service.prepareImportedLegacy(snapshot, 'bot-1', '-100123', await h.service.attributeLegacy(snapshot));
        expect(machineOnly.record).toMatchObject({ sessionId: null, machine: { status: 'observed', value: 'Mac Studio' },
          harness: { status: 'unknown' }, model: { status: 'unknown' } });
        expect(machineOnly.admission.children[0].materializations[0].requestJson).toContain('Echo · Mac Studio · unknown · unknown');
        expect(await h.store.importLegacy({ snapshot, admission: machineOnly.admission })).toBe(true);
      }
    } finally { queue.close(); }
  });
  it('an ended session no longer attributes, and harness/model are never claimed without a session', async () => {
    const h = await harness(), queue = PendingRelayStore.open('echo', h.stateDir);
    try {
      const token = await h.service.options.sessions.issue({ sessionId: 'gone', harnessId: 'codex-cli', projectDir: h.stateDir });
      await h.service.options.sessions.revoke('gone');
      queue.enqueue({ delivery_id: 'ended', topic_id: 42, text_hash: 'h1', text: 'After the session ended', http_code: 401,
        origin_session_digest: createHash('sha256').update(token).digest('hex') });
      const snapshot = (await h.store.legacyCandidates())[0];
      expect((await h.service.attributeLegacy(snapshot)).session).toBeNull();
      // A forged record claiming a harness without a session is refused by the import fence.
      const forged = h.service.prepareImportedLegacy(snapshot, 'bot-1', '-100123', { machine: (await h.service.attributeLegacy(snapshot)).machine,
        session: null });
      const record = JSON.parse(forged.admission.record.envelopeJson);
      record.harness = { value: 'codex-cli', status: 'observed', sourceEventRef: null, observedAt: null, reason: null };
      const envelopeJson = JSON.stringify(record);
      await expect(h.store.importLegacy({ snapshot, admission: { ...forged.admission, record: { ...forged.admission.record, envelopeJson } } }))
        .rejects.toThrow(/legacy-origin-required/);
    } finally { queue.close(); }
  });
  describe('an imported queue row under the notification gate', () => {
    const beacon = '{"status":"warming","phase":"booting"}';
    async function gated() {
      const h = await harness(), queue = PendingRelayStore.open('echo', h.stateDir);
      const gate = new NotificationSelectivityGate(h.stateDir, 'studio', () => ({ enabled: true, dryRun: false }));
      // An automated notice is moved to this hub topic when it is prepared.
      gate.pushDestination = () => ({ chatId: '-100123', topicId: 7000 });
      h.service.notificationGate = gate;
      h.service.notificationJobSession = id => id === 'job-session';
      const enroll = async (sessionId: string) => {
        const token = await h.service.options.sessions.issue({ sessionId, harnessId: 'claude-code', projectDir: h.stateDir });
        h.service.options.observer.track(h.service.options.sessions.getBinding(sessionId)!);
        return createHash('sha256').update(token).digest('hex');
      };
      const snapshotOf = async (deliveryId: string) => (await h.store.legacyCandidates()).find(row => row.deliveryId === deliveryId)!;
      const imported = async (deliveryId: string) => {
        const snapshot = await snapshotOf(deliveryId);
        const operation = h.service.prepareImportedLegacy(snapshot, 'bot-1', '-100123', await h.service.attributeLegacy(snapshot));
        expect(await h.store.importLegacy({ snapshot, admission: operation.admission })).toBe(true);
        return operation;
      };
      const entryState = (deliveryId: string) => queue.findByDeliveryId(deliveryId)?.state;
      const close = async () => { queue.close(); await gate.close(); };
      return { h, queue, gate, enroll, snapshotOf, imported, entryState, close };
    }
    it('a reply queued by a live session is retried as a reply, in its own topic', async () => {
      const t = await gated();
      try {
        const digest = await t.enroll('instar-app');
        t.queue.enqueue({ delivery_id: 'session-reply', topic_id: 42, text_hash: 'h1', text: 'Here is your answer', http_code: 503,
          error_body: beacon, origin_session_digest: digest });
        // The scope recovery happens to run in never decides a row's standing.
        const operation = await withNotificationEnvelope({ origin: 'automated', category: 'job-status', sourceContext: 'ambient' }, () => t.imported('session-reply'));
        expect(operation.record).toMatchObject({ producerKind: 'imported-legacy', sessionId: 'instar-app',
          notification: { origin: 'verified-reply', sourceContext: 'imported-origin-session' }, destination: { topicId: '42' } });
        await t.h.service.executePreparedBot(operation, t.h.network);
        expect(t.h.network).toHaveBeenCalledOnce();
        expect((await t.h.store.getOrigin(operation.record.originId))?.operation?.state).not.toBe('suppressed');
      } finally { await t.close(); }
    });
    it("a job session's row and an unattributed row stay quiet, and the entry is not labelled delivered", async () => {
      const t = await gated();
      try {
        const digest = await t.enroll('job-session');
        t.queue.enqueue({ delivery_id: 'job-row', topic_id: 42, text_hash: 'h1', text: 'Nightly report', http_code: 503,
          error_body: beacon, origin_session_digest: digest });
        t.queue.enqueue({ delivery_id: 'no-session-row', topic_id: 42, text_hash: 'h2', text: 'Old script row', http_code: 503, error_body: beacon });
        t.queue.enqueue({ delivery_id: 'foreign-row', topic_id: 42, text_hash: 'h3', text: 'Unknown credential', http_code: 503,
          error_body: beacon, origin_session_digest: 'f'.repeat(64) });
        for (const id of ['job-row', 'no-session-row', 'foreign-row']) {
          const operation = await t.imported(id);
          expect(operation.record.sessionId).toBe(id === 'job-row' ? 'job-session' : null);
          expect(operation.record.notification?.origin).toBe('automated');
          await expect(t.h.service.executePreparedBot(operation, t.h.network)).rejects.toBeInstanceOf(QuietRecordedError);
          expect((await t.h.store.getOrigin(operation.record.originId))?.operation).toMatchObject({ state: 'suppressed', holdReason: 'quiet-notification-recorded' });
          expect(t.entryState(id)).toBe('quiet-recorded');
        }
        expect(t.h.network).not.toHaveBeenCalled();
      } finally { await t.close(); }
    });
    it('a reply claim on an imported row that names no session is not a reply at the last hop', async () => {
      const t = await gated();
      try {
        t.queue.enqueue({ delivery_id: 'claimed-reply', topic_id: 42, text_hash: 'h1', text: 'Claims to be a reply', http_code: 503, error_body: beacon });
        const operation = await t.imported('claimed-reply');
        // The store refuses a changed seal (origin-store:digest-mismatch), so the
        // claim can only be tried in memory against the last-hop classifier.
        operation.record.notification = { origin: 'verified-reply', category: 'command-response', sourceContext: 'imported-origin-session' };
        const stored = (await t.h.store.getOrigin(operation.record.originId))!;
        await expect(t.h.service.classifyPreparedNotification(operation, stored)).rejects.toBeInstanceOf(QuietRecordedError);
        expect(t.h.network).not.toHaveBeenCalled();
      } finally { await t.close(); }
    });
  });
  it('isBootBeaconBody accepts only the beacon body', () => {
    expect(isBootBeaconBody('{"status":"warming","phase":"booting"}')).toBe(true);
    expect(isBootBeaconBody('{"phase":"booting","status":"warming"}')).toBe(true);
    expect(isBootBeaconBody('{"status":"ok","phase":"booting"}')).toBe(false);
    // A standby relaying the lease holder's booting answer adds a key: the send may
    // have reached the holder path, so it stays uncertain.
    expect(isBootBeaconBody('{"status":"warming","phase":"booting","relayedFromHolder":true}')).toBe(false);
    expect(isBootBeaconBody(null)).toBe(false);
    expect(isBootBeaconBody('not json')).toBe(false);
    expect(isBootBeaconBody('[]')).toBe(false);
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
  // Rule 37 quarantine: flips under disk load on unchanged main code (fixed evidence-sink
  // deadlines). Tracked defect: https://github.com/JKHeadley/instar/issues/2088
  it.skip('retains the confirmed subset of skipped forwards while holding the remainder without replay', async () => {
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
  it('seals an issues-group send with the issues chat and the real thread id (wireParams)', async () => {
    const h = await harness();
    const { toWireParams, ISSUES_TOPIC_OFFSET } = await import('../../../src/messaging/telegramTopicSpace.js');
    const service = new TelegramOriginService({ ...h.service.options,
      wireParams: params => toWireParams(params, { mainChatId: '-100123', issuesChatId: '-100999' }) });
    const operation = service.runAsAutomation('telegram-server', () => service.prepareBot({ method: 'sendMessage', accountId: 'bot-1',
      params: { chat_id: '-100123', message_thread_id: ISSUES_TOPIC_OFFSET + 7, text: 'bug reply' } }));
    const sealed = JSON.parse(JSON.parse(operation.admission.children[0].materializations[0].requestJson).body);
    expect(sealed.chat_id).toBe('-100999');
    expect(sealed.message_thread_id).toBe(7);
    expect(operation.record.destination).toMatchObject({ chatId: '-100999', topicId: '7' });
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
  it('receipt persistence failure after Telegram acceptance reports accepted-unrecorded with the message id', async () => {
    const h = await harness();
    vi.spyOn(h.store, 'recordOutcome').mockRejectedValue(new Error('disk failed'));
    await expect(h.send()).rejects.toMatchObject({ outcome: 'accepted-unrecorded', reason: 'receipt-persistence-unavailable',
      delivered: { messageId: '7', fallbackRecorded: false } });
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
  describe('content dedup counts only platform-accepted sends as delivered', () => {
    const longText = 'A complete reply to the operator that is long enough for exact content deduplication.';
    const longInput = (h: Awaited<ReturnType<typeof harness>>) => ({ ...h.input, params: { ...h.input.params, text: longText } });
    const sendLong = (h: Awaited<ReturnType<typeof harness>>) =>
      h.service.runAsAutomation('telegram-server', () => h.service.sendBot(longInput(h), h.network));
    it('suppresses an identical resend after a confirmed delivery', async () => {
      const h = await harness();
      expect((await sendLong(h)).ok).toBe(true);
      await expect(sendLong(h)).rejects.toMatchObject({ reason: 'duplicate-content' });
      expect(h.network).toHaveBeenCalledOnce();
    });
    it('keeps suppression when the platform accepted but the receipt could not be recorded', async () => {
      const h = await harness();
      const record = h.store.recordOutcome.bind(h.store);
      vi.spyOn(h.store, 'recordOutcome').mockRejectedValueOnce(new Error('disk failed')).mockImplementation(record);
      await expect(sendLong(h)).rejects.toMatchObject({ outcome: 'accepted-unrecorded', reason: 'receipt-persistence-unavailable' });
      await expect(sendLong(h)).rejects.toMatchObject({ reason: 'duplicate-content' });
      expect(h.network).toHaveBeenCalledOnce();
    });
    it('does not suppress a fresh send after a held send, and the held send cannot later duplicate it', async () => {
      const h = await harness();
      h.authorize.mockResolvedValueOnce(false);
      const held = h.service.runAsAutomation('telegram-server', () => h.service.prepareBot(longInput(h)));
      await h.service.admit(held);
      await expect(h.service.executePreparedBot(held, h.network)).rejects.toMatchObject({ reason: 'destination-not-authorized' });
      expect(h.network).not.toHaveBeenCalled();
      expect((await sendLong(h)).ok).toBe(true);
      expect(h.network).toHaveBeenCalledOnce();
      // The held operation's own later attempt now finds the delivered content.
      await expect(h.service.executePreparedBot(held, h.network)).rejects.toMatchObject({ reason: 'duplicate-content' });
      expect(h.network).toHaveBeenCalledOnce();
    });
    it('does not suppress a fresh send after an outcome-unknown or known-failed send', async () => {
      const h = await harness();
      h.network.mockRejectedValueOnce(new Error('response lost'));
      await expect(sendLong(h)).rejects.toMatchObject({ outcome: 'outcome-unknown', reason: 'transport-acceptance-unknown' });
      h.network.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, parameters: { retry_after: 61 } }), { status: 429 }));
      await expect(sendLong(h)).rejects.toMatchObject({ outcome: 'known-failed', reason: 'telegram-429' });
      expect((await sendLong(h)).ok).toBe(true);
      expect(h.network).toHaveBeenCalledTimes(3);
    });
    const pausedNetwork = (h: Awaited<ReturnType<typeof harness>>) => {
      let started!: () => void, finish!: (response: Response) => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      h.network.mockImplementationOnce(() => { started(); return new Promise<Response>(resolve => { finish = resolve; }); });
      return { began, finish: (response: Response) => finish(response) };
    };
    it('a held retry behind an in-flight fresh send stays recoverable and still delivers when that send is refused', async () => {
      const h = await harness();
      const held = h.service.runAsAutomation('telegram-server', () => h.service.prepareBot(longInput(h)));
      await h.service.admit(held);
      h.authorize.mockResolvedValueOnce(false);
      await expect(h.service.executePreparedBot(held, h.network)).rejects.toMatchObject({ reason: 'destination-not-authorized' });
      const paused = pausedNetwork(h);
      const fresh = sendLong(h).catch(error => error);
      await paused.began;
      // In flight is not delivered: a temporary hold, never a suppression.
      await expect(h.service.executePreparedBot(held, h.network)).rejects.toMatchObject({ reason: 'content-reservation-pending' });
      paused.finish(new Response(JSON.stringify({ ok: false, description: 'rejected' }), { status: 400 }));
      expect(await fresh).toMatchObject({ outcome: 'known-failed' });
      const row = await h.store.getOrigin(held.record.originId);
      expect(row?.operation?.state).not.toBe('suppressed');
      expect(row?.children.map(child => child.state)).toEqual(['queued']);
      expect((await h.store.recoverableAdmissions()).map(a => a.operationId)).toContain(held.record.operationId);
      // The outbox's own retry now delivers the reply.
      expect((await h.service.executePreparedBot(held, h.network)).ok).toBe(true);
      expect(h.network).toHaveBeenCalledTimes(2);
    });
    it('a competing execution that loses the claim never releases the live execution\'s reservation', async () => {
      const h = await harness();
      const op = h.service.runAsAutomation('telegram-server', () => h.service.prepareBot(longInput(h)));
      await h.service.admit(op);
      const paused = pausedNetwork(h);
      const first = h.service.executePreparedBot(op, h.network);
      await paused.began;
      await expect(h.service.executePreparedBot(op, h.network)).rejects.toMatchObject({ reason: 'outbox-not-ready' });
      // The identical fresh send finds the live reservation and is held, not sent.
      await expect(sendLong(h)).rejects.toMatchObject({ reason: 'content-reservation-pending' });
      paused.finish(new Response(JSON.stringify({ ok: true, result: { message_id: 8, chat: { id: -100123 }, message_thread_id: 42 } }), { status: 200 }));
      expect((await first).ok).toBe(true);
      expect(h.network).toHaveBeenCalledOnce();
      // Once delivered, a further identical send is a confirmed duplicate.
      await expect(sendLong(h)).rejects.toMatchObject({ reason: 'duplicate-content' });
      expect(h.network).toHaveBeenCalledOnce();
    });
  });
  it('does not prepare a session revoked while its runtime observation refreshes', async () => {
    const h = await harness();
    const token = await h.service.options.sessions.issue({ sessionId: 'session', harnessId: 'codex-cli', projectDir: process.cwd() });
    vi.spyOn(h.service.options.observer, 'refresh').mockImplementation(async () => { await h.service.options.sessions.revoke('session'); });
    await expect(h.service.runWithSessionToken(token, h.send)).rejects.toMatchObject({ reason: 'session-no-longer-authorized' });
    expect(h.network).not.toHaveBeenCalled();
  });
});
