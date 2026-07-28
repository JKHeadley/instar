/**
 * Integration test: MessageSentinel emergency-stop/pause intercept on the
 * /internal/telegram-forward (lifeline) path.
 *
 * Regression guard for the P0 safety bug where lifeline-owned-polling agents
 * (e.g. echo) never run TelegramAdapter.processUpdate(), so "stop everything"
 * was delivered as a normal message and never halted the session.
 * Spec: docs/specs/emergency-stop-forward-path-wiring.md
 *
 * Covers both sides of every decision boundary:
 *   - emergency-stop → kills the topic's session, does NOT route to session
 *   - pause → pauses the session, does NOT route
 *   - normal → routes normally (no false-positive interception)
 *   - throwing sentinel → FAIL-OPEN: message still routes (delivery never blocked)
 *   - emergency-stop with no live session → acknowledges, does not route
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

const AUTH_TOKEN = 'test-auth-token-deadbeef';
const TOPIC = 11838;
const SESSION = 'test-session-abc';

type SentinelCategory = 'emergency-stop' | 'pause' | 'redirect' | 'normal';

interface Spies {
  killed: string[];
  paused: string[];
  routed: string[];
  sent: string[];
}

function buildContext(
  stateDir: string,
  decideImpl: (msg: string) => Promise<{ disposition: 'kill' | 'pause' | 'route-through'; category: SentinelCategory; reason?: string }>,
  spies: Spies,
  opts: { withSession: boolean } = { withSession: true },
): RouteContext {
  // Persistent topic→session registry (the resolver's primary source).
  if (opts.withSession) {
    fs.writeFileSync(
      path.join(stateDir, 'topic-session-registry.json'),
      JSON.stringify({ topicToSession: { [String(TOPIC)]: SESSION } }),
    );
  }
  return {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {} as never,
      scheduler: {} as never,
    } as never,
    sessionManager: {
      listRunningSessions: () => [],
      killSession: (name: string) => { spies.killed.push(name); return true; },
    } as never,
    sentinel: {
      decideInboundDisposition: decideImpl,
    } as never,
    state: {
      getJobState: () => null,
      getSession: () => null,
      queryEvents: () => [],
    } as never,
    scheduler: null,
    telegram: {
      onTopicMessage: (m: { content: string }) => { spies.routed.push(m.content); },
      logInboundMessage: () => {},
      getSessionForTopic: (_t: number) => (opts.withSession ? SESSION : null),
      onSentinelKillSession: (name: string) => { spies.killed.push(name); return true; },
      onSentinelPauseSession: (name: string) => { spies.paused.push(name); },
      sendToTopic: async (_t: number, msg: string) => { spies.sent.push(msg); },
    } as never,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    discoveryEvaluator: null,
    startTime: new Date(),
  } as never;
}

function makeApp(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

function forward(app: express.Express, text: string): Promise<request.Response> {
  return request(app)
    .post('/internal/telegram-forward')
    .set('Authorization', `Bearer ${AUTH_TOKEN}`)
    .set('Content-Type', 'application/json')
    .send({ topicId: TOPIC, text, fromUserId: 1, fromUsername: 't', fromFirstName: 'T', messageId: 99 });
}

describe('/internal/telegram-forward — sentinel emergency-stop/pause intercept', () => {
  let tmpDir: string;
  let stateDir: string;
  let spies: Spies;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-sentinel-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.2.36', null);
    spies = { killed: [], paused: [], routed: [], sent: [] };
  });

  afterEach(() => {
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'fwd-sentinel-test:cleanup' });
  });

  it('disposition kill → kills the topic session and does NOT route', async () => {
    const ctx = buildContext(stateDir, async () => ({ disposition: 'kill', category: 'emergency-stop', reason: 'exact match: stop' }), spies);
    const res = await forward(makeApp(ctx), 'stop everything');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sentinel: 'emergency-stop', killed: true });
    expect(spies.killed).toContain(SESSION); // session was killed
    expect(spies.routed).toHaveLength(0);    // message was NOT delivered to the session
  });

  it('disposition pause → pauses the session and does NOT route (deterministic pause)', async () => {
    const ctx = buildContext(stateDir, async () => ({ disposition: 'pause', category: 'pause' }), spies);
    const res = await forward(makeApp(ctx), '/pause');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sentinel: 'pause', paused: true });
    expect(spies.paused).toContain(SESSION);
    expect(spies.routed).toHaveLength(0);
  });

  it('OPERATOR-CHANNEL-SACRED: disposition route-through (a non-deterministic/capacity-shed pause) DELIVERS the message, never consumes', async () => {
    // This is the 2026-06-25 lockout fix: a message the classifier would have called
    // 'pause' (but not deterministically) must reach the session, not be eaten.
    const ctx = buildContext(stateDir, async () => ({ disposition: 'route-through', category: 'normal' }), spies);
    const res = await forward(makeApp(ctx), 'Testing');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, forwarded: true });
    expect(spies.routed).toContain('Testing'); // delivered to the agent
    expect(spies.paused).toHaveLength(0);       // NOT consumed as a pause
    expect(spies.sent).not.toContain('Session paused.\n\nSend a message to resume.');
  });

  it('normal message routes to the session (no false-positive interception)', async () => {
    const ctx = buildContext(stateDir, async () => ({ disposition: 'route-through', category: 'normal' }), spies);
    const res = await forward(makeApp(ctx), 'how should we stop the war in the spec?');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, forwarded: true });
    expect(spies.routed).toContain('how should we stop the war in the spec?');
    expect(spies.killed).toHaveLength(0);
  });

  it('FAIL-OPEN: a throwing sentinel never blocks delivery — message still routes', async () => {
    const ctx = buildContext(stateDir, async () => { throw new Error('sentinel boom'); }, spies);
    const res = await forward(makeApp(ctx), 'stop everything');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, forwarded: true });
    expect(spies.routed).toContain('stop everything'); // delivered despite the safety check erroring
    expect(spies.killed).toHaveLength(0);
  });

  it('disposition kill with no live session acknowledges and does not route', async () => {
    const ctx = buildContext(
      stateDir,
      async () => ({ disposition: 'kill', category: 'emergency-stop' }),
      spies,
      { withSession: false },
    );
    const res = await forward(makeApp(ctx), 'stop');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sentinel: 'emergency-stop', killed: false });
    expect(spies.routed).toHaveLength(0);
  });
});

/**
 * Wiring-integrity: the absence of this assertion is exactly what let the
 * original drift through. Assert (structurally) that the forward route's
 * handler classifies via the sentinel before routing — i.e. the source still
 * calls ctx.sentinel.classify on the /internal/telegram-forward path.
 */
describe('/internal/telegram-forward — wiring integrity', () => {
  it('the forward route source decides via ctx.sentinel.decideInboundDisposition before routing', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'server', 'routes.ts'),
      'utf-8',
    );
    const fwdIdx = src.indexOf("router.post('/internal/telegram-forward'");
    expect(fwdIdx).toBeGreaterThan(-1);
    // The onTopicMessage routing call marks "message handed to session".
    const routeIdx = src.indexOf('ctx.telegram.onTopicMessage(message)', fwdIdx);
    const decideIdx = src.indexOf('ctx.sentinel.decideInboundDisposition(', fwdIdx);
    expect(decideIdx).toBeGreaterThan(-1);            // sentinel disposition is consulted on this path
    expect(decideIdx).toBeLessThan(routeIdx);         // ...BEFORE the message is routed (operator-channel-sacred)
  });
});
