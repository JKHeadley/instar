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
import { handleAndAcknowledgeProfileProposalReply } from '../../src/core/handleProfileProposalReply.js';
import { crossTopicEligible } from '../../src/core/topicCreationProvenance.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationSelectivityGate, verifiedReplyEnvelope, requireTelegramDelivery } from '../../src/messaging/NotificationSelectivityGate.js';
import { withNotificationEnvelope } from '../../src/messaging/notificationStampers.js';
import { TeamConfinement } from '../../src/users/TeamConfinement.js';
import { TEAM_ACCESS_DIR } from '../../src/core/TeamAccessLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const OWNER = 777;
const SOURCE = 1001;
const TARGET = 2002;
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
  vi.spyOn(telegram, 'getTopicName').mockImplementation(id => id === TARGET ? 'Project Work' : id === SOURCE ? 'Planning' : null);
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
  const remind = (id: string) => request(server.getApp()).post(`/topic-profile/${TARGET}/propose`).set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({ remindRequestId: id, confirmIn: SOURCE });
  const confirm = async (uid = OWNER, id = [...delivered.keys()].at(-1)!, text = 'yes', inboundId = mid + 1, nativeReply?: number) => {
    const delivery = delivered.get(id)!;
    const out = await handleAndAcknowledgeProfileProposalReply({ requests: slots.proposals, surface,
      source: String(delivery.source), text, messageId: inboundId, replyTo: nativeReply ?? delivery.receipt, forwarded: false,
      principal: { kind: 'operator', platform: 'telegram', uid: String(uid) },
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

  return { stateDir, store, surface, slots, telegram, sent, respawns, bind, propose, remind, confirm };
}

describe('Owner framework confirmation is alive through production composition', () => {
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

  it('replays the saved result through the production acknowledgment consumer after a real adapter send failure', async () => {
    const h = harness(); const proposed = await h.propose(SOURCE); expect(proposed.status).toBe(200);
    const failedSend = vi.spyOn(h.telegram, 'sendToTopic').mockRejectedValueOnce(new Error('ack transport failed'));
    const first = await h.confirm(OWNER, proposed.body.requestId, 'yes', 950);
    expect(first.written).toBe(true); expect(first.acknowledgment).toBe('failed');
    expect(failedSend).toHaveBeenCalledTimes(1); failedSend.mockRestore();
    const duplicate = await h.confirm(OWNER, proposed.body.requestId, 'yes', 950);
    expect(duplicate.result).toEqual(first.result); expect(duplicate.acknowledgment).toBe('delivered');
    expect(h.respawns).toEqual([String(TARGET)]); expect(h.store.resolve(TARGET)?.framework).toBe('codex-cli');
    expect(h.sent.at(-1)!.text).toContain('codex-cli');
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
