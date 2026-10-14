/**
 * Integration: invite pairing through the real /internal/telegram-forward and
 * /internal/telegram-callback routes (docs/specs/a2a-pairing-invite-link.md §6.1).
 *
 * - A forwarded message carrying an invite never reaches a session or the inbound log.
 * - Enforce + lifeline secret + owner: an Approve prompt; the tap approves through the engine,
 *   never through the adapter's generic callback path.
 * - Observe mode, or no secret, or not the owner: no prompt, a pointer to the dashboard.
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

function makeContext(stateDir: string, fx: Effects, extra: Record<string, unknown>): RouteContext {
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
      isPolling: false,
      onTopicMessage: (m: { content: string }) => { fx.topicMessages.push(m.content); },
      logInboundMessage: () => { fx.inboundLogged++; },
      dispatchAgentMessageHook: async () => false,
      isAuthorizedSender: () => true,
      handleForwardedCallback: async (q: { data: string }) => { fx.adapterCallbacks.push(q.data); },
      sendToTopic: async (topicId: number, text: string) => { fx.sent.push({ topicId, text }); return {}; },
      sendPairingPrompt: async (topicId: number, text: string, buttons: Array<{ text: string; data: string }>) => { fx.sent.push({ topicId, text, buttons }); return 1; },
      answerCallback: async (_id: unknown, text: string) => { fx.answers.push(text); },
      getOwnerUserId: () => OWNER,
      getChatId: () => '-100',
      getLifelineTopicId: () => 3,
    } as never,
    pairingInvites: { flow, store: {} as never, events: new EventEmitter() } as never,
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

  const boot = (extra: Record<string, unknown> = {}) => {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(makeContext(stateDir, fx, extra)));
    return app;
  };
  const secret = () => ensureLifelineIngressSecret(stateDir);
  const forward = (app: express.Express, text: string, opts: { secret?: string; from?: number; messageId?: number } = {}) => {
    let r = request(app).post('/internal/telegram-forward').set('Authorization', `Bearer ${AUTH_TOKEN}`);
    if (opts.secret) r = r.set(LIFELINE_SECRET_HEADER, opts.secret);
    return r.send({ topicId: 4242, text, fromUserId: opts.from ?? OWNER, fromFirstName: 'Op', messageId: opts.messageId ?? 1, lifelineVersion: SERVER_VERSION });
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

  describe('observe (fleet default)', () => {
    it('an invite is consumed but opens no prompt: Telegram approval is off', async () => {
      const app = boot();
      const res = await forward(app, INVITE, { secret: secret() });
      expect(res.status).toBe(200);
      expect(fx.flow).toEqual([]);
      expect(fx.topicMessages).toEqual([]);
      expect(fx.inboundLogged).toBe(0);
      expect(fx.sent.at(-1)?.text).toMatch(/dashboard/);
    });
  });
});
