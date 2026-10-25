/**
 * Integration: the real `POST /internal/telegram-forward` and
 * `POST /internal/telegram-callback` routes (createRoutes) with the lifeline
 * ingress secret (docs/specs/telegram-internal-route-lifeline-secret.md).
 *
 * Covers the full HTTP pipeline on both agent classes:
 *   - observe (fleet default): a message is accepted + counted, counters
 *     persisted; once armed it is delivered WITHOUT sender trust (no operator
 *     auto-bind) and an unproven tap is refused;
 *   - enforce (development agent): armed only by proof; then a typed 401, the
 *     lifeline-restart signal, and NO side effect of the refused request;
 *   - the startup-proof route; the stale-secret hint; the file routes refuse
 *     the guard's files;
 *   - replay: a refused message forwarded again with the secret is applied once;
 *   - callbacks: the same tap delivered twice has one effect, also across a
 *     server restart, also when the first delivery was refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  ensureLifelineIngressSecret,
  LIFELINE_SECRET_HEADER,
  LIFELINE_INGRESS_CALLER_HEADER,
  LIFELINE_INGRESS_CALLER_SERVER_SELF,
} from '../../src/core/LifelineIngressSecret.js';
import { LIFELINE_INGRESS_STATE_RELPATH } from '../../src/server/LifelineIngressGuard.js';
import { readLifelineRestartSignal } from '../../src/core/version-skew.js';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';

const AUTH_TOKEN = 'test-auth-token-lifeline-secret';
const SERVER_VERSION = '1.3.500';
const OPERATOR_ID = 777001;

interface Effects {
  topicMessages: Array<{ fromUserId: unknown; text: string; userId?: unknown; firstName?: unknown; username?: unknown; senderUnverified?: unknown }>;
  inboundLog: Array<{ telegramUserId?: unknown; fromUser?: unknown }>;
  a2aHook: Array<{ senderIsBot?: unknown; senderBotId?: unknown }>;
  inboundLogged: number;
  authorizedSenderChecks: unknown[];
  operatorBinds: Array<{ topicId: number; uid: string }>;
  callbacks: Array<{ id: string; data: string; fromId: unknown }>;
}

function makeContext(stateDir: string, effects: Effects, extra: Record<string, unknown> = {}): RouteContext {
  return {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {} as never,
      scheduler: {} as never,
      ...extra,
    } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] } as never,
    scheduler: null,
    telegram: {
      onTopicMessage: (m: { content: string; userId?: unknown; metadata?: Record<string, unknown> }) => {
        effects.topicMessages.push({
          fromUserId: m.metadata?.telegramUserId, text: m.content, userId: m.userId,
          firstName: m.metadata?.firstName, username: m.metadata?.username, senderUnverified: m.metadata?.senderUnverified,
        });
      },
      logInboundMessage: (row: { telegramUserId?: unknown; fromUser?: unknown }) => { effects.inboundLogged++; effects.inboundLog.push(row); },
      dispatchAgentMessageHook: async (a: { senderIsBot?: unknown; senderBotId?: unknown }) => { effects.a2aHook.push(a); return false; },
      isAuthorizedSender: (id: unknown) => { effects.authorizedSenderChecks.push(id); return true; },
      handleForwardedCallback: async (q: { id: string; data: string; from: { id: unknown } }) => {
        effects.callbacks.push({ id: q.id, data: q.data, fromId: q.from.id });
      },
    } as never,
    topicOperatorStore: {
      setAuthenticatedOperator: (topicId: number, op: { uid: string }) => { effects.operatorBinds.push({ topicId, uid: op.uid }); },
    } as never,
    relationships: null, feedback: null, dispatches: null, updateChecker: null, autoUpdater: null,
    autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null,
    evolution: null, watchdog: null, triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    startTime: new Date(),
  } as never;
}

describe('internal Telegram routes — lifeline ingress secret', () => {
  let tmpDir: string;
  let stateDir: string;
  let effects: Effects;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-secret-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    effects = { topicMessages: [], inboundLog: [], a2aHook: [], inboundLogged: 0, authorizedSenderChecks: [], operatorBinds: [], callbacks: [] };
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize(SERVER_VERSION, null);
  });
  afterEach(() => {
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/telegram-internal-routes-lifeline-secret.test.ts' });
  });

  /** Boot (or "restart") the server's routes over the same state dir. */
  const boot = (extra: Record<string, unknown> = {}) => {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(makeContext(stateDir, effects, extra)));
    return app;
  };
  const secret = () => ensureLifelineIngressSecret(stateDir);
  const persisted = () => JSON.parse(fs.readFileSync(path.join(stateDir, LIFELINE_INGRESS_STATE_RELPATH), 'utf-8'));

  const forward = (app: express.Express, opts: { secret?: string | null; messageId?: number; headers?: Record<string, string>; lifelineVersion?: string } = {}) => {
    let r = request(app).post('/internal/telegram-forward').set('Authorization', `Bearer ${AUTH_TOKEN}`);
    if (opts.secret) r = r.set(LIFELINE_SECRET_HEADER, opts.secret);
    for (const [k, v] of Object.entries(opts.headers ?? {})) r = r.set(k, v);
    return r.send({
      topicId: 4242, text: 'approve the deploy', fromUserId: OPERATOR_ID, fromUsername: 'operator',
      fromFirstName: 'Operator', messageId: opts.messageId ?? 9001, timestamp: new Date().toISOString(),
      lifelineVersion: opts.lifelineVersion ?? SERVER_VERSION,
    });
  };
  const proof = (app: express.Express, withSecret: string | null = null) => {
    let r = request(app).post('/internal/lifeline-proof').set('Authorization', `Bearer ${AUTH_TOKEN}`);
    if (withSecret) r = r.set(LIFELINE_SECRET_HEADER, withSecret);
    return r.send({ lifelineVersion: SERVER_VERSION });
  };
  const callback = (app: express.Express, opts: { secret?: string | null; id?: string | number | object } = {}) => {
    let r = request(app).post('/internal/telegram-callback').set('Authorization', `Bearer ${AUTH_TOKEN}`);
    if (opts.secret) r = r.set(LIFELINE_SECRET_HEADER, opts.secret);
    return r.send({ callbackQueryId: opts.id ?? 'cbq-1', data: 'approve:abc', fromUserId: OPERATOR_ID, messageId: 55, chatId: -100 });
  };

  describe('observe (fleet default)', () => {
    it('accepts a forward with no secret, routes it, and counts a would-refuse', async () => {
      const app = boot();
      const res = await forward(app);
      expect(res.status).toBe(200);
      expect(effects.topicMessages.length).toBe(1);
      const s = persisted();
      expect(s.wouldRefuse).toBe(1);
      expect(s.refused).toBe(0);
      expect(s.byReason.missing).toBe(1);
      expect(s.byRoute['telegram-forward'].wouldRefuse).toBe(1);
    });

    it('accepts a callback with no secret and counts it on the callback route', async () => {
      const app = boot();
      expect((await callback(app)).status).toBe(200);
      expect(effects.callbacks.length).toBe(1);
      expect(persisted().byRoute['telegram-callback'].wouldRefuse).toBe(1);
    });

    it('before arming, an unproven message binds the operator as it always did (the pre-change lifeline)', async () => {
      const app = boot();
      expect((await forward(app, { messageId: 1 })).status).toBe(200);
      expect(effects.operatorBinds).toEqual([{ topicId: 4242, uid: String(OPERATOR_ID) }]);
    });

    it('after arming, an unproven MESSAGE is still delivered — but binds no operator', async () => {
      const app = boot();
      expect((await proof(app, secret())).body).toMatchObject({ ok: true, verified: true, mode: 'observe' });
      const res = await forward(app, { messageId: 2 });
      expect(res.status).toBe(200);
      expect(effects.topicMessages.length).toBe(1); // delivered
      expect(effects.operatorBinds).toEqual([]);     // not evidence of who sent it
      expect(effects.authorizedSenderChecks).toEqual([]);
      expect(persisted()).toMatchObject({ wouldRefuse: 1, refused: 0 });
    });

    it('…and EVERY identity claim in the body is removed before anything can read it', async () => {
      const app = boot();
      await proof(app, secret());
      const res = await request(app).post('/internal/telegram-forward').set('Authorization', `Bearer ${AUTH_TOKEN}`).send({
        topicId: 4242, text: 'ratify deferral', fromUserId: OPERATOR_ID, fromUsername: 'operator', fromFirstName: 'Operator',
        messageId: 77, senderIsBot: true, senderBotId: '999', senderChatId: '-100999', forwarded: false,
      });
      expect(res.status).toBe(200);
      // The message pipeline sees no sender id, an explicit flag, and a neutral name.
      expect(effects.topicMessages).toEqual([{
        fromUserId: undefined, text: 'ratify deferral', userId: 'unknown',
        firstName: 'Unverified sender', username: undefined, senderUnverified: true,
      }]);
      // The inbound log row (standing-authorization evidence) carries no operator uid.
      expect(effects.inboundLog.length).toBe(1);
      expect(effects.inboundLog[0].telegramUserId).toBeUndefined();
      expect(JSON.stringify(effects.inboundLog[0])).not.toContain(String(OPERATOR_ID));
      // The agent-to-agent hook cannot be told "a bot sent this".
      expect(effects.a2aHook.length).toBe(1);
      expect(effects.a2aHook[0].senderIsBot).toBe(false);
      expect(effects.a2aHook[0].senderBotId).toBeUndefined();
    });

    it('an unproven message cannot pre-claim a real message\'s id in the exactly-once ledger', async () => {
      const app = express();
      app.use(express.json());
      const ctx = makeContext(stateDir, effects);
      (ctx as unknown as { messageLedger: MessageProcessingLedger }).messageLedger = MessageProcessingLedger.openMemory();
      (ctx as unknown as { currentInboundByTopic: Map<string, string> }).currentInboundByTopic = new Map();
      app.use('/', createRoutes(ctx));
      await proof(app, secret());
      // A session guesses the next Telegram message id and posts it first.
      expect((await forward(app, { messageId: 5001 })).body).toMatchObject({ ok: true, forwarded: true });
      // The operator's real message with that id still gets through.
      const real = await forward(app, { secret: secret(), messageId: 5001 });
      expect(real.body).toMatchObject({ ok: true, forwarded: true });
      expect(real.body.deduped).toBeUndefined();
      expect(effects.topicMessages.map((m) => m.fromUserId)).toEqual([undefined, OPERATOR_ID]);
      // …and a genuine redelivery of the real one is still deduped as before.
      expect((await forward(app, { secret: secret(), messageId: 5001 })).body).toMatchObject({ ok: true, deduped: true });
    });

    it('a PROVEN message keeps its identity', async () => {
      const app = boot();
      await proof(app, secret());
      await forward(app, { secret: secret(), messageId: 78 });
      expect(effects.topicMessages[0]).toMatchObject({ fromUserId: OPERATOR_ID, userId: String(OPERATOR_ID), firstName: 'Operator', senderUnverified: undefined });
      expect(effects.inboundLog[0].telegramUserId).toBe(OPERATOR_ID);
    });

    it('after arming, a proven message binds the operator', async () => {
      const app = boot();
      await proof(app, secret());
      await forward(app, { secret: secret(), messageId: 3 });
      expect(effects.operatorBinds).toEqual([{ topicId: 4242, uid: String(OPERATOR_ID) }]);
    });

    it('after arming, an unproven TAP is refused even in observe (a tap is nothing but a privileged act)', async () => {
      const app = boot();
      await proof(app, secret());
      const res = await callback(app, { id: 'cbq-forged' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: 'lifeline-secret-required', refused: true, reason: 'missing' });
      expect(effects.callbacks).toEqual([]);
    });

    it('a wrong secret is accepted with the stale hint, so a current lifeline re-reads its file', async () => {
      const app = boot();
      const res = await forward(app, { secret: 'e'.repeat(64) });
      expect(res.status).toBe(200);
      expect(res.headers['x-instar-lifeline-secret-stale']).toBe('1');
      expect((await forward(app, { secret: secret(), messageId: 5 })).headers['x-instar-lifeline-secret-stale']).toBeUndefined();
    });

    it('the counters survive a server restart', async () => {
      await forward(boot(), { messageId: 1 });
      await forward(boot(), { secret: secret(), messageId: 2 });
      await callback(boot(), { id: 'cbq-x' }); // armed by now: an unproven tap is refused
      expect(persisted()).toMatchObject({ verified: 1, wouldRefuse: 1, refused: 1 });
    });

    it('nudges an old lifeline forward by writing the restart signal', async () => {
      await forward(boot(), { lifelineVersion: '1.3.400' });
      const signal = readLifelineRestartSignal(stateDir);
      expect(signal).toMatchObject({
        requestedBy: 'server-lifeline-secret', reason: 'lifeline-secret-required',
        previousVersion: '1.3.400', targetVersion: SERVER_VERSION,
      });
    });
  });

  describe('enforce (development agent default)', () => {
    const dev = { developmentAgent: true };

    it('does not refuse a lifeline that has never proven itself (the rollout case)', async () => {
      const app = boot(dev);
      const res = await forward(app, { lifelineVersion: '1.3.400' });
      expect(res.status).toBe(200);
      expect(effects.topicMessages.length).toBe(1);
      expect(persisted()).toMatchObject({ armedAt: null, wouldRefuse: 1, refused: 0 });
    });

    it('once armed, refuses a forged forward with the typed 401 and no side effect', async () => {
      const app = boot(dev);
      expect((await forward(app, { secret: secret(), messageId: 1 })).status).toBe(200);
      const before = { ...effects, topicMessages: [...effects.topicMessages], authorizedSenderChecks: [...effects.authorizedSenderChecks] };

      const res = await forward(app, { messageId: 2 });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: 'lifeline-secret-required', refused: true, reason: 'missing' });
      // The forged request reached nothing: no routing, no inbound log, and
      // above all no operator auto-bind lookup for the claimed sender id.
      expect(effects.topicMessages).toEqual(before.topicMessages);
      expect(effects.inboundLogged).toBe(before.inboundLogged);
      expect(effects.authorizedSenderChecks).toEqual(before.authorizedSenderChecks);
      expect(persisted()).toMatchObject({ refused: 1 });
    });

    it('a wrong secret is refused with reason mismatch', async () => {
      const app = boot(dev);
      await forward(app, { secret: secret(), messageId: 1 });
      const res = await forward(app, { secret: 'e'.repeat(64), messageId: 2 });
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('mismatch');
    });

    it('a refusal writes the lifeline-restart signal (the 426 pattern)', async () => {
      const app = boot(dev);
      await forward(app, { secret: secret(), messageId: 1 });
      await forward(app, { messageId: 2, lifelineVersion: '1.3.400' });
      expect(readLifelineRestartSignal(stateDir)).toMatchObject({
        requestedBy: 'server-lifeline-secret', previousVersion: '1.3.400', targetVersion: SERVER_VERSION,
      });
    });

    it('a refused message replayed with the secret is applied exactly once', async () => {
      const app = boot(dev);
      await forward(app, { secret: secret(), messageId: 1 });
      const n = effects.topicMessages.length;
      const logged = effects.inboundLogged;

      expect((await forward(app, { messageId: 77 })).status).toBe(401); // refused: zero effect
      expect(effects.topicMessages.length).toBe(n);
      expect((await forward(app, { secret: secret(), messageId: 77 })).status).toBe(200); // the replay
      expect(effects.topicMessages.length).toBe(n + 1);
      expect(effects.inboundLogged).toBe(logged + 1);
    });

    it('arming survives a restart: the restarted server refuses at once', async () => {
      await forward(boot(dev), { secret: secret(), messageId: 1 });
      expect((await forward(boot(dev), { messageId: 2 })).status).toBe(401);
    });

    it('the server\'s own re-injection call is accepted and does not arm', async () => {
      const app = boot(dev);
      const res = await forward(app, {
        secret: secret(), headers: { [LIFELINE_INGRESS_CALLER_HEADER]: LIFELINE_INGRESS_CALLER_SERVER_SELF },
      });
      expect(res.status).toBe(200);
      expect(persisted()).toMatchObject({ armedAt: null, verifiedServerSelf: 1 });
    });

    it('the startup proof arms the guard without any Telegram message', async () => {
      const app = boot(dev);
      expect((await proof(app)).body).toMatchObject({ ok: true, verified: false }); // unarmed: accepted, proves nothing
      expect(persisted().armedAt).toBeNull();
      expect((await proof(app, secret())).body).toEqual({ ok: true, verified: true, mode: 'enforce' });
      expect(persisted()).toMatchObject({ armedBy: 'lifeline-proof' });
      expect((await forward(app)).status).toBe(401);
      expect((await proof(app)).status).toBe(401); // and the proof route itself now requires it
    });

    it('Telegram configured but the adapter absent is UNKNOWN: it waits for proof instead of arming', async () => {
      const app = express();
      app.use(express.json());
      const ctx = makeContext(stateDir, effects, { ...dev, messaging: [{ type: 'telegram', enabled: true, config: {} }] });
      (ctx as unknown as { telegram: null }).telegram = null;
      app.use('/', createRoutes(ctx));
      expect((await proof(app)).body).toMatchObject({ ok: true, verified: false });
      expect(persisted().armedAt).toBeNull();
    });

    it('Telegram not configured at all: no lifeline can exist, so it arms at once', async () => {
      const app = express();
      app.use(express.json());
      const ctx = makeContext(stateDir, effects, { ...dev, messaging: [] });
      (ctx as unknown as { telegram: null }).telegram = null;
      app.use('/', createRoutes(ctx));
      expect((await forward(app)).status).toBe(401);
      expect(persisted()).toMatchObject({ armedBy: 'no-lifeline-ingress' });
    });

    it('bypass is the full rollback: armed and enforcing, yet nothing is refused and identity is kept', async () => {
      const app = boot({ ...dev, telegramIngress: { lifelineSecret: { bypass: true } } });
      await proof(app, secret());
      expect((await forward(app, { messageId: 5 })).status).toBe(200);
      expect((await callback(app, { id: 'cbq-bypass' })).status).toBe(200);
      expect(effects.topicMessages[0]).toMatchObject({ fromUserId: OPERATOR_ID });
      expect(effects.callbacks.map((c) => c.id)).toEqual(['cbq-bypass']);
    });

    it('where the server polls Telegram itself there is no lifeline to wait for: refused at once', async () => {
      const app = express();
      app.use(express.json());
      const ctx = makeContext(stateDir, effects, dev);
      (ctx.telegram as unknown as { isPolling: boolean }).isPolling = true;
      app.use('/', createRoutes(ctx));
      expect((await forward(app)).status).toBe(401);
      expect(persisted()).toMatchObject({ armedBy: 'no-lifeline-ingress' });
    });

    it('explicit enforce:false is the rollback: nothing is refused', async () => {
      const app = boot({ ...dev, telegramIngress: { lifelineSecret: { enforce: false } } });
      await forward(app, { secret: secret(), messageId: 1 });
      expect((await forward(app, { messageId: 2 })).status).toBe(200);
    });

    it('explicit enforce:true on a fleet agent refuses once armed', async () => {
      const app = boot({ telegramIngress: { lifelineSecret: { enforce: true } } });
      await forward(app, { secret: secret(), messageId: 1 });
      expect((await forward(app, { messageId: 2 })).status).toBe(401);
    });

    it('once armed, refuses a forged button tap and does not process it', async () => {
      const app = boot(dev);
      await callback(app, { secret: secret(), id: 'cbq-real' });
      const res = await callback(app, { id: 'cbq-forged' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: 'lifeline-secret-required', refused: true, reason: 'missing' });
      expect(effects.callbacks.map((c) => c.id)).toEqual(['cbq-real']);
    });

    it('a tap is refused with 503 while the server cannot read its own secret; a message is delivered untrusted', async () => {
      // A directory where the secret file should be: the server can neither read nor create it.
      fs.mkdirSync(path.join(stateDir, 'state', 'lifeline-ingress-secret'), { recursive: true });
      const app = boot(dev);
      const tap = await callback(app, { id: 'cbq-unverifiable' });
      expect(tap.status).toBe(503);
      expect(tap.body).toEqual({ ok: false, error: 'lifeline-secret-unavailable', refused: true });
      expect(effects.callbacks).toEqual([]);
      const msg = await forward(app);
      expect(msg.status).toBe(200);
      expect(effects.topicMessages.length).toBe(1);
      expect(effects.operatorBinds).toEqual([]);
    });
  });

  describe('a button tap has one effect', () => {
    it('the same callback delivered twice is processed once', async () => {
      const app = boot();
      const first = await callback(app, { secret: secret(), id: 'cbq-dup' });
      const second = await callback(app, { secret: secret(), id: 'cbq-dup' });
      expect(first.body).toEqual({ ok: true });
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ ok: true, deduped: true });
      expect(effects.callbacks.length).toBe(1);
    });

    it('…also when a server restart falls between the two deliveries', async () => {
      await callback(boot(), { secret: secret(), id: 'cbq-restart' });
      const second = await callback(boot(), { secret: secret(), id: 'cbq-restart' });
      expect(second.body).toEqual({ ok: true, deduped: true });
      expect(effects.callbacks.length).toBe(1);
    });

    it('refused, then retried with the secret, then redelivered: still one effect', async () => {
      const app = boot({ developmentAgent: true });
      await callback(app, { secret: secret(), id: 'cbq-arm' });
      effects.callbacks.length = 0;

      expect((await callback(app, { id: 'cbq-approve' })).status).toBe(401); // refused: not claimed
      expect(effects.callbacks.length).toBe(0);
      expect((await callback(app, { secret: secret(), id: 'cbq-approve' })).body).toEqual({ ok: true });
      expect((await callback(app, { secret: secret(), id: 'cbq-approve' })).body).toEqual({ ok: true, deduped: true });
      expect(effects.callbacks.length).toBe(1);
    });

    it('a callback id that is not a string or a number is rejected before anything else', async () => {
      const app = boot();
      const res = await callback(app, { secret: secret(), id: { toString: 'x' } });
      expect(res.status).toBe(400);
      expect(effects.callbacks).toEqual([]);
    });

    it('unproven taps (only possible before arming) cannot fill or evict the durable claim store', async () => {
      const app = boot();
      for (let i = 0; i < 5; i++) await callback(app, { id: `junk-${i}` });
      expect(effects.callbacks.length).toBe(5);
      expect(fs.existsSync(path.join(stateDir, 'state', 'telegram-callback-seen.json'))).toBe(false);
      // …and they are still deduped among themselves.
      expect((await callback(app, { id: 'junk-0' })).body).toEqual({ ok: true, deduped: true });
    });

    it('a tap accepted unproven before arming, then re-polled and delivered proven, is still applied once', async () => {
      const app = boot();
      expect((await callback(app, { id: 'cbq-straddle' })).body).toEqual({ ok: true }); // pre-change lifeline
      await proof(app, secret());                                                       // lifeline restarted, now proves
      expect((await callback(app, { secret: secret(), id: 'cbq-straddle' })).body).toEqual({ ok: true, deduped: true });
      expect(effects.callbacks.map((c) => c.id)).toEqual(['cbq-straddle']);
    });

    it('two different taps are both processed', async () => {
      const app = boot();
      await callback(app, { secret: secret(), id: 'cbq-a' });
      await callback(app, { secret: secret(), id: 'cbq-b' });
      expect(effects.callbacks.map((c) => c.id)).toEqual(['cbq-a', 'cbq-b']);
    });

    it('a tap whose handler threw is not applied again on redelivery', async () => {
      const ctxEffects = effects;
      const app = express();
      app.use(express.json());
      const ctx = makeContext(stateDir, ctxEffects);
      let calls = 0;
      (ctx.telegram as unknown as { handleForwardedCallback: () => Promise<void> }).handleForwardedCallback = async () => {
        calls++;
        throw new Error('half-applied');
      };
      app.use('/', createRoutes(ctx));
      expect((await callback(app, { secret: secret(), id: 'cbq-throw' })).status).toBe(500);
      // Not re-applied — and not reported as success either (a refusal stays a refusal).
      const again = await callback(app, { secret: secret(), id: 'cbq-throw' });
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ ok: false, deduped: true, error: 'callback-previously-failed' });
      expect(calls).toBe(1);
    });
  });
});
