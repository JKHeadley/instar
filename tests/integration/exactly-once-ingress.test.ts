/**
 * Integration: the exactly-once ingress gate on /internal/telegram-forward
 * (spec §8 G3a), through the REAL route handler (createRoutes) + a REAL
 * MessageProcessingLedger, with a fake Telegram adapter for routing.
 *
 * Both sides of every boundary:
 *   - flag dark (no ledger) → every forward routes (byte-for-byte old behavior)
 *   - first forward → routes + claims the event (processing)
 *   - duplicate while in flight → DROPPED (not routed), ok+deduped
 *   - duplicate after the reply committed → DROPPED (already-replied)
 *   - FAIL-OPEN: a ledger that throws never blocks delivery
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { dedupeKeyFor, decideIngress, commitInboundReply } from '../../src/messaging/ingressDedup.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-auth-token-deadbeef';
const TOPIC = 13481;

interface Spies { routed: string[]; }

function buildContext(
  stateDir: string,
  ledger: MessageProcessingLedger | null,
  spies: Spies,
): RouteContext {
  return {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      authToken: AUTH,
      multiMachine: { maxProcessingMs: 5 * 60_000 },
    } as never,
    sessionManager: {
      listRunningSessions: () => [],
      clearInjectionTracker: () => {},
    } as never,
    sentinel: undefined,
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] } as never,
    scheduler: null,
    telegram: {
      onTopicMessage: (m: { content: string }) => { spies.routed.push(m.content); },
      logInboundMessage: () => {},
    } as never,
    coordinator: { getLeaseEpoch: () => 1 } as never,
    messageLedger: ledger,
    currentInboundByTopic: ledger ? new Map<string, string>() : null,
    relationships: null, feedback: null, dispatches: null, updateChecker: null,
    autoUpdater: null, autoDispatcher: null, quotaTracker: null, publisher: null,
    viewer: null, tunnel: null, evolution: null, watchdog: null, triageNurse: null,
    topicMemory: null, discoveryEvaluator: null,
    startTime: new Date(),
  } as never;
}

function app(ctx: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/', createRoutes(ctx));
  return a;
}

function forward(a: express.Express, messageId: number, text = 'hello'): Promise<request.Response> {
  return request(a)
    .post('/internal/telegram-forward')
    .set('Authorization', `Bearer ${AUTH}`)
    .send({ topicId: TOPIC, text, fromUserId: 1, fromUsername: 't', fromFirstName: 'T', messageId });
}

describe('/internal/telegram-forward — exactly-once ingress gate', () => {
  let tmpDir: string;
  let stateDir: string;
  let spies: Spies;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exactly-once-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.3.19', null);
    spies = { routed: [] };
  });

  afterEach(() => {
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'exactly-once-test:cleanup' });
  });

  it('DARK (no ledger): every forward routes — unchanged behavior', async () => {
    const a = app(buildContext(stateDir, null, spies));
    expect((await forward(a, 1)).body).toMatchObject({ ok: true, forwarded: true });
    expect((await forward(a, 1)).body).toMatchObject({ ok: true, forwarded: true });
    expect(spies.routed).toHaveLength(2); // both delivered (no dedup when dark)
  });

  it('first forward routes + claims; a rapid duplicate is DROPPED (in-flight)', async () => {
    const led = MessageProcessingLedger.openMemory();
    const a = app(buildContext(stateDir, led, spies));

    const r1 = await forward(a, 42);
    expect(r1.body).toMatchObject({ ok: true, forwarded: true });
    expect(spies.routed).toEqual(['hello']);
    expect(led.get(dedupeKeyFor('telegram', TOPIC, 42))!.state).toBe('processing');

    const r2 = await forward(a, 42); // same messageId → duplicate while still processing
    expect(r2.body).toMatchObject({ ok: true, deduped: true, reason: 'in-flight' });
    expect(spies.routed).toEqual(['hello']); // NOT routed a second time
  });

  it('a duplicate AFTER the reply committed is DROPPED (already-replied)', async () => {
    const led = MessageProcessingLedger.openMemory();
    // Pre-seed: the event was received + replied (as the outbound path would).
    const key = dedupeKeyFor('telegram', TOPIC, 77);
    decideIngress(led, key, { platform: 'telegram', topic: String(TOPIC), epoch: 1, maxProcessingMs: 300_000 });
    commitInboundReply(led, key, 1);

    const a = app(buildContext(stateDir, led, spies));
    const r = await forward(a, 77);
    expect(r.body).toMatchObject({ ok: true, deduped: true, reason: 'already-replied' });
    expect(spies.routed).toHaveLength(0); // never re-delivered
  });

  it('FAIL-OPEN: a throwing ledger never blocks delivery', async () => {
    const throwingLedger = {
      record: () => { throw new Error('ledger boom'); },
      get: () => null,
    } as unknown as MessageProcessingLedger;
    const a = app(buildContext(stateDir, throwingLedger, spies));
    const r = await forward(a, 5);
    expect(r.body).toMatchObject({ ok: true, forwarded: true }); // delivered despite gate error
    expect(spies.routed).toEqual(['hello']);
  });
});

/**
 * Wiring-integrity: the gate must sit BEFORE routing and AFTER the sentinel
 * intercept on the forward path (a duplicate must be dropped before it reaches
 * the session, but emergency-stop must never be deduped away).
 */
describe('/internal/telegram-forward — exactly-once wiring integrity', () => {
  it('the dedup gate is between the sentinel intercept and the routing call', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server', 'routes.ts'), 'utf-8');
    const fwdIdx = src.indexOf("router.post('/internal/telegram-forward'");
    // operator-channel-sacred (topic 28130): the forward path now decides the
    // inbound disposition via decideInboundDisposition (which consults the
    // sentinel) instead of the old raw `sentinel.classify` — the dedup gate
    // must still sit AFTER that decision so an emergency-stop is never deduped.
    const sentinelIdx = src.indexOf('ctx.sentinel.decideInboundDisposition(', fwdIdx);
    const gateIdx = src.indexOf('decideIngress(ctx.messageLedger', fwdIdx);
    const routeIdx = src.indexOf('ctx.telegram.onTopicMessage(message)', fwdIdx);
    expect(sentinelIdx).toBeGreaterThan(-1);       // sentinel disposition is on the forward path
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(sentinelIdx);  // gate AFTER sentinel (stop never deduped)
    expect(gateIdx).toBeLessThan(routeIdx);        // gate BEFORE routing (dup never reaches session)
  });
});
