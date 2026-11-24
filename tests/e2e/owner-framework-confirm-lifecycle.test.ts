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
import { applyCrossTopicConfirm, crossTopicEligible } from '../../src/core/topicCreationProvenance.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
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
  const telegram = new TelegramAdapter({ token: '123:lifecycle-fixture', chatId: '-1001', ownerUserId: OWNER }, stateDir, { suppressLifelineAutoCreate: true });
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
  const propose = (confirmIn?: number) => request(server.getApp()).post(`/topic-profile/${TARGET}/propose`).set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({ framework: 'codex-cli', ...(confirmIn ? { confirmIn } : {}) });
  const confirm = async (uid = OWNER) => {
    const match = slots.matchConfirm(String(SOURCE), { platformMessageId: mid + 1, forwarded: false });
    expect(match.ok).toBe(true);
    if (!match.ok) throw new Error('Expected actual delivered proposal slot');
    return applyCrossTopicConfirm({ sourceTopicKey: String(SOURCE), targetTopicKey: match.armed.targetTopicKey!, patch: match.armed.patch as Record<string, unknown>, agentComposed: true, principal: { kind: 'operator', platform: 'telegram', uid: String(uid) }, eligibility: (confirmerUid, destKey, sourceKey) => {
      const ops = server.getTopicOperatorStore()!;
      const confinement = new TeamConfinement(stateDir);
      return crossTopicEligible({ ownerUid: String(OWNER), confirmerUid, sourceConfined: confinement.isConfined(`telegram:${sourceKey}`), destKnown: telegram.getTopicName(Number(destKey)) !== null, destBinding: ops.getBinding(destKey), destVerifiedUid: ops.getOperator(destKey)?.uid ?? null, destConfined: confinement.isConfined(`telegram:${destKey}`) });
    }, applyWrite: req => surface.applyWrite(req as Parameters<typeof surface.applyWrite>[0]) });
  };
  return { stateDir, store, surface, slots, telegram, sent, respawns, bind, propose, confirm };
}

describe('Owner framework confirmation is alive through production composition', () => {
  it('delivers the exact proposal in the asking conversation and writes only the unbound target after the owner confirms', async () => {
    const h = harness();
    const res = await h.propose(SOURCE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message_thread_id).toBe(SOURCE);
    expect(h.sent[0].text).toContain('Project Work');
    expect(h.sent[0].text).toContain('framework → codex-cli');
    expect(h.slots.peek(String(SOURCE))?.echoPlatformMessageId).toBe(901);
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

  it('delivers an in-topic proposal visibly while an ordinary automated report stays quiet', async () => {
    const h = harness();
    h.bind(TARGET, OWNER);
    expect((await h.propose()).status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message_thread_id).toBe(TARGET);
    expect(h.slots.peek(String(TARGET))?.echoPlatformMessageId).toBe(901);
    expect(await h.telegram.sendToTopic(TARGET, 'Routine automated report')).toMatchObject({ recorded: true });
    expect(h.sent).toHaveLength(1);
    expect(h.store.resolve(TARGET)).toBeNull();
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
