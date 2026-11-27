/**
 * Integration (Tier 2) — notify-on-stop Layer B through the REAL
 * /internal/stop-gate/evaluate route (createRoutes), narrowed 2026-11-01 after
 * the Lifeline noise bug: a shadow `continue` on a session whose topic has a LIVE
 * autonomous run is sent to THAT topic, naming the run and its last message; an
 * `escalate` (the gate's "not sure") is log-only; a stall with no live run is
 * log-only.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { StopGateDb } from '../../src/core/StopGateDb.js';
import { UnjustifiedStopGate } from '../../src/core/UnjustifiedStopGate.js';
import { setMode, _resetForTests } from '../../src/server/stopGate.js';
import { StopNotifier } from '../../src/monitoring/StopNotifier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const SESSION = 'sess-named-run';
const TOPIC = '4242';

const CONTINUE = JSON.stringify({
  decision: 'continue',
  rule: 'U2_PLAN_FILE_NEXT_STEP_EXPLICIT',
  evidence_pointer: { plan_file: 'docs/plan.md' },
  rationale: 'plan lists the next step',
});
const ESCALATE = JSON.stringify({
  decision: 'escalate',
  rule: 'U_AMBIGUOUS_INSUFFICIENT_SIGNAL',
  evidence_pointer: {},
  rationale: 'unclear',
});

const BODY = {
  sessionId: SESSION,
  evidenceMetadata: {
    artifacts: [{ path: 'docs/plan.md', introducingCommit: null, latestCommit: null, createdThisSession: false, modifiedThisSession: false }],
    signals: {},
    sessionStartTs: 1,
  },
  untrustedContent: { stopReason: 'end_turn', recentTurns: [{ source: 'agent', text: 'Tests are running; I will check back.' }] },
};

let root = '';
let stateDir = '';
let db: StopGateDb | null = null;
let server: Server | null = null;
let sent: Array<{ topicId: string; sessionId: string; text: string }> = [];
let logged: Array<{ sessionId: string; detail: string }> = [];

beforeEach(() => {
  _resetForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-notify-named-run-'));
  stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'topic-session-registry.json'),
    JSON.stringify({ topicToSession: { [TOPIC]: 'echo-named-run' } }),
  );
  sent = [];
  logged = [];
});
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
  server = null;
  db?.close();
  db = null;
  _resetForTests();
  SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/stop-notify-named-run-route.test.ts:cleanup' });
});

function writeRun(active: boolean): void {
  fs.writeFileSync(
    path.join(stateDir, 'autonomous', `${TOPIC}.local.md`),
    `---\nactive: ${active}\ngoal: "Fix the Lifeline noise bug"\nreport_topic: "${TOPIC}"\n---\n`,
  );
}

async function boot(verdict: string): Promise<string> {
  db = new StopGateDb({ dbPath: path.join(root, 'stop-gate.db') });
  const intelligence: IntelligenceProvider = { evaluate: async () => verdict };
  const gate = new UnjustifiedStopGate({ intelligence, breakerStateStore: db, breakerKey: 'named-run' });
  const stopNotifier = new StopNotifier({
    notifyTopic: (topicId, sessionId, text) => sent.push({ topicId, sessionId, text }),
    log: (_kind, sessionId, detail) => logged.push({ sessionId, detail }),
  });
  const sessionManager = {
    getCachedRunningSessions: () => ({ sessions: [{ claudeSessionId: SESSION, tmuxSession: 'echo-named-run' }] }),
  };
  const app = express();
  app.use(express.json());
  app.use(authMiddleware('test-token', 'test-agent'));
  app.use(createRoutes({
    config: { authToken: 'test-token', stateDir, projectDir: root, projectName: 'echo', port: 0, developmentAgent: false },
    stateDir,
    startTime: new Date(),
    sessionManager,
    unjustifiedStopGate: gate,
    stopGateDb: db,
    stopNotifier,
  } as any));
  server = app.listen(0);
  await new Promise<void>(r => server!.once('listening', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function post(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/internal/stop-gate/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(BODY),
  });
  return await res.json() as Record<string, unknown>;
}

describe('notify-on-stop Layer B — named run, own topic (real evaluate route)', () => {
  it("a shadow continue on a live autonomous run is sent to the run's topic, naming the run and its last message", async () => {
    writeRun(true);
    const url = await boot(CONTINUE);
    setMode('shadow');
    const json = await post(url);
    expect(json.decision).toBe('continue');
    expect(sent).toHaveLength(1);
    expect(sent[0].topicId).toBe(TOPIC);
    expect(sent[0].sessionId).toBe(SESSION);
    expect(sent[0].text).toContain('Fix the Lifeline noise bug');
    expect(sent[0].text).toContain('Tests are running; I will check back.');
    expect(sent[0].text).not.toContain('end_turn'); // a harness stop code is never quoted as the message
  });

  it('an escalate on the same live run is log-only', async () => {
    writeRun(true);
    const url = await boot(ESCALATE);
    setMode('shadow');
    const json = await post(url);
    expect(json.decision).toBe('escalate');
    expect(sent).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0].sessionId).toBe(SESSION);
  });

  it('a shadow continue whose run file says active: false sends nothing', async () => {
    writeRun(false);
    const url = await boot(CONTINUE);
    setMode('shadow');
    await post(url);
    expect(sent).toHaveLength(0);
  });
});
