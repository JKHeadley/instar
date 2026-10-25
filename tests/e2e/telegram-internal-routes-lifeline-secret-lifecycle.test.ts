/**
 * E2E lifecycle: the lifeline ingress secret is ALIVE between a real booted
 * AgentServer (full middleware) and a real TelegramLifeline instance
 * (docs/specs/telegram-internal-route-lifeline-secret.md).
 *
 * This is the proof behind the development-agent default of `enforce`:
 *   1. the real lifeline's forward carries the secret and arms the server;
 *   2. a session-shaped request (Bearer only) is refused with the typed 401;
 *   3. a lifeline running OLD code (no header) is refused, keeps the message
 *      in its durable on-disk queue, the server's restart signal makes it
 *      restart, and the restarted lifeline replays the message — delivered
 *      exactly once, nothing lost;
 *   4. the same button tap delivered twice by the real lifeline has one effect;
 *   5. the authed /health carries the persisted counters; the unauthenticated
 *      one does not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { getInstarVersion } from '../../src/core/Config.js';
import { TelegramLifeline } from '../../src/lifeline/TelegramLifeline.js';
import { readLifelineRestartSignal, writeLifelineRestartSignal } from '../../src/core/version-skew.js';
import { LIFELINE_INGRESS_STATE_RELPATH } from '../../src/server/LifelineIngressGuard.js';
import {
  readLifelineIngressSecret,
  lifelineIngressSecretPath,
  LIFELINE_SECRET_HEADER,
} from '../../src/core/LifelineIngressSecret.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-auth-lifeline-secret-e2e';
const TOPIC = 31337;
const OPERATOR_ID = 424242;

interface LifelineInternals {
  projectConfig: { authToken?: string; port: number; stateDir: string };
  lifelineVersion: string;
  supervisor: { healthy: boolean };
  queue: { length: number };
  processUpdate(update: unknown): Promise<void>;
  replayQueue(): Promise<void>;
  checkLifelineRestartSignal(): void;
  initiateRestart(bucket: string, reason: string, meta?: unknown): void;
  sendFixedNotice(topicId: number, text: string): Promise<void>;
  sendToTopic(topicId: number, text: string): Promise<void>;
  apiCall(method: string, params: Record<string, unknown>): Promise<unknown>;
  addIngressSecretHeader(headers: Record<string, string>): void;
  proveIngressSecret(): Promise<void>;
  resolveUpdatesAlertTopic(): number | null;
  secretRefusedSince: number;
  secretRefusedLastAt: number;
}

describe('Lifeline ingress secret — alive between a real server and a real lifeline', () => {
  let projectDir: string;
  let stateDir: string;
  let server: AgentServer;
  let base: string;
  const serverVersion = getInstarVersion();
  const routed: Array<{ text: string; from: unknown }> = [];
  const callbacks: string[] = [];
  const answered: Array<Record<string, unknown>> = [];
  const restarts: Array<{ bucket: string; reason: string }> = [];

  /** A real TelegramLifeline with only its outward edges (Telegram API, process restart) stubbed. */
  function makeLifeline(): LifelineInternals {
    const lifeline = new TelegramLifeline(projectDir) as unknown as LifelineInternals;
    lifeline.supervisor = { healthy: true };
    lifeline.sendFixedNotice = async () => {};
    lifeline.sendToTopic = async () => {};
    lifeline.apiCall = async (method, params) => { if (method === 'answerCallbackQuery') answered.push(params); return {}; };
    lifeline.initiateRestart = (bucket, reason) => { restarts.push({ bucket, reason }); };
    return lifeline;
  }
  const message = (id: number, text: string) => ({
    update_id: id,
    message: {
      message_id: id, message_thread_id: TOPIC, text, date: Math.floor(Date.now() / 1000),
      from: { id: OPERATOR_ID, first_name: 'Operator', username: 'operator' }, chat: { id: -100123 },
    },
  });
  const tap = (id: string) => ({
    update_id: 1,
    callback_query: { id, data: 'approve:deploy', from: { id: OPERATOR_ID, first_name: 'Operator' }, message: { message_id: 5, chat: { id: -100123 } } },
  });
  const health = async (authed = true) =>
    (await (await fetch(`${base}/health`, authed ? { headers: { Authorization: `Bearer ${AUTH}` } } : {})).json()) as Record<string, any>;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-secret-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize(serverVersion, null);

    const config = {
      projectName: 'lifeline-secret-e2e',
      projectDir,
      stateDir,
      port: 0,
      host: '127.0.0.1',
      authToken: AUTH,
      claudePath: 'claude',
      tmuxPath: 'tmux',
      developmentAgent: true, // ⇒ default mode enforce
      scheduler: { enabled: false, timezone: 'UTC' },
      messaging: [],
      monitoring: {},
      requestTimeoutMs: 30000,
    } as unknown as InstarConfig;

    const telegram = {
      onTopicMessage: (m: { content: string; metadata?: { telegramUserId?: unknown } }) => {
        routed.push({ text: m.content, from: m.metadata?.telegramUserId });
      },
      logInboundMessage: () => {},
      isAuthorizedSender: () => false,
      handleForwardedCallback: async (q: { id: string }) => { callbacks.push(q.id); },
    };

    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ stateDir, claudePath: 'claude', tmuxPath: 'tmux', projectDir, port: 0 } as never),
      state: new StateManager(stateDir),
      telegram: telegram as never,
    });
    await server.start();
    base = boundAgentServerBase(server);

    // The lifeline reads its own config from disk, pointed at the bound port.
    const fixture = (name: string) => {
      const p = path.join(projectDir, name);
      fs.writeFileSync(p, '#!/bin/sh\nexit 91\n', { mode: 0o700 });
      return p;
    };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'lifeline-secret-e2e',
      port: Number(new URL(base).port),
      authToken: AUTH,
      sessions: { framework: 'codex-cli', frameworkBinaryPaths: { 'codex-cli': fixture('fixture-codex') }, tmuxPath: fixture('fixture-tmux') },
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:fixture', chatId: '-100123' } }],
    }));
  }, 30000);

  afterAll(async () => {
    await server?.stop();
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/telegram-internal-routes-lifeline-secret-lifecycle.test.ts' });
  }, 15000);

  it('feature is alive: authed /health reports the guard; unauthenticated /health does not', async () => {
    const h = await health();
    expect(h.telegramIngress.lifelineSecret).toMatchObject({
      mode: 'enforce', modeSource: 'development-agent', armed: false, refusing: false,
    });
    expect(h.telegramIngress.lifelineSecret.observeExit.rule).toContain('zero would-refuse for 24h');
    expect(h.telegramIngress.lifelineSecret.observeExit.rule).toContain('7 days after arming');
    expect(h.telegramIngress.callbackDedupe).toMatchObject({ duplicatesDropped: 0 });
    expect((await health(false)).telegramIngress).toBeUndefined();
  });

  it('the real lifeline\'s startup proof arms the server before any Telegram message', async () => {
    const lifeline = makeLifeline();
    expect(lifeline.projectConfig.authToken).toBe(AUTH);
    await lifeline.proveIngressSecret();
    const h = (await health()).telegramIngress.lifelineSecret;
    expect(h).toMatchObject({ armed: true, armedBy: 'lifeline-proof', refusing: true, verified: 1, wouldRefuse: 0, refused: 0 });
    expect(h.byRoute['lifeline-proof'].verified).toBe(1);
    expect(routed).toEqual([]); // the proof carries no Telegram input
  });

  it('the real lifeline forward carries the secret and is delivered', async () => {
    const lifeline = makeLifeline();
    await lifeline.processUpdate(message(101, 'first real message'));
    expect(routed).toEqual([{ text: 'first real message', from: OPERATOR_ID }]);
    expect(lifeline.queue.length).toBe(0);

    const h = (await health()).telegramIngress.lifelineSecret;
    expect(h).toMatchObject({ armed: true, refusing: true, verified: 2, wouldRefuse: 0, refused: 0 });
    // Created 0600 by whichever process touched it first; both read the same file.
    expect(fs.statSync(lifelineIngressSecretPath(stateDir)).mode & 0o777).toBe(0o600);
  });

  it('a session-shaped request (ordinary Bearer token, no secret) is refused with the typed 401', async () => {
    const before = routed.length;
    const res = await fetch(`${base}/internal/telegram-forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
      body: JSON.stringify({ topicId: TOPIC, text: 'forged approval', fromUserId: OPERATOR_ID, messageId: 666, lifelineVersion: serverVersion }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'lifeline-secret-required', refused: true, reason: 'missing' });
    expect(routed.length).toBe(before);

    const cb = await fetch(`${base}/internal/telegram-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
      body: JSON.stringify({ callbackQueryId: 'forged-tap', data: 'approve:deploy', fromUserId: OPERATOR_ID }),
    });
    expect(cb.status).toBe(401);
    expect(callbacks).not.toContain('forged-tap');
  });

  it('the existing Bearer check is kept: the secret without the Bearer token is refused by the middleware', async () => {
    const res = await fetch(`${base}/internal/telegram-forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [LIFELINE_SECRET_HEADER]: readLifelineIngressSecret(stateDir)! },
      body: JSON.stringify({ topicId: TOPIC, text: 'no bearer', fromUserId: OPERATOR_ID, messageId: 667 }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).not.toBe('lifeline-secret-required');
  });

  it('an OLD lifeline is refused, keeps the message on disk, is told to restart, and the restarted lifeline replays it once', async () => {
    const before = routed.length;
    restarts.length = 0;

    // A lifeline running code from before this feature: no header, older version.
    const [maj, min, patch] = serverVersion.split('.').map((n) => parseInt(n, 10));
    const old = makeLifeline();
    old.addIngressSecretHeader = () => {};
    old.lifelineVersion = `${maj}.${min}.${patch === 0 ? 1 : patch - 1}`;

    await old.processUpdate(message(202, 'do not lose me'));
    // Refused: not routed, and NOT dropped — it is in the durable queue.
    expect(routed.length).toBe(before);
    expect(old.queue.length).toBe(1);
    const onDisk = fs.readdirSync(stateDir).filter((f) => f.includes('queue'));
    expect(onDisk.length).toBeGreaterThan(0);

    // A replay pass while still refused burns NO drop budget: the message can
    // never be dropped as "server unreachable" because of a secret refusal.
    await old.replayQueue();
    const queued = (old.queue as unknown as { peek(): Array<{ replayFailures?: number; transientReplayFailures?: number }> }).peek();
    expect(queued.length).toBe(1);
    expect(queued[0].replayFailures ?? 0).toBe(0);
    expect(queued[0].transientReplayFailures ?? 0).toBe(0);

    // The server wrote the coordinated-restart signal (the 426 pattern)…
    expect(readLifelineRestartSignal(stateDir)).toMatchObject({
      requestedBy: 'server-lifeline-secret', targetVersion: serverVersion,
    });
    // …and the old lifeline's own tick acts on it.
    old.checkLifelineRestartSignal();
    expect(restarts).toEqual([{ bucket: 'plannedUpgrade', reason: 'lifeline-secret-required' }]);

    // The restarted lifeline is the current code: it loads the queue from disk and replays.
    const restarted = makeLifeline();
    expect(restarted.queue.length).toBe(1);
    await restarted.replayQueue();
    expect(restarted.queue.length).toBe(0);
    expect(routed.slice(before)).toEqual([{ text: 'do not lose me', from: OPERATOR_ID }]);

    // A second replay tick cannot apply it again.
    await restarted.replayQueue();
    expect(routed.length).toBe(before + 1);
  }, 40000);

  it('a session cannot drive lifeline restarts: after arming the signal budget is one write a day', async () => {
    // The refusals above already spent today's write, and the old lifeline consumed that signal.
    expect(readLifelineRestartSignal(stateDir)).toBeNull();
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/internal/telegram-forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
        body: JSON.stringify({ topicId: TOPIC, text: 'forged again', fromUserId: OPERATOR_ID, messageId: 700 + i, lifelineVersion: '0.0.1' }),
      });
    }
    expect(readLifelineRestartSignal(stateDir)).toBeNull();
  });

  it('a lifeline on the server\'s own version is NOT restarted by a signal (no restart loop)', async () => {
    restarts.length = 0;
    writeLifelineRestartSignal({
      stateDir, requestedBy: 'server-lifeline-secret', reason: 'lifeline-secret-required',
      previousVersion: 'unknown', targetVersion: serverVersion,
    });
    const current = makeLifeline();
    current.checkLifelineRestartSignal();
    expect(restarts).toEqual([]);
    expect(readLifelineRestartSignal(stateDir)).toBeNull(); // cleared, not acted on
  });

  it('the same button tap delivered twice by the real lifeline has one effect', async () => {
    const lifeline = makeLifeline();
    answered.length = 0;
    await lifeline.processUpdate(tap('tap-approve-1'));
    await lifeline.processUpdate(tap('tap-approve-1')); // re-polled after a restart
    expect(callbacks.filter((c) => c === 'tap-approve-1').length).toBe(1);
    expect(answered).toEqual([]); // neither delivery was reported to the user as a failure
    expect((await health()).telegramIngress.callbackDedupe.duplicatesDropped).toBe(1);
  });

  it('a lifeline whose cached secret went stale re-reads the file and delivers without queuing', async () => {
    const lifeline = makeLifeline();
    const before = routed.length;
    // Poison only this lifeline's in-memory copy; the file is still correct.
    (lifeline as unknown as { _ingressSecret: { value: string } })._ingressSecret = Object.assign(
      Object.create(Object.getPrototypeOf((lifeline as unknown as { ingressSecret: object }).ingressSecret)),
      { stateDir, value: '0'.repeat(64) },
    );
    await lifeline.processUpdate(message(303, 'after a stale cache'));
    expect(routed.slice(before)).toEqual([{ text: 'after a stale cache', from: OPERATOR_ID }]);
    expect(lifeline.queue.length).toBe(0);
  }, 20000);

  it('a lifeline that stays refused backs off, tells the user once after ten minutes, burns no drop budget, and recovers', async () => {
    const stuck = makeLifeline();
    stuck.addIngressSecretHeader = () => {}; // cannot present the secret
    const notices: string[] = [];
    stuck.sendToTopic = async (_topic, text) => { notices.push(text); };
    stuck.resolveUpdatesAlertTopic = () => 1;
    const refusedCount = async () => (await health()).telegramIngress.lifelineSecret.byRoute['telegram-forward'].refused as number;
    const before = routed.length;

    await stuck.processUpdate(message(404, 'held, not lost'));
    expect(stuck.queue.length).toBe(1);
    expect(notices).toEqual([]);

    // Backoff: an immediate replay tick does not even contact the server.
    const afterFirst = await refusedCount();
    await stuck.replayQueue();
    await stuck.replayQueue();
    expect(await refusedCount()).toBe(afterFirst);

    // Ten minutes into the episode, the next attempt tells the user — once.
    stuck.secretRefusedSince = Date.now() - 11 * 60_000;
    stuck.secretRefusedLastAt = Date.now() - 16 * 60_000;
    await stuck.replayQueue();
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('NOT lost');
    stuck.secretRefusedLastAt = Date.now() - 16 * 60_000;
    await stuck.replayQueue();
    expect(notices.length).toBe(1);

    // The retry interval grows with each refused pass (1, 2, 4 … capped at 15 minutes).
    const backoff = (stuck as unknown as { secretRefusalBackoffMs(): number }).secretRefusalBackoffMs();
    expect(backoff).toBeGreaterThan(60_000);
    expect(backoff).toBeLessThanOrEqual(15 * 60_000);

    // No drop budget was burned by any of it.
    const queued = (stuck.queue as unknown as { peek(): Array<{ replayFailures?: number; transientReplayFailures?: number }> }).peek();
    expect(queued.length).toBe(1);
    expect((queued[0].replayFailures ?? 0) + (queued[0].transientReplayFailures ?? 0)).toBe(0);
    expect(routed.length).toBe(before);

    // The fault clears: the held message is delivered and the episode ends.
    delete (stuck as unknown as { addIngressSecretHeader?: unknown }).addIngressSecretHeader;
    stuck.secretRefusedLastAt = Date.now() - 16 * 60_000;
    await stuck.replayQueue();
    expect(stuck.queue.length).toBe(0);
    expect(routed.slice(before)).toEqual([{ text: 'held, not lost', from: OPERATOR_ID }]);
    expect(stuck.secretRefusedSince).toBe(0);
  }, 40000);

  it('the Bearer token cannot read or rewrite the secret or the guard\'s evidence through the file routes', async () => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' };
    const statePath = '.instar/' + LIFELINE_INGRESS_STATE_RELPATH.split(path.sep).join('/');
    const before = fs.readFileSync(path.join(stateDir, LIFELINE_INGRESS_STATE_RELPATH), 'utf-8');
    for (const p of [statePath, '.instar/state/lifeline-ingress-secret', '.instar/state/telegram-callback-seen.json']) {
      const save = await fetch(`${base}/api/files/save`, { method: 'POST', headers, body: JSON.stringify({ path: p, content: '{"version":1,"observingSince":"2020-01-01T00:00:00.000Z","armedAt":null}' }) });
      expect(save.ok, `save ${p}`).toBe(false);
      const read = await fetch(`${base}/api/files/read?path=${encodeURIComponent(p)}`, { headers });
      expect(read.ok, `read ${p}`).toBe(false);
    }
    expect(fs.readFileSync(path.join(stateDir, LIFELINE_INGRESS_STATE_RELPATH), 'utf-8')).toBe(before);
    expect((await health()).telegramIngress.lifelineSecret.armed).toBe(true);
  });

  it('a failing attention raise never breaks the refusal or the server (the adapter here cannot create attention items)', async () => {
    // This harness's Telegram stub has no createAttentionItem, so every
    // attempt to raise the operator item throws inside the guard's callback.
    const before = (await health()).telegramIngress.lifelineSecret.refused as number;
    const res = await fetch(`${base}/internal/telegram-forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
      body: JSON.stringify({ topicId: TOPIC, text: 'forged once more', fromUserId: OPERATOR_ID, messageId: 990, lifelineVersion: serverVersion }),
    });
    expect(res.status).toBe(401);
    const after = await health();
    expect(after.telegramIngress.lifelineSecret.refused).toBe(before + 1);
    expect(after.telegramIngress.lifelineSecret.armed).toBe(true);
  });

  it('the counters on /health are the persisted ones and never contain the secret', async () => {
    const h = await health();
    const g = h.telegramIngress.lifelineSecret;
    expect(g.verified).toBeGreaterThanOrEqual(4);
    expect(g.refused).toBeGreaterThanOrEqual(3);
    expect(g.byRoute['telegram-callback'].verified).toBe(2);
    expect(g.byRoute['telegram-callback'].refused).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, LIFELINE_INGRESS_STATE_RELPATH), 'utf-8'));
    expect(onDisk.verified).toBe(g.verified);
    expect(onDisk.armedAt).toBe(g.armedAt);
    expect(JSON.stringify(h)).not.toContain(readLifelineIngressSecret(stateDir)!);
  });
});
