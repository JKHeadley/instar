/**
 * Wiring-integrity tests — Self-Violation Signal (observe-only seam).
 *
 * The single most important structural guarantee of this feature: the outbound
 * self-violation hook is OBSERVE-ONLY. The user's explicit hard rule is that a
 * guard must NEVER block, delay, or rewrite an outbound message. These tests pin
 * that the seam:
 *   1. delivers the message UNCHANGED whether or not a violation is detected
 *      (the reply returns ok=true and the adapter received the EXACT text);
 *   2. is fail-open: a detector failure path (no ledger / bad state) never
 *      blocks or errors delivery;
 *   3. records to the CorrectionLedger ONLY when enabled + the sub-flag is on +
 *      a preference carries a violationPattern (dark by default).
 *
 * It exercises the REAL production seam via AgentServer.getApp() → the
 * /telegram/reply route → checkOutboundMessage → observeSelfViolation. A minimal
 * telegram stub captures the delivered text so we can assert byte-for-byte
 * pass-through.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'sv-wiring-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

interface Built {
  dir: string;
  server: AgentServer;
  delivered: Array<{ topicId: number; text: string }>;
}

/** Minimal telegram stub — captures delivered text for pass-through assertions. */
function telegramStub(delivered: Array<{ topicId: number; text: string }>): any {
  return {
    onMessageLogged: null,
    async sendToTopic(topicId: number, text: string) {
      delivered.push({ topicId, text });
      return {};
    },
    getSessionForTopic: () => null,
    isSessionAlive: () => true,
  };
}

function build(opts: { enabled?: boolean; selfViolationSignal?: boolean }): Built {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-wire-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
  const delivered: Array<{ topicId: number; text: string }> = [];
  const monitoring = opts.enabled
    ? { correctionLearning: { enabled: true, selfViolationSignal: opts.selfViolationSignal ?? false } }
    : {};
  const config: InstarConfig = {
    projectName: 'sv-wire', agentName: 'Wiring', projectDir: dir,
    stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
    ...(opts.enabled ? { monitoring } : {}),
  } as InstarConfig;
  // The reply route calls clearInjectionTracker on a successful (non-proxy) send;
  // the shared mock doesn't define it, so augment the stub here.
  const sm = createMockSessionManager() as any;
  sm.clearInjectionTracker = () => {};
  const server = new AgentServer({
    config,
    sessionManager: sm,
    state: new StateManager(path.join(dir, '.instar')),
    telegram: telegramStub(delivered),
  });
  return { dir, server, delivered };
}

/** Seed a preference carrying a violationPattern so the seam has something to check. */
function seedViolatingPref(dir: string): void {
  const mgr = new PreferencesManager(path.join(dir, '.instar'));
  mgr.recordPreference({
    learning: "don't defer work to a fresh session — there is no tail of a session",
    dedupeKey: 'user-preference:fresh',
    confidence: 0.9,
    violationPattern: 'regex:fresh session|pick this up later',
  });
}

describe('Self-Violation Signal — observe-only wiring integrity', () => {
  let built: Built | null = null;
  afterEach(() => {
    if (built) {
      SafeFsExecutor.safeRmSync(built.dir, { recursive: true, force: true, operation: 'sv-wire' });
      built = null;
    }
  });

  it('delivers a VIOLATING message UNCHANGED (never blocked) AND records the self-violation', async () => {
    built = build({ enabled: true, selfViolationSignal: true });
    seedViolatingPref(built.dir);
    const violating = "I'll start a fresh session for this so the context stays clean.";

    const res = await request(built.server.getApp())
      .post('/telegram/reply/777')
      .set(auth())
      .send({ text: violating });

    // The message is DELIVERED, not blocked (no 422), and byte-for-byte intact.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(built.delivered).toHaveLength(1);
    expect(built.delivered[0].text).toBe(violating); // pass-through unchanged

    // The self-violation was recorded (the SIGNAL) — observable via /corrections.
    // The observe call is fire-and-forget; poll briefly for the async record.
    let recorded = false;
    for (let i = 0; i < 20 && !recorded; i++) {
      const list = await request(built.server.getApp()).get('/corrections').set(auth());
      if (list.status === 200 && list.body.records.length > 0) recorded = true;
      else await new Promise((r) => setTimeout(r, 25));
    }
    expect(recorded).toBe(true);
  });

  it('delivers a CLEAN message unchanged AND records nothing', async () => {
    built = build({ enabled: true, selfViolationSignal: true });
    seedViolatingPref(built.dir);
    const clean = "On it — building the fix now and I'll report back when it's merged.";

    const res = await request(built.server.getApp())
      .post('/telegram/reply/778')
      .set(auth())
      .send({ text: clean });

    expect(res.status).toBe(200);
    expect(built.delivered[0].text).toBe(clean);

    // Give the (no-op) observe path a beat, then assert nothing was recorded.
    await new Promise((r) => setTimeout(r, 100));
    const list = await request(built.server.getApp()).get('/corrections').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.records).toHaveLength(0);
  });

  it('DARK when the sub-flag is off: a violating message delivers unchanged and records nothing', async () => {
    built = build({ enabled: true, selfViolationSignal: false });
    seedViolatingPref(built.dir);
    const violating = "Let me pick this up later in a fresh session.";

    const res = await request(built.server.getApp())
      .post('/telegram/reply/779')
      .set(auth())
      .send({ text: violating });

    expect(res.status).toBe(200);
    expect(built.delivered[0].text).toBe(violating);

    await new Promise((r) => setTimeout(r, 100));
    const list = await request(built.server.getApp()).get('/corrections').set(auth());
    // Ledger exists (correctionLearning enabled) but the sub-flag is off → no record.
    expect(list.status).toBe(200);
    expect(list.body.records).toHaveLength(0);
  });

  it('FAIL-OPEN: with NO preferences on disk a violating message still delivers unchanged', async () => {
    // No seedViolatingPref → manager.read() returns empty → detector no-ops.
    built = build({ enabled: true, selfViolationSignal: true });
    const violating = "Starting a fresh session here.";

    const res = await request(built.server.getApp())
      .post('/telegram/reply/780')
      .set(auth())
      .send({ text: violating });

    expect(res.status).toBe(200);
    expect(built.delivered[0].text).toBe(violating);

    await new Promise((r) => setTimeout(r, 100));
    const list = await request(built.server.getApp()).get('/corrections').set(auth());
    expect(list.body.records).toHaveLength(0);
  });

  it('feature fully OFF (correctionLearning disabled): violating message delivers; /corrections 503', async () => {
    built = build({ enabled: false });
    const violating = "I'll pick this up later in a fresh session.";

    const res = await request(built.server.getApp())
      .post('/telegram/reply/781')
      .set(auth())
      .send({ text: violating });

    expect(res.status).toBe(200);
    expect(built.delivered[0].text).toBe(violating);

    const list = await request(built.server.getApp()).get('/corrections').set(auth());
    expect(list.status).toBe(503);
  });
});
