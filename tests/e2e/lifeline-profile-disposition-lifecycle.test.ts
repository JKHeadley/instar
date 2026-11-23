/** Real HTTP route and real lifeline consumer; only the handler and outward Telegram send are isolated. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { getInstarVersion } from '../../src/core/Config.js';
import { TelegramLifeline, readForwardAcknowledgment } from '../../src/lifeline/TelegramLifeline.js';
import { markProfileControlHandled, markProfileControlPassed, profileInboundDisposition } from '../../src/core/profileInboundDisposition.js';
import type { InstarConfig } from '../../src/core/types.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
const TOPIC = 31337;
const OWNER = 424242;
const AUTH = 'profile-disposition-fixture';
describe('profile-control disposition across HTTP and lifeline', () => {
  let projectDir: string; let stateDir: string; let server: AgentServer; let base: string;
  let markControl = false; let routed = 0; let pauseOrdinary = false; let finishOrdinary: (() => void) | undefined;
  const notices: string[] = [];
  let lifeline: any;
  let trustedContext: RouteContext;
  let rejectOrdinary = false;
  let neverReachProfileStage = false;
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-disposition-'));
    stateDir = path.join(projectDir, '.instar'); fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    ProcessIntegrity.reset(); ProcessIntegrity.initialize(getInstarVersion(), null);
    const config = { projectName: 'profile-disposition', projectDir, stateDir, port: 0, host: '127.0.0.1', authToken: AUTH,
      claudePath: 'claude', tmuxPath: 'tmux', developmentAgent: true, scheduler: { enabled: false, timezone: 'UTC' }, messaging: [], monitoring: {}, requestTimeoutMs: 30000 } as unknown as InstarConfig;
    const telegram = {
      onTopicMessage: async (message: object) => {
        routed++; await Promise.resolve();
        if (neverReachProfileStage) await new Promise<void>(() => {});
        if (markControl) markProfileControlHandled(message);
        else markProfileControlPassed(message);
        if (pauseOrdinary) await new Promise<void>(done => { finishOrdinary = done; });
        if (rejectOrdinary) throw new Error('trusted-routing-failure');
      },
      logInboundMessage: () => {}, isAuthorizedSender: () => true, dispatchAgentMessageHook: async () => false,
    };
    server = new AgentServer({ config, sessionManager: new SessionManager({ stateDir, claudePath: 'claude', tmuxPath: 'tmux', projectDir, port: 0 } as never), state: new StateManager(stateDir), telegram: telegram as never });
    await server.start(); base = boundAgentServerBase(server);
    // This is the exact in-process ingress door used after paired App authentication.
    trustedContext = { config, telegram, startTime: new Date(), scheduler: null,
      state: new StateManager(stateDir), sessionManager: { listRunningSessions: () => [], killSession: () => true } } as unknown as RouteContext;
    createRoutes(trustedContext);
    const fixture = (name: string) => { const p = path.join(projectDir, name); fs.writeFileSync(p, '#!/bin/sh\nexit 91\n', { mode: 0o700 }); return p; };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'profile-disposition', port: Number(new URL(base).port), authToken: AUTH,
      sessions: { framework: 'codex-cli', frameworkBinaryPaths: { 'codex-cli': fixture('codex') }, tmuxPath: fixture('tmux') },
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:fixture', chatId: '-100123' } }] }));
    lifeline = new TelegramLifeline(projectDir) as any;
    lifeline.supervisor = { healthy: true };
    lifeline.sendFixedNotice = async (_topic: number, text: string) => { notices.push(text); };
    lifeline.sendToTopic = async () => {};
    lifeline.apiCall = async () => ({});
    lifeline.initiateRestart = () => {};
  }, 30000);
  afterAll(async () => {
    await server?.stop(); ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/lifeline-profile-disposition-lifecycle.test.ts' });
  }, 15000);
  const message = (id: number, text: string) => ({ update_id: id, message: { message_id: id, message_thread_id: TOPIC, text,
    date: Math.floor(Date.now() / 1000), from: { id: OWNER, first_name: 'Operator' }, chat: { id: -100123 }, reply_to_message: { message_id: 10 } } });
  it('does not let serialized fields or a clone mint the server disposition', () => {
    const original = { content: 'yes', disposition: 'profile-control-handled', metadata: { profileControlHandled: true } };
    expect(profileInboundDisposition(original)).toBeUndefined();
    markProfileControlHandled(original); expect(profileInboundDisposition(original)).toBe('profile-control-handled');
    expect(profileInboundDisposition({ ...original })).toBeUndefined();
  });
  it('returns the typed receipt from the actual route only after its same-object handler marks it', async () => {
    markControl = true; const ack: Record<string, unknown> = {};
    expect(await lifeline.forwardToServer(TOPIC, 'yes', message(101, 'yes').message, ack, [])).toBe(true);
    expect(ack.disposition).toBe('profile-control-handled');
    markControl = false;
    const headers: Record<string, string> = { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' };
    lifeline.addIngressSecretHeader(headers);
    const response = await fetch(`${base}/internal/telegram-forward`, { method: 'POST', headers,
      body: JSON.stringify({ topicId: TOPIC, text: 'yes', messageId: 102, fromUserId: OWNER, lifelineVersion: getInstarVersion(), disposition: 'profile-control-handled', metadata: { profileControlHandled: true } }) });
    expect(response.ok).toBe(true);
    expect((await response.json()).disposition).toBeUndefined();
  });
  it('suppresses the real lifeline checkmark only for the explicit consumed-control receipt, even with identical text', async () => {
    notices.length = 0; markControl = true;
    await lifeline.processUpdate(message(103, 'yes'));
    expect(notices).not.toContain('✓ Delivered');
    markControl = false;
    await lifeline.processUpdate(message(104, 'yes'));
    expect(notices.filter(x => x === '✓ Delivered')).toHaveLength(1);
    expect(routed).toBeGreaterThanOrEqual(4);
  });
  it('responds after ordinary profile pass without awaiting a paused cold-start handler', async () => {
    markControl = false; pauseOrdinary = true;
    const ack: Record<string, unknown> = {};
    try {
      expect(await lifeline.forwardToServer(TOPIC, 'start ordinary work', message(105, 'start ordinary work').message, ack, [])).toBe(true);
      expect(finishOrdinary).toBeTypeOf('function'); expect(ack.disposition).toBeUndefined();
    } finally { pauseOrdinary = false; finishOrdinary?.(); }
  });
  it('returns an ordinary HTTP forward even if asynchronous privacy/routing never reaches the profile stage', async () => {
    markControl = false; neverReachProfileStage = true;
    const headers: Record<string, string> = { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' };
    lifeline.addIngressSecretHeader(headers);
    try {
      const response = await fetch(`${base}/internal/telegram-forward`, { method: 'POST', headers,
        signal: AbortSignal.timeout(5000), body: JSON.stringify({ topicId: TOPIC, text: 'Please research the garden project',
          messageId: 108, fromUserId: OWNER, lifelineVersion: getInstarVersion() }) });
      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({ ok: true, forwarded: true });
    } finally { neverReachProfileStage = false; }
  });
  function trustedCall(id: number) {
    const response = { body: undefined as unknown, statusCode: 200, headers: {} as Record<string, unknown>,
      setHeader(key: string, value: unknown) { this.headers[key] = value; },
      status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; },
      app: { locals: { stateDir } } };
    const request = { body: { topicId: TOPIC, text: 'ordinary App work', messageId: id, fromUserId: OWNER, lifelineVersion: getInstarVersion() },
      headers: {}, query: {}, params: {}, socket: { remoteAddress: '127.0.0.1' } };
    return { response, run: () => trustedContext.mobileInbound!.ingest(request, response, { deviceId: 'paired-fixture-device', eventId: `event-${id}` }) };
  }
  it('keeps paired App acceptance pending after profile pass until the full routing callback resolves', async () => {
    markControl = false; pauseOrdinary = true; finishOrdinary = undefined;
    const call = trustedCall(106); let settled = false;
    const pending = call.run().then(() => { settled = true; });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const check = () => finishOrdinary ? resolve() : Date.now() >= deadline ? reject(Error('handler-not-entered')) : setTimeout(check, 1);
        check();
      });
      expect(settled).toBe(false); expect(call.response.body).toBeUndefined();
      pauseOrdinary = false; finishOrdinary!(); await pending;
      expect(call.response.body).toMatchObject({ ok: true, forwarded: true });
    } finally { pauseOrdinary = false; finishOrdinary?.(); await pending; }
  });
  it('propagates paired App callback rejection after profile pass instead of claiming routing acceptance', async () => {
    markControl = false; rejectOrdinary = true;
    const call = trustedCall(107);
    try {
      await expect(call.run()).rejects.toThrow('trusted-routing-failure');
      expect(call.response.body).toBeUndefined();
    } finally { rejectOrdinary = false; }
  });
  it('accepts only the exact typed response while preserving refusal and old-server compatibility', async () => {
    expect(await readForwardAcknowledgment({ json: async () => ({ disposition: true, profileControlHandled: true }) })).toEqual({});
    expect(await readForwardAcknowledgment({ json: async () => ({ refused: true }) })).toEqual({ refused: true });
    expect(await readForwardAcknowledgment({ json: async () => ({ ok: true, forwarded: true }) })).toEqual({});
  });
});
