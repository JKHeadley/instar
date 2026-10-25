/**
 * Integration: invite pairing through the real /internal/telegram-forward and
 * /internal/telegram-callback routes (docs/specs/a2a-pairing-invite-link.md §6.1).
 *
 * - A forwarded message carrying an invite never reaches a session or the inbound log.
 * - Enforce + lifeline secret + owner: an Approve prompt; the tap approves through the engine,
 *   never through the adapter's generic callback path.
 * - Observe once the lifeline has proven itself: the same prompt (a tap still needs the secret).
 * - A lifeline that never proved itself, or not the owner: no prompt, a pointer to the dashboard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../src/core/LifelineIngressSecret.js';
import { createInvite, inviteMessage, findInviteToken } from '../../src/threadline/PairingInvite.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { NO_OWNER_REFUSAL, NOT_OWNER_REFUSAL, resolveApprovalOwner } from '../../src/threadline/PairingInviteTelegram.js';

const AUTH_TOKEN = 'test-auth-token-invite-telegram';
const SERVER_VERSION = '1.3.500';
const OWNER = 777001;
const IID = 'cd'.repeat(16);
const INVITE = inviteMessage(createInvite({ identityPubHex: crypto.randomBytes(32).toString('hex'), owner: 'Justin', agent: 'Scout' }));

interface Effects {
  topicMessages: string[];
  inboundLogged: number;
  adapterCallbacks: string[];
  sent: Array<{ topicId: number; text: string; buttons?: Array<{ text: string; data: string }> }>;
  answers: string[];
  flow: string[];
}

interface Boot { owner?: number | undefined; operators?: TopicOperatorStore | null; polling?: boolean; pollingHandler?: { h: null | { onForwardedInvite(m: unknown): Promise<void>; onCallback(c: unknown): Promise<boolean> } } }

function makeContext(stateDir: string, fx: Effects, extra: Record<string, unknown>, b: Boot = {}): RouteContext {
  const owner = 'owner' in b ? b.owner : OWNER;
  const flow = {
    receiveInvite: async () => { fx.flow.push('receive'); return { ok: true, iid: IID, claimedAgent: 'Scout', claimedOwner: 'Justin', checkCode: 'K7Q2' }; },
    approveAccept: (iid: string) => { fx.flow.push(`approve:${iid}`); return { ok: true }; },
    declineAccept: (iid: string) => { fx.flow.push(`decline:${iid}`); return { ok: true }; },
    approveFinish: (iid: string) => { fx.flow.push(`finish:${iid}`); return { ok: true }; },
    rejectFinish: (iid: string) => { fx.flow.push(`not-them:${iid}`); return { ok: true }; },
  };
  return {
    config: {
      projectName: 'test-project', projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: AUTH_TOKEN,
      sessions: {} as never, scheduler: {} as never, ...extra,
    } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] } as never,
    scheduler: null,
    telegram: {
      isPolling: b.polling === true,
      onTopicMessage: (m: { content: string }) => { fx.topicMessages.push(m.content); },
      logInboundMessage: () => { fx.inboundLogged++; },
      dispatchAgentMessageHook: async () => false,
      isAuthorizedSender: () => true,
      handleForwardedCallback: async (q: { data: string }) => { fx.adapterCallbacks.push(q.data); },
      sendToTopic: async (topicId: number, text: string) => { fx.sent.push({ topicId, text }); return {}; },
      sendPairingPrompt: async (topicId: number, text: string, buttons: Array<{ text: string; data: string }>) => { fx.sent.push({ topicId, text, buttons }); return 1; },
      answerCallback: async (_id: unknown, text: string) => { fx.answers.push(text); },
      getOwnerUserId: () => owner,
      getChatId: () => '-100',
      getLifelineTopicId: () => 3,
      ...(b.pollingHandler ? {
        setPairingHandler: (h: never) => { b.pollingHandler!.h = h; },
        hasPairingHandler: () => b.pollingHandler!.h !== null,
      } : {}),
    } as never,
    pairingInvites: { flow, handshake: flow, store: {} as never, events: new EventEmitter() } as never,
    topicOperatorStore: b.operators ?? null,
    relationships: null, feedback: null, dispatches: null, updateChecker: null, autoUpdater: null,
    autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null,
    evolution: null, watchdog: null, triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    startTime: new Date(),
  } as never;
}

describe('invite pairing — Telegram routes', () => {
  let tmpDir: string;
  let stateDir: string;
  let fx: Effects;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-telegram-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fx = { topicMessages: [], inboundLogged: 0, adapterCallbacks: [], sent: [], answers: [], flow: [] };
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize(SERVER_VERSION, null);
  });
  afterEach(() => {
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/pairing-invite-telegram-routes.test.ts' });
  });

  const boot = (extra: Record<string, unknown> = {}, b: Boot = {}) => {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(makeContext(stateDir, fx, extra, b)));
    return app;
  };
  const secret = () => ensureLifelineIngressSecret(stateDir);
  const forward = (app: express.Express, text: string, opts: { secret?: string; from?: number; messageId?: number; topicId?: number } = {}) => {
    let r = request(app).post('/internal/telegram-forward').set('Authorization', `Bearer ${AUTH_TOKEN}`);
    if (opts.secret) r = r.set(LIFELINE_SECRET_HEADER, opts.secret);
    return r.send({ topicId: opts.topicId ?? 4242, text, fromUserId: opts.from ?? OWNER, fromFirstName: 'Op', messageId: opts.messageId ?? 1, lifelineVersion: SERVER_VERSION });
  };
  const callback = (app: express.Express, data: string, opts: { secret?: string; id?: string; from?: number } = {}) => {
    let r = request(app).post('/internal/telegram-callback').set('Authorization', `Bearer ${AUTH_TOKEN}`);
    if (opts.secret) r = r.set(LIFELINE_SECRET_HEADER, opts.secret);
    return r.send({ callbackQueryId: opts.id ?? 'cbq-1', data, fromUserId: opts.from ?? OWNER, messageId: 5, chatId: -100 });
  };

  describe('enforce (development agent)', () => {
    const dev = { developmentAgent: true };

    it('the owner forwards an invite: Approve prompt, nothing reaches a session or the log; the tap approves via the engine', async () => {
      const app = boot(dev);
      const res = await forward(app, `Fwd: ${INVITE}`, { secret: secret() });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ pairingInvite: true });
      expect(fx.topicMessages).toEqual([]);
      expect(fx.inboundLogged).toBe(0);
      expect(fx.flow).toEqual(['receive']);
      const prompt = fx.sent.at(-1)!;
      expect(prompt.topicId).toBe(4242);
      expect(prompt.buttons?.map((b) => b.text)).toEqual(['Approve', 'Decline']);
      expect(JSON.stringify(fx.sent)).not.toContain(findInviteToken(INVITE)!.slice(7));

      // A tap without the lifeline secret (e.g. the agent with its Bearer token) is refused at the guard.
      expect((await callback(app, prompt.buttons![0].data, { id: 'cbq-forged' })).status).toBe(401);
      expect(fx.flow).toEqual(['receive']);

      const tap = await callback(app, prompt.buttons![0].data, { secret: secret(), id: 'cbq-2' });
      expect(tap.status).toBe(200);
      expect(fx.flow).toEqual(['receive', `approve:${IID}`]);
      expect(fx.adapterCallbacks).toEqual([]); // never the generic path

      // the same tap delivered twice has one effect
      await callback(app, prompt.buttons![0].data, { secret: secret(), id: 'cbq-2' });
      expect(fx.flow).toEqual(['receive', `approve:${IID}`]);
    });

    it('someone other than the owner forwards an invite: no prompt, the invite still goes nowhere', async () => {
      const app = boot(dev);
      await forward(app, INVITE, { secret: secret(), from: 123 });
      expect(fx.flow).toEqual([]);
      expect(fx.topicMessages).toEqual([]);
      expect(fx.sent.at(-1)?.buttons).toBeUndefined();
      expect(fx.sent.at(-1)?.text).toMatch(/dashboard/);
    });

    it('other callbacks still reach the adapter', async () => {
      const app = boot(dev);
      await forward(app, 'hello', { secret: secret() }); // arms the guard by proof
      expect((await callback(app, 'approve:abc', { secret: secret(), id: 'cbq-9' })).status).toBe(200);
      expect(fx.adapterCallbacks).toEqual(['approve:abc']);
    });
  });

  describe('no owner id configured (Scout: no ownerUserId, no promptGate.ownerId)', () => {
    const dev = { developmentAgent: true };
    const OP = 7812716706;
    const operators = () => new TopicOperatorStore(path.join(stateDir, 'state'));

    it('the verified operator (bound from his own authenticated message) forwards an invite → Approve prompt; his tap approves', async () => {
      const store = operators();
      const app = boot(dev, { owner: undefined, operators: store });
      await forward(app, 'hello', { secret: secret(), from: OP, messageId: 10, topicId: 3 }); // lifeline topic, binds him
      expect(store.getOperator(3)?.uid).toBe(String(OP));
      await forward(app, `Fwd: ${INVITE}`, { secret: secret(), from: OP, messageId: 11, topicId: 3 });
      expect(fx.flow).toEqual(['receive']);
      const prompt = fx.sent.at(-1)!;
      expect(prompt.buttons?.map((b) => b.text)).toEqual(['Approve', 'Decline']);
      await callback(app, prompt.buttons![0].data, { secret: secret(), id: 'cbq-op', from: OP });
      expect(fx.flow).toEqual(['receive', `approve:${IID}`]);
    });

    it('someone else forwards while the verified operator is a different person → "Only the agent\'s owner"', async () => {
      const store = operators();
      const app = boot(dev, { owner: undefined, operators: store });
      await forward(app, 'hello', { secret: secret(), from: OP, messageId: 10, topicId: 3 });
      await forward(app, INVITE, { secret: secret(), from: 555, messageId: 11, topicId: 3 });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NOT_OWNER_REFUSAL);
    });

    it('two different verified operators → nobody is picked; the "no owner set" refusal', async () => {
      const store = operators();
      const app = boot(dev, { owner: undefined, operators: store });
      await forward(app, 'hello', { secret: secret(), from: OP, messageId: 10, topicId: 3 });
      await forward(app, 'hi', { secret: secret(), from: 555, messageId: 11, topicId: 9 });
      await forward(app, INVITE, { secret: secret(), from: OP, messageId: 12, topicId: 3 });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NO_OWNER_REFUSAL);
      expect(fx.sent.at(-1)?.text).toMatch(/dashboard/);
    });

    it('the owner, then a second member who speaks LAST in the owner\'s own topic → "no owner set", for both of them', async () => {
      const store = operators();
      const app = boot(dev, { owner: undefined, operators: store });
      await forward(app, 'hello', { secret: secret(), from: OP, messageId: 10, topicId: 3 });
      await forward(app, 'me too', { secret: secret(), from: 555, messageId: 11, topicId: 3 }); // latest binding is now 555
      expect(store.getOperator(3)?.uid).toBe('555');
      await forward(app, INVITE, { secret: secret(), from: 555, messageId: 12, topicId: 3 });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NO_OWNER_REFUSAL);
      await forward(app, INVITE, { secret: secret(), from: OP, messageId: 13, topicId: 3 });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NO_OWNER_REFUSAL);
    });

    it('a corrupt operator file, then a non-owner member speaks: their invite is refused ("no owner set")', async () => {
      fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'state', 'topic-operators.json'), '{not-json');
      const store = operators();
      const app = boot(dev, { owner: undefined, operators: store });
      await forward(app, 'hello', { secret: secret(), from: 555, messageId: 10, topicId: 3 });
      expect(store.getOperator(3)?.uid).toBe('555');
      await forward(app, INVITE, { secret: secret(), from: 555, messageId: 11, topicId: 3 });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NO_OWNER_REFUSAL);
    });

    it('no binding at all → the "no owner set" refusal, not "Only the agent\'s owner"', async () => {
      const app = boot(dev, { owner: undefined, operators: operators() });
      await forward(app, INVITE, { secret: secret(), from: OP });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NO_OWNER_REFUSAL);
      expect(fx.sent.at(-1)?.text).not.toContain(NOT_OWNER_REFUSAL);
    });

    it('a sender whose message was NOT verified (no lifeline secret) never becomes an operator, so never the owner', async () => {
      // Observe mode delivers an unproven message once the guard has armed, but with the sender's
      // identity stripped: it is read, and binds nobody.
      const store = operators();
      const app = boot({}, { owner: undefined, operators: store });
      await forward(app, 'hello', { secret: secret(), from: OP, messageId: 10, topicId: 3 }); // arms; binds OP
      const res = await forward(app, 'hello, I am the owner now', { from: 555, messageId: 11, topicId: 9 });
      expect(res.status).toBe(200);
      expect(fx.topicMessages).toContain('hello, I am the owner now');
      expect(Object.keys(store.all())).toEqual(['3']);
      expect(resolveApprovalOwner(undefined, Object.values(store.allBindings()), store.everVerifiedOperatorUids())).toBe(OP);

      // Enforce mode refuses the unproven message outright, so it binds nobody either.
      const store2 = new TopicOperatorStore(path.join(stateDir, 'state2'));
      const app2 = boot(dev, { owner: undefined, operators: store2 });
      expect((await forward(app2, 'hi', { from: 555, messageId: 12, topicId: 9 })).status).toBe(401);
      expect(store2.allBindings()).toEqual({});
      await forward(app2, INVITE, { secret: secret(), from: 555, messageId: 13, topicId: 9 });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NO_OWNER_REFUSAL);
    });

    it('a record made through POST /topic-operator (an assertion) never counts as the owner', async () => {
      const store = operators();
      const app = boot(dev, { owner: undefined, operators: store });
      const r = await request(app).post('/topic-operator').set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ topicId: 3, platform: 'telegram', uid: String(OP), displayName: 'Justin' });
      expect(r.status).toBe(200);
      await forward(app, INVITE, { secret: secret(), from: OP, messageId: 11, topicId: 3 });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NO_OWNER_REFUSAL);
    });

    it('a configured owner still wins over a verified operator binding', async () => {
      const store = operators();
      const app = boot(dev, { owner: OWNER, operators: store });
      await forward(app, 'hello', { secret: secret(), from: OP, messageId: 10, topicId: 3 });
      await forward(app, INVITE, { secret: secret(), from: OP, messageId: 11, topicId: 3 });
      expect(fx.flow).toEqual([]);
      expect(fx.sent.at(-1)?.text).toContain(NOT_OWNER_REFUSAL);
      await forward(app, INVITE, { secret: secret(), from: OWNER, messageId: 12, topicId: 3 });
      expect(fx.flow).toEqual(['receive']);
    });

    it('monitoring.promptGate.ownerId counts as a configured owner for pairing', async () => {
      const app = boot({ ...dev, monitoring: { promptGate: { ownerId: OP } } }, { owner: undefined, operators: operators() });
      await forward(app, INVITE, { secret: secret(), from: OP, messageId: 11, topicId: 3 });
      expect(fx.flow).toEqual(['receive']);
    });
  });

  describe('observe (fleet default — every new agent, for its first day or more)', () => {
    // Justin's PP test, 2026-10-21: PP was in observe and got "go to the dashboard". Once the lifeline
    // has proven itself, observe already refuses any tap without the secret, so the buttons are offered.
    it('lifeline proven: an Approve prompt; a tap without the secret is refused; the owner\'s proven tap approves', async () => {
      const app = boot();
      const res = await forward(app, INVITE, { secret: secret() });
      expect(res.status).toBe(200);
      expect(fx.topicMessages).toEqual([]);
      expect(fx.inboundLogged).toBe(0);
      const prompt = fx.sent.at(-1)!;
      expect(prompt.buttons?.map((b) => b.text)).toEqual(['Approve', 'Decline']);
      expect(prompt.text).not.toMatch(/dashboard/);
      expect((await callback(app, prompt.buttons![0].data, { id: 'cbq-forged' })).status).toBe(401);
      expect(fx.flow).toEqual(['receive']);
      expect((await callback(app, prompt.buttons![0].data, { secret: secret(), id: 'cbq-ok' })).status).toBe(200);
      expect(fx.flow).toEqual(['receive', `approve:${IID}`]);
    });
    it('lifeline never proven (no secret on any request): consumed, no prompt, the dashboard pointer', async () => {
      const app = boot();
      const res = await forward(app, INVITE);
      expect(res.status).toBe(200);
      expect(fx.flow).toEqual([]);
      expect(fx.topicMessages).toEqual([]);
      expect(fx.inboundLogged).toBe(0);
      expect(fx.sent.at(-1)?.text).toMatch(/dashboard/);
      // ...and says WHY, with the version, so the owner never has to ask someone to read /health.
      expect(fx.sent.at(-1)?.text).toMatch(/because its Telegram listener has not yet proven itself/);
      expect(fx.sent.at(-1)?.text).toMatch(/\(Instar [^)]+\)/);
    });
    it('the cause goes ONLY to the owner: anyone else who pastes an invite gets the generic line (no version, no setup)', async () => {
      const app = boot();
      await forward(app, INVITE, { from: 555 });
      const text = fx.sent.at(-1)?.text ?? '';
      expect(text).toMatch(/until its listener protection is fully on/);
      expect(text).not.toMatch(/Instar|because/);
    });
    it('a POLLING agent (no lifeline, like PP): routes wires the adapter, which hands invites and taps straight from Telegram → Approve, and the tap approves', async () => {
      const sink: NonNullable<Boot['pollingHandler']> = { h: null };
      boot({}, { polling: true, pollingHandler: sink });
      expect(sink.h).not.toBeNull();
      await sink.h!.onForwardedInvite({ text: `Fwd: ${INVITE}`, topicId: 4242, fromUserId: OWNER, chatId: '-100', verified: true });
      const prompt = fx.sent.at(-1)!;
      expect(prompt.buttons?.map((b) => b.text)).toEqual(['Approve', 'Decline']);
      expect(prompt.text).not.toMatch(/dashboard/);
      // someone else in the group tapping is still refused
      await sink.h!.onCallback({ callbackQueryId: 'cq-x', data: prompt.buttons![0].data, fromUserId: 555, chatId: '-100', verified: true });
      expect(fx.flow).toEqual(['receive']);
      await sink.h!.onCallback({ callbackQueryId: 'cq-ok', data: prompt.buttons![0].data, fromUserId: OWNER, chatId: '-100', verified: true });
      expect(fx.flow).toEqual(['receive', `approve:${IID}`]);
    });
    it('a polling server whose adapter has NO pairing handler (older adapter) says so (owner)', async () => {
      const app = boot({}, { polling: true });
      await forward(app, INVITE, { secret: secret() });
      expect(fx.sent.at(-1)?.text).toMatch(/because this agent reads Telegram directly, not through its listener \(Instar [^)]+\)/);
    });
  });
});
