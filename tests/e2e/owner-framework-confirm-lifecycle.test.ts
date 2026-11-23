/** Real AgentServer proposal, real Telegram/selectivity delivery, and the production confirm helper. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { handleAndAcknowledgeProfileProposalReply, profileProposalConversationContext, profileProposalFailureContext } from '../../src/core/handleProfileProposalReply.js';
import { crossTopicEligible } from '../../src/core/topicCreationProvenance.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationSelectivityGate, verifiedReplyEnvelope, requireTelegramDelivery } from '../../src/messaging/NotificationSelectivityGate.js';
import { withNotificationEnvelope } from '../../src/messaging/notificationStampers.js';
import { TeamConfinement } from '../../src/users/TeamConfinement.js';
import { TEAM_ACCESS_DIR } from '../../src/core/TeamAccessLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { renderProfileBatchProposal } from '../../src/core/profileProposalBatch.js';
import { proposalItems } from '../../src/core/ProfileProposalRequests.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const OWNER = 777;
const SOURCE = 1001;
const TARGET = 2002;
const SECOND_TARGET = 2003;
const AUTH = 'owner-framework-lifecycle-fixture';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-framework-lifecycle-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const config = { projectName: 'owner-framework-lifecycle', agentName: 'Test Agent', projectDir: dir, stateDir, port: 0, authToken: AUTH, developmentAgent: true } as InstarConfig;
  const store = new TopicProfileStore({ stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'), isDryRun: () => true });
  const resolver = new TopicProfileResolver({ store, defaultFramework: () => 'claude-code', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}), frameworkDefaultModels: () => ({}), tierEscalationConfig: () => undefined, localModelBinding: () => null, frameworkBinaryPath: () => null });
  const slots = new ProfileConfirmSlots();
  const telegram = new TelegramAdapter({ token: '123:lifecycle-fixture', chatId: '-1001', ownerUserId: OWNER, authorizedUserIds: [OWNER] }, stateDir, { suppressLifelineAutoCreate: true });
  const names = new Map<number, string>([[SOURCE, 'Planning'], [TARGET, 'Project Work'], [SECOND_TARGET, 'Second Project']]);
  vi.spyOn(telegram, 'getTopicName').mockImplementation(id => names.get(id) ?? null);
  const gate = new NotificationSelectivityGate(stateDir, 'test-machine', () => ({ enabled: true, dryRun: false }));
  telegram.selectivity = gate;
  const sent: Array<Record<string, unknown>> = [];
  let mid = 900;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    sent.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++mid } }));
  }));
  let server: AgentServer;
  const respawns: string[] = [];
  const surface = new TopicProfileWriteSurface({ store, resolver, regime: () => ({ enabled: false, dryRun: true }), boundOperator: key => server.getTopicOperatorStore()?.getOperator(key) ?? null, localModelBinding: () => null, legacyFrameworkRespawn: async key => { respawns.push(key); return { respawned: true }; }, disclose: async () => {}, audit: () => 'seq-owner-confirm' });
  server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), telegram, topicProfile: { store, resolver, surface, confirmSlots: slots } });
  cleanup.push(async () => { await server.stop(); await gate.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'owner-framework-confirm-lifecycle' }); });
  const bind = (topic: number, uid: number) => server.getTopicOperatorStore()!.setAuthenticatedOperator(topic, { platform: 'telegram', uid: String(uid), displayName: 'Fixture operator' }, { kind: 'authenticated-inbound', ingress: 'telegram-polling', authorization: 'telegram-is-authorized-sender', senderUid: String(uid), messageId: `fixture-${topic}-${uid}` });
  bind(SOURCE, OWNER);
  const delivered = new Map<string, { source: number; receipt: number }>();
  const propose = async (confirmIn?: number, patch: Record<string, string> = { framework: 'codex-cli' }) => {
    const response = await request(server.getApp()).post(`/topic-profile/${TARGET}/propose`).set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({ ...patch, ...(confirmIn ? { confirmIn } : {}) });
    if (response.status === 200) delivered.set(response.body.requestId, { source: confirmIn ?? TARGET,
      receipt: slots.proposals.get(String(confirmIn ?? TARGET), response.body.requestId)!.receipts.at(-1)!.messageId });
    return response;
  };
  const proposeBatch = async (body: Record<string, unknown> = {}) => {
    const response = await request(server.getApp()).post('/topic-profile/propose-batch')
      .set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1')
      .send({ confirmIn: SOURCE, ...(body.remindRequestIds === undefined ? { targets: [{ topicId: TARGET, patch: { framework: 'codex-cli' } },
        { topicId: SECOND_TARGET, patch: { framework: 'claude-code' } }] } : {}), ...body });
    if (response.status === 200) delivered.set(response.body.requestId, { source: SOURCE,
      receipt: slots.proposals.get(String(SOURCE), response.body.requestId)!.receipts.at(-1)!.messageId });
    return response;
  };
  const remind = (id: string) => request(server.getApp()).post(`/topic-profile/${TARGET}/propose`).set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({ remindRequestId: id, confirmIn: SOURCE });
  const confirm = async (uid = OWNER, id = [...delivered.keys()].at(-1)!, text = 'yes', inboundId = mid + 1, nativeReply?: number) => {
    const delivery = delivered.get(id)!;
    const out = await handleAndAcknowledgeProfileProposalReply({ requests: slots.proposals, surface,
      source: String(delivery.source), text, messageId: inboundId, replyTo: nativeReply ?? delivery.receipt, forwarded: false,
      principal: { kind: 'operator', platform: 'telegram', uid: String(uid) },
      verifiedOwner: () => uid === OWNER,
      eligible: destKey => {
        const ops = server.getTopicOperatorStore()!; const confinement = new TeamConfinement(stateDir);
        return crossTopicEligible({ ownerUid: String(OWNER), confirmerUid: String(uid), sourceConfined: confinement.isConfined(`telegram:${delivery.source}`),
          destKnown: telegram.getTopicName(Number(destKey)) !== null, destBinding: ops.getBinding(destKey),
          destVerifiedUid: ops.getOperator(destKey)?.uid ?? null, destConfined: confinement.isConfined(`telegram:${destKey}`) }).ok;
      }, placement: () => 'standalone', name: destKey => telegram.getTopicName(Number(destKey))! }, async text => {
        const sent = await withNotificationEnvelope(verifiedReplyEnvelope('owner-framework-test-inbound'), async () => telegram.sendToTopic(delivery.source, text));
        requireTelegramDelivery(sent);
      });
    return { ...out, written: out.result?.ok ?? false, reply: out.result?.reply };
  };

  return { stateDir, store, surface, slots, telegram, sent, respawns, bind, propose, proposeBatch, names, remind, confirm, operators: server.getTopicOperatorStore()!, app: server.getApp() };
}

describe('Owner framework confirmation is alive through production composition', () => {
  it('shows the long deadline and makes an intentional identical re-send visibly distinct through real delivery', async () => {
    const h = harness(); const before = Date.now();
    const first = await h.propose(SOURCE); const second = await h.propose(SOURCE);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(first.body.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
    expect(second.body.expiresAt).toBe(first.body.expiresAt);
    expect(second.body.requestId).toBe(first.body.requestId);
    expect(h.sent).toHaveLength(2); expect(h.sent[0].text).not.toBe(h.sent[1].text);
    expect(String(h.sent[1].text)).toContain('Reminder 2'); expect(String(h.sent[1].text)).toContain('UTC');
    expect(h.slots.proposals.get(String(SOURCE), first.body.requestId)?.receipts.map(receipt => receipt.messageId)).toEqual([901, 902]);
  });

  it('provides a no-authority explanation context for a real unbound owner reply after final delivery failure', async () => {
    const h = harness(); const fail = vi.spyOn(h.telegram, 'sendToTopic').mockRejectedValueOnce(new Error('question delivery unavailable'));
    expect((await h.propose(SOURCE)).status).toBe(502); fail.mockRestore();
    expect(h.slots.proposals.list(String(SOURCE))).toEqual([]);
    let words = ''; let context = '';
    h.telegram.onTopicMessage = async message => {
      words = message.content;
      context = profileProposalFailureContext({ requests: h.slots.proposals, source: String(SOURCE), text: message.content,
        replyTo: message.metadata?.replyToMessageId, forwarded: message.metadata?.forwarded === true,
        authenticatedOwner: () => h.operators.getOperator(SOURCE)?.uid === message.userId });
    };
    const polling = h.telegram as unknown as { processUpdate(update: unknown): Promise<void> };
    await polling.processUpdate({ update_id: 1, message: { message_id: 990, message_thread_id: SOURCE,
      date: Math.floor(Date.now() / 1000), from: { id: OWNER, first_name: 'Fixture' },
      chat: { id: -1001, type: 'supergroup' }, text: 'yes',
      reply_to_message: { message_id: SOURCE, forum_topic_created: { name: 'Planning' } } } });
    expect(words).toBe('yes'); expect(context).toContain('did not start another change');
    expect(context).not.toContain('Project Work'); expect(h.store.resolve(TARGET)).toBeNull(); expect(h.respawns).toEqual([]);
  });

  it('delivers the exact proposal in the asking conversation and writes only the unbound target after the owner confirms', async () => {
    const h = harness();
    const res = await h.propose(SOURCE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message_thread_id).toBe(SOURCE);
    expect(h.sent[0].text).toContain('Project Work');
    expect(h.sent[0].text).toContain('Use Codex');
    expect(h.sent[0].text).toContain('summary');
    expect(h.sent[0].text).not.toContain('framework →');
    expect(h.slots.proposals.list(String(SOURCE))[0]?.receipts[0].messageId).toBe(901);
    expect(h.store.resolve(TARGET)).toBeNull();
    expect(h.respawns).toEqual([]);
    expect((await h.confirm()).written).toBe(true);
    expect(h.store.resolve(TARGET)?.framework).toBe('codex-cli');
    expect(h.store.resolve(TARGET)?.updatedBy).toBe('telegram:777');
    expect(h.store.resolve(SOURCE)).toBeNull();
    expect(h.respawns).toEqual([String(TARGET)]);
    const persisted = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'state', 'topic-profiles.json'), 'utf8'));
    expect(JSON.stringify(persisted)).toContain('codex-cli');
  });

  it('carries a real polling update reply receipt into confirmation instead of inventing one in the fixture', async () => {
    const h = harness(); const proposed = await h.propose(SOURCE); expect(proposed.status).toBe(200);
    let outcome: Awaited<ReturnType<typeof h.confirm>> | null = null;
    h.telegram.onTopicMessage = async message => {
      const nativeReply = message.metadata?.replyToMessageId;
      if (typeof nativeReply !== 'number') return;
      outcome = await h.confirm(Number(message.userId), proposed.body.requestId, message.content, Number(message.id.slice(3)), nativeReply);
    };
    const polling = h.telegram as unknown as { processUpdate(update: unknown): Promise<void> };
    const update = { message_id: 990, message_thread_id: SOURCE, date: Math.floor(Date.now() / 1000),
      from: { id: OWNER, first_name: 'Fixture operator' }, chat: { id: -1001, type: 'supergroup' }, text: 'yes', reply_to_message: { message_id: 901 } };
    await polling.processUpdate({ update_id: 1, message: { ...update, reply_to_message: { message_id: 899 } } });
    expect(h.store.resolve(TARGET)).toBeNull();
    await polling.processUpdate({ update_id: 2, message: { ...update, message_id: 991 } });
    expect(outcome).toMatchObject({ written: true });
    expect(h.store.resolve(TARGET)?.framework).toBe('codex-cli'); expect(h.respawns).toEqual([String(TARGET)]);
  });

  it('supplies the referenced server question to the ordinary agent turn without treating numbered yes as consent', async () => {
    const h = harness(); const a = await h.propose(SOURCE); const b = await h.propose(SOURCE, { framework: 'claude-code' });
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    let context = ''; let words = '';
    h.telegram.onTopicMessage = async message => {
      words = message.content;
      context = profileProposalConversationContext({ requests: h.slots.proposals, source: String(SOURCE), text: message.content,
        replyTo: message.metadata?.replyToMessageId, messageId: Number(message.id.slice(3)), forwarded: message.metadata?.forwarded === true,
        authenticatedOwner: () => h.operators.getOperator(SOURCE)?.uid === message.userId,
        eligible: dest => crossTopicEligible({ ownerUid: String(OWNER), confirmerUid: message.userId,
          sourceConfined: false, destKnown: h.telegram.getTopicName(Number(dest)) !== null,
          destBinding: h.operators.getBinding(dest), destVerifiedUid: h.operators.getOperator(dest)?.uid ?? null, destConfined: false }).ok,
        placement: () => 'standalone', currentEcho: p => { const fresh = h.surface.renderProposalEcho(p.target, p.patch, h.telegram.getTopicName(Number(p.target))!); return fresh.ok ? fresh.echo : null; },
      });
    };
    const polling = h.telegram as unknown as { processUpdate(update: unknown): Promise<void> };
    const message = { message_id: 990, message_thread_id: SOURCE, date: Math.floor(Date.now() / 1000),
      from: { id: OWNER, first_name: 'Fixture' }, chat: { id: -1001, type: 'supergroup' }, text: '1) yes', reply_to_message: { message_id: 902 } };
    await polling.processUpdate({ update_id: 1, message });
    expect(words).toBe('1) yes'); expect(context).toContain(b.body.requestId); expect(context).not.toContain(a.body.requestId);
    expect(JSON.parse(context.split('\n')[1]).replyFacts).toEqual({ nativeReplyVerified: true, replyToMessageId: 902, inboundMessageId: 990, textIsExactYes: false });
    expect(context).toContain('Use Claude'); expect(h.store.resolve(TARGET)).toBeNull(); expect(h.slots.proposals.list(String(SOURCE))).toHaveLength(2);
    const operation = JSON.parse(context.split('\n')[1]).reminder;
    const reminder = await request(h.app).post(operation.path).set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send(operation.body);
    expect(reminder.status).toBe(200); expect(reminder.body.requestId).toBe(b.body.requestId);
    expect(h.store.resolve(TARGET)).toBeNull();
    const receipt = h.slots.proposals.get(String(SOURCE), b.body.requestId)!.receipts.at(-1)!.messageId;
    expect((await h.confirm(OWNER, b.body.requestId, 'yes', 1002, receipt)).written).toBe(true);
    expect(h.store.resolve(TARGET)?.framework).toBe('claude-code');

    await polling.processUpdate({ update_id: 2, message: { ...message, message_id: 991, forward_origin: { type: 'user' } } });
    expect(context).toBe(''); expect(h.store.resolve(TARGET)?.framework).toBe('claude-code');
  });

  it('executes the supplied same-topic reminder operation without an invalid cross-topic field', async () => {
    const h = harness(); h.bind(TARGET, OWNER); const proposed = await h.propose(); expect(proposed.status).toBe(200);
    const incoming = { text: '1) yes', replyTo: 901, messageId: 990 };
    const context = profileProposalConversationContext({ requests: h.slots.proposals, source: String(TARGET), text: incoming.text,
      replyTo: incoming.replyTo, messageId: incoming.messageId, forwarded: false,
      authenticatedOwner: () => h.operators.getOperator(TARGET)?.uid === String(OWNER),
      eligible: () => !new TeamConfinement(h.stateDir).isConfined(`telegram:${TARGET}`), placement: () => 'standalone',
      currentEcho: p => { const fresh = h.surface.renderProposalEcho(p.target, p.patch, h.telegram.getTopicName(Number(p.target))!); return fresh.ok ? fresh.echo : null; },
    });
    const verifiedContext = JSON.parse(context.split('\n')[1]);
    expect(verifiedContext.replyFacts).toEqual({ nativeReplyVerified: true, replyToMessageId: incoming.replyTo, inboundMessageId: incoming.messageId, textIsExactYes: false });
    const operation = verifiedContext.reminder;
    expect(operation.body).not.toHaveProperty('confirmIn');
    const reminder = await request(h.app).post(operation.path).set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send(operation.body);
    expect(reminder.status).toBe(200); expect(reminder.body.requestId).toBe(proposed.body.requestId); expect(h.store.resolve(TARGET)).toBeNull();
    const receipt = h.slots.proposals.get(String(TARGET), proposed.body.requestId)!.receipts.at(-1)!.messageId;
    expect((await h.confirm(OWNER, proposed.body.requestId, 'yes', 1002, receipt)).written).toBe(true);
    expect(h.store.resolve(TARGET)?.framework).toBe('codex-cli');
  });

  it('delivers an in-topic proposal visibly while an ordinary automated report stays quiet', async () => {
    const h = harness();
    h.bind(TARGET, OWNER);
    expect((await h.propose()).status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message_thread_id).toBe(TARGET);
    expect(h.slots.proposals.list(String(TARGET))[0]?.receipts[0].messageId).toBe(901);
    expect(await h.telegram.sendToTopic(TARGET, 'Routine automated report')).toMatchObject({ recorded: true });
    expect(h.sent).toHaveLength(1);
    expect(h.store.resolve(TARGET)).toBeNull();
  });

  it('keeps two questions through agent activity and reminders; nonexact text never applies', async () => {
    const h = harness(); const a = await h.propose(SOURCE); const b = await h.propose(SOURCE, { framework: 'claude-code' });
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    h.slots.noteOutbound(String(SOURCE), 902);
    expect((await h.confirm(OWNER, b.body.requestId, '1) yes')).written).toBe(false);
    expect((await h.confirm(OWNER, b.body.requestId, `> ${b.body.echo.replaceAll('\n', '\n> ')}\nyes`)).written).toBe(false);
    expect(h.store.resolve(TARGET)).toBeNull();
    const reminder = await h.remind(b.body.requestId); expect(reminder.status).toBe(200);
    expect(h.sent).toHaveLength(3); expect(h.sent[2].text).toContain('Use Claude');
    expect(h.sent[2].text).not.toContain('Use Codex');
    expect((await h.confirm(OWNER, b.body.requestId)).written).toBe(true);
    expect(h.store.resolve(TARGET)?.framework).toBe('claude-code');
    expect(h.slots.proposals.get(String(SOURCE), a.body.requestId)).not.toBeNull();
    expect(h.respawns).toEqual([String(TARGET)]);
  });

  it('retains the saved result without blindly resending an acknowledgment after a real adapter send failure', async () => {
    const h = harness(); const proposed = await h.propose(SOURCE); expect(proposed.status).toBe(200);
    const failedSend = vi.spyOn(h.telegram, 'sendToTopic').mockRejectedValueOnce(new Error('ack transport failed'));
    const first = await h.confirm(OWNER, proposed.body.requestId, 'yes', 950);
    expect(first.written).toBe(true); expect(first.acknowledgment).toBe('failed');
    expect(failedSend).toHaveBeenCalledTimes(1); failedSend.mockRestore();
    const duplicate = await h.confirm(OWNER, proposed.body.requestId, 'yes', 950);
    expect(duplicate.result).toEqual(first.result); expect(duplicate.acknowledgment).toBe('not-needed');
    expect(h.respawns).toEqual([String(TARGET)]); expect(h.store.resolve(TARGET)?.framework).toBe('codex-cli');
    expect(h.sent).toHaveLength(1); // Only the question was actually sent; the failed acknowledgment was not retried.
  });

  it.each(['non-owner', 'other-operator', 'team'])('rechecks %s at confirmation and never writes or respawns the target', async boundary => {
    const h = harness();
    expect((await h.propose(SOURCE)).status).toBe(200);
    if (boundary === 'other-operator') h.bind(TARGET, 888);
    if (boundary === 'team') {
      fs.mkdirSync(path.join(h.stateDir, TEAM_ACCESS_DIR), { recursive: true });
      fs.writeFileSync(path.join(h.stateDir, TEAM_ACCESS_DIR, 'confined.json'), JSON.stringify({ entries: [{ ref: `telegram:${TARGET}` }] }));
    }
    const out = await h.confirm(boundary === 'non-owner' ? 888 : OWNER);
    expect(out.written).toBe(false);
    expect(h.store.resolve(TARGET)).toBeNull();
    expect(h.respawns).toEqual([]);
  });
});

describe('batch confirmation through native Telegram polling and production composition', () => {
  it('applies exactly two targets from one real native reply and emits one aggregate completion', async () => {
    const h = harness(); await h.store.mutate('9009', { framework: 'claude-code', updatedBy: 'fixture' });
    const proposed = await h.proposeBatch(); expect(proposed.status).toBe(200); expect(h.sent).toHaveLength(1);
    const receipt = h.slots.proposals.get(String(SOURCE), proposed.body.requestId)!.receipts[0].messageId;
    let outcome: Awaited<ReturnType<typeof h.confirm>> | undefined;
    h.telegram.onTopicMessage = async message => {
      outcome = await h.confirm(Number(message.userId), proposed.body.requestId, message.content, Number(message.id.slice(3)), Number(message.metadata?.replyToMessageId));
    };
    const polling = h.telegram as unknown as { processUpdate(update: unknown): Promise<void> };
    const message = { message_id: 990, message_thread_id: SOURCE, date: Math.floor(Date.now() / 1000), from: { id: OWNER, first_name: 'Fixture owner' }, chat: { id: -1001, type: 'supergroup' }, text: 'yes', reply_to_message: { message_id: receipt } };
    await polling.processUpdate({ update_id: 1, message: { ...message, reply_to_message: { message_id: receipt - 1 } } });
    expect(h.store.resolve(TARGET)).toBeNull(); expect(h.store.resolve(SECOND_TARGET)).toBeNull();
    await polling.processUpdate({ update_id: 2, message: { ...message, message_id: 991 } });
    expect(outcome).toMatchObject({ written: true, acknowledgment: 'delivered' });
    expect(h.store.resolve(TARGET)?.framework).toBe('codex-cli'); expect(h.store.resolve(SECOND_TARGET)?.framework).toBe('claude-code');
    expect(h.store.resolve(SOURCE)).toBeNull(); expect(h.store.resolve('9009')?.framework).toBe('claude-code');
    expect(h.sent).toHaveLength(2); expect(h.sent[1].text).toContain('Saved the settings for 2 conversations');
    expect(h.respawns).toEqual([]); // Unknown live-session identity is truthful: settings saved, no guessed restart.
  });

  it('keeps numbered yes conversational, sends a registered batch reminder, and survives agent activity', async () => {
    const h = harness(); const proposed = await h.proposeBatch(); expect(proposed.status).toBe(200);
    const receipt = h.slots.proposals.get(String(SOURCE), proposed.body.requestId)!.receipts[0].messageId;
    let context = '', words = '';
    h.telegram.onTopicMessage = async message => {
      words = message.content;
      context = profileProposalConversationContext({ requests: h.slots.proposals, source: String(SOURCE), text: message.content, replyTo: message.metadata?.replyToMessageId,
        messageId: Number(message.id.slice(3)), forwarded: message.metadata?.forwarded === true,
        authenticatedOwner: () => h.operators.getOperator(SOURCE)?.uid === message.userId,
        eligible: target => h.telegram.getTopicName(Number(target)) !== null, placement: () => 'standalone',
        currentEcho: proposal => {
          const rendered = renderProfileBatchProposal({ source: String(SOURCE), targets: proposalItems(proposal).map(item => ({ target: item.target, patch: item.patch })),
            surface: h.surface, name: target => h.telegram.getTopicName(Number(target))!, link: target => `https://t.me/c/1/${target}`, placement: () => 'standalone' });
          return rendered.ok ? rendered.core : null;
        } });
    };
    const polling = h.telegram as unknown as { processUpdate(update: unknown): Promise<void> };
    await polling.processUpdate({ update_id: 1, message: { message_id: 990, message_thread_id: SOURCE, date: Math.floor(Date.now() / 1000),
      from: { id: OWNER, first_name: 'Fixture owner' }, chat: { id: -1001, type: 'supergroup' }, text: '1) yes', reply_to_message: { message_id: receipt } } });
    expect(words).toBe('1) yes'); expect(h.store.resolve(TARGET)).toBeNull(); expect(h.store.resolve(SECOND_TARGET)).toBeNull();
    expect(JSON.parse(context.split('\n')[1]).replyFacts).toEqual({ nativeReplyVerified: true, replyToMessageId: receipt, inboundMessageId: 990, textIsExactYes: false });
    const operation = JSON.parse(context.split('\n')[1]).reminder;
    expect(operation.path).toBe('/topic-profile/propose-batch'); expect(operation.body.remindRequestIds).toEqual([proposed.body.requestId]);
    await withNotificationEnvelope(verifiedReplyEnvelope('agent-progress-fixture'), () => h.telegram.sendToTopic(SOURCE, 'I am still working on the other task.'));
    expect(h.slots.proposals.get(String(SOURCE), proposed.body.requestId)).not.toBeNull();
    const reminder = await h.proposeBatch(operation.body); expect(reminder.status).toBe(200);
    expect(h.store.resolve(TARGET)).toBeNull(); expect(h.store.resolve(SECOND_TARGET)).toBeNull();
    const current = h.slots.proposals.get(String(SOURCE), reminder.body.requestId)!;
    expect(reminder.body.requestId).toBe(proposed.body.requestId);
    expect(reminder.body.expiresAt).toBe(proposed.body.expiresAt);
    expect(reminder.body).toMatchObject({ questionDelivery: { kind: 'registered', topicId: SOURCE }, settingsApplied: false, replyAlreadyDelivered: true });
    const remindedReceipt = reminder.body.questionDelivery.messageId;
    expect(current.receipts).toHaveLength(2);
    expect(current.receipts[0].messageId).toBe(receipt);
    expect(current.receipts.map(item => item.messageId)).toEqual([receipt, remindedReceipt]);
    expect(remindedReceipt).not.toBe(receipt);
    expect((await h.confirm(OWNER, reminder.body.requestId, 'yes', 1000, remindedReceipt)).written).toBe(true);
    expect(h.store.resolve(TARGET)?.framework).toBe('codex-cli'); expect(h.store.resolve(SECOND_TARGET)?.framework).toBe('claude-code');
  });

  it('associates same-title links with their distinct real Telegram target and effect', async () => {
    const h = harness(); h.names.set(TARGET, 'Identical title'); h.names.set(SECOND_TARGET, 'Identical title');
    const proposed = await h.proposeBatch(); expect(proposed.status).toBe(200);
    const html = String(h.sent[0].text);
    expect(html).toMatch(/href="https:\/\/t\.me\/c\/1\/2002"/); expect(html).toMatch(/href="https:\/\/t\.me\/c\/1\/2003"/);
    const first = html.slice(html.indexOf('/2002"'), html.indexOf('/2003"')); const second = html.slice(html.indexOf('/2003"'));
    expect(first).toContain('Use Codex'); expect(first).not.toContain('Use Claude'); expect(second).toContain('Use Claude');
  });

  it('uses one acknowledgment consumer for simultaneous duplicate confirmations', async () => {
    const h = harness(); const proposed = await h.proposeBatch(); expect(proposed.status).toBe(200);
    const results = await Promise.all([h.confirm(OWNER, proposed.body.requestId, 'yes', 990), h.confirm(OWNER, proposed.body.requestId, 'yes', 990)]);
    expect(results.every(result => result.written)).toBe(true);
    expect(results.map(result => result.acknowledgment).sort()).toEqual(['delivered', 'not-needed']);
    expect(h.sent).toHaveLength(2); expect(h.sent.filter(message => String(message.text).includes('Saved the settings for 2 conversations'))).toHaveLength(1);
  });

  it('leaves no usable batch receipt after a known failed real-adapter delivery', async () => {
    const h = harness(); const fail = vi.spyOn(h.telegram, 'sendToTopic').mockRejectedValueOnce(new Error('dispatch definitely failed'));
    const proposed = await h.proposeBatch(); expect(proposed.status).toBe(502); fail.mockRestore();
    expect(h.slots.proposals.list(String(SOURCE))).toEqual([]); expect(h.store.all()).toEqual({});
    const result = await handleAndAcknowledgeProfileProposalReply({ requests: h.slots.proposals, surface: h.surface, source: String(SOURCE), text: 'yes', messageId: 990,
      replyTo: 901, forwarded: false, principal: { kind: 'operator', platform: 'telegram', uid: String(OWNER) }, verifiedOwner: () => true, eligible: () => true, placement: () => 'standalone', name: () => 'Project Work' }, async () => { throw new Error('No acknowledgment expected'); });
    expect(result.result?.settingsSaved).not.toBe(true); expect(h.store.all()).toEqual({});
  });
});


describe('verified native reply facts remain diagnostics in the actual polling data flow', () => {
  it('preserves exact-yes text and native IDs without applying from context, and keeps guarded contexts empty', async () => {
    const h = harness(); const proposed = await h.propose(SOURCE); expect(proposed.status).toBe(200);
    const receipt = h.slots.proposals.get(String(SOURCE), proposed.body.requestId)!.receipts[0].messageId;
    let context = '', incomingText = '';
    h.telegram.onTopicMessage = async message => {
      incomingText = message.content;
      context = profileProposalConversationContext({ requests: h.slots.proposals, source: String(SOURCE), text: message.content,
        replyTo: message.metadata?.replyToMessageId, messageId: Number(message.id.slice(3)), forwarded: message.metadata?.forwarded === true,
        authenticatedOwner: () => h.operators.getOperator(SOURCE)?.uid === message.userId,
        eligible: target => h.telegram.getTopicName(Number(target)) !== null, placement: () => 'standalone',
        currentEcho: proposal => { const rendered = h.surface.renderProposalEcho(proposal.target, proposal.patch, h.telegram.getTopicName(Number(proposal.target))!); return rendered.ok ? rendered.echo : null; },
      });
    };
    const polling = h.telegram as unknown as { processUpdate(update: unknown): Promise<void> };
    const incoming = { message_id: 990, message_thread_id: SOURCE, date: Math.floor(Date.now() / 1000), from: { id: OWNER, first_name: 'Fixture owner' },
      chat: { id: -1001, type: 'supergroup' }, text: 'yes', reply_to_message: { message_id: receipt } };
    await polling.processUpdate({ update_id: 1, message: incoming });
    expect(incomingText).toBe('yes');
    expect(JSON.parse(context.split('\n')[1]).replyFacts).toEqual({ nativeReplyVerified: true, replyToMessageId: receipt, inboundMessageId: 990, textIsExactYes: true });
    expect(h.store.resolve(TARGET)).toBeNull(); expect(h.respawns).toEqual([]); expect(h.sent).toHaveLength(1);
    context = '';
    await polling.processUpdate({ update_id: 2, message: { ...incoming, message_id: 991, forward_origin: { type: 'user' } } });
    expect(context).toBe(''); expect(h.store.resolve(TARGET)).toBeNull();
    await polling.processUpdate({ update_id: 3, message: { ...incoming, message_id: 992, reply_to_message: { message_id: receipt - 1 } } });
    expect(context).toBe(''); expect(h.store.resolve(TARGET)).toBeNull();
  });
});
