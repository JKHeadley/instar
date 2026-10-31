/**
 * Native hook events — integration tier: the full HTTP pipeline through the
 * REAL AgentServer (guard + parser mounted ahead of the global parser, auth,
 * createRoutes, the bounded drain, the real HookEventReceiver and
 * SubagentTracker). Spec: docs/specs/native-hook-events.md.
 *
 * Acceptance criteria covered:
 *   2  (integration half) real Claude Code event bodies for all 7 events are
 *      stored with their real names and only the schema's fields; no
 *      tool_response is stored.
 *   3a session-id bridge over HTTP, including after a respawn.
 *   4  the dashboard summary (GET /sessions telemetry) for a tmux session name
 *      returns its events.
 *   4a after a respawn under the same tmux name an old incarnation's
 *      TaskCompleted does not make taskCompleted true; after a server restart
 *      the index is rebuilt and the lookup still resolves.
 *   5a no stored event contains raw command text or a tool_response; GET of a
 *      hook-events path through the file viewer is refused; with a 3 MB body,
 *      an empty token / empty session header gets 204, a wrong token 401, a
 *      forwarded-header request 403 — and in all three nothing is parsed or
 *      dispatched.
 *   5b a malformed allowed field is dropped and counted, not stored; 5,000
 *      events posted faster than they can be stored leave at most 1,000
 *      pending and count the overflow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { createFileRoutes } from '../../src/server/fileRoutes.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

const TOKEN = 'native-hooks-it-token';
const CS = '9a9a9a9a-0000-4000-8000-00000000000a';
const TMUX = 'nh-it-topic-1';

interface Rig {
  root: string;
  stateDir: string;
  state: StateManager;
  receiver: HookEventReceiver;
  tracker: SubagentTracker;
  server: AgentServer;
  app: express.Express;
  setClaude: Array<[string, string]>;
}

function buildConfig(root: string, stateDir: string): InstarConfig {
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'nh-it' }));
  return {
    projectName: 'nh-it', projectDir: root, stateDir, port: 0, authToken: TOKEN,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
}

function saveRunning(state: StateManager, id: string, tmux = TMUX): void {
  for (const s of state.listSessions({ status: 'running' })) {
    if (s.tmuxSession === tmux && s.id !== id) state.saveSession({ ...s, status: 'completed' });
  }
  state.saveSession({ id, name: tmux, status: 'running', tmuxSession: tmux, startedAt: new Date().toISOString() } as Session);
}

async function boot(root?: string): Promise<Rig> {
  root = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-it-'));
  const stateDir = path.join(root, '.instar');
  const config = buildConfig(root, stateDir);
  const state = new StateManager(stateDir);
  const receiver = new HookEventReceiver({
    stateDir,
    resolveCurrentInstarSessionId: (t) => state.listSessions({ status: 'running' }).find(s => s.tmuxSession === t)?.id ?? null,
    isLiveInstarSession: (id) => state.listSessions({ status: 'running' }).some(s => s.id === id),
  });
  const tracker = new SubagentTracker({ stateDir });
  const setClaude: Array<[string, string]> = [];
  const sessionManager = {
    listRunningSessions: () => state.listSessions({ status: 'running' }),
    getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
    getSession: () => null,
    getSessionById: (id: string) => state.listSessions({ status: 'running' }).find(s => s.id === id),
    setClaudeSessionId: (inc: string, cs: string) => {
      setClaude.push([inc, cs]);
      const s = state.listSessions({ status: 'running' }).find(x => x.id === inc);
      if (s) state.saveSession({ ...s, claudeSessionId: cs });
    },
  };
  const server = new AgentServer({ config, sessionManager: sessionManager as never, state, hookEventReceiver: receiver, subagentTracker: tracker });
  await server.start();
  return { root, stateDir, state, receiver, tracker, server, app: server.getApp(), setClaude };
}

function headers(inc: string, tmux = TMUX): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'X-Instar-Session-Id': inc, 'X-Instar-Session': tmux, 'X-Instar-AgentId': 'nh-it' };
}

async function post(app: express.Express, body: unknown, h: Record<string, string>) {
  let r = request(app).post('/hooks/native-events');
  for (const [k, v] of Object.entries(h)) r = r.set(k, v);
  return r.send(body as object);
}

async function drained(rig: Rig): Promise<void> {
  for (let i = 0; i < 200 && rig.server.nativeHookIngest.pending > 0; i++) await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

/** Real Claude Code 2.1.310 hook bodies (shape as delivered to an http hook). */
function realBodies(): Array<Record<string, unknown>> {
  const base = { session_id: CS, transcript_path: '/home/u/.claude/projects/-p/' + CS + '.jsonl', cwd: '/home/u/proj', permission_mode: 'bypassPermissions' };
  return [
    { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "do not store me"', description: 'commit' }, tool_response: { stdout: 'OUTPUT-NEVER-STORED', stderr: '', interrupted: false, isImage: false }, tool_use_id: 'toolu_01' },
    { ...base, hook_event_name: 'SubagentStart', agent_id: 'agent-77', agent_type: 'Explore' },
    { ...base, hook_event_name: 'SubagentStop', agent_id: 'agent-77', agent_type: 'Explore', agent_transcript_path: '/home/u/.claude/projects/-p/' + CS + '/subagents/agent-77.jsonl', last_assistant_message: 'Found the three call sites.', stop_hook_active: false },
    { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'All done.' },
    { ...base, hook_event_name: 'TaskCompleted', task_id: 'task-1', task_subject: 'Wire the native route', task_description: 'long description never stored' },
    { ...base, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: '' },
    { ...base, hook_event_name: 'SessionEnd', reason: 'other' },
  ];
}

const ALLOWED_KEYS = new Set(['event', 'session_id', 'instar_session_id', 'instar_session', 'tool_name', 'cwd', 'file_path', 'transcript_path', 'agent_type', 'agent_id', 'agent_transcript_path', 'last_assistant_message', 'task_id', 'task_subject', 'reason', 'trigger', 'is_git_commit']);

describe('POST /hooks/native-events — real AgentServer pipeline', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await boot();
    saveRunning(rig.state, 'inc-1');
  });
  afterEach(async () => {
    await rig.server.stop();
  });

  it('criterion 2 + 5a: all 7 real event bodies answer 204 and are stored with real names and only schema fields', async () => {
    for (const body of realBodies()) {
      const res = await post(rig.app, body, headers('inc-1'));
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    }
    await drained(rig);
    const events = rig.receiver.getSessionEvents(CS);
    expect(events.map(e => e.payload.event)).toEqual(['PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'TaskCompleted', 'PreCompact', 'SessionEnd']);
    for (const e of events) {
      for (const k of Object.keys(e.payload)) expect(ALLOWED_KEYS.has(k), `stored key ${k}`).toBe(true);
      expect(e.payload.instar_session_id).toBe('inc-1');
    }
    const file = fs.readFileSync(path.join(rig.stateDir, 'hook-events', `${CS}.jsonl`), 'utf8');
    expect(file).not.toContain('tool_response');
    expect(file).not.toContain('OUTPUT-NEVER-STORED');
    expect(file).not.toContain('do not store me');
    expect(file).not.toContain('task_description');
    expect(events[0].payload.is_git_commit).toBe(true);
    // Subagent pair reached the tracker with its transcript path.
    const rec = rig.tracker.getSessionRecords(CS)[0];
    expect(rec.transcriptPath).toContain('agent-77.jsonl');
    // Counters on the authenticated /health.
    const health = await request(rig.app).get('/health').set('Authorization', `Bearer ${TOKEN}`);
    expect(health.body.hookEvents).toMatchObject({ admitted: 7, stored: 7, failedProcessing: 0, malformedEvents: 0 });
    // Unauthenticated /health does not leak them.
    expect((await request(rig.app).get('/health')).body.hookEvents).toBeUndefined();
  });

  it('criterion 3a: the native header feeds the session-id bridge, including after a respawn', async () => {
    await post(rig.app, { hook_event_name: 'Stop', session_id: CS }, headers('inc-1'));
    await drained(rig);
    expect(rig.state.listSessions({ status: 'running' }).find(s => s.id === 'inc-1')?.claudeSessionId).toBe(CS);
    saveRunning(rig.state, 'inc-2');
    const rotated = '9b9b9b9b-0000-4000-8000-00000000000b';
    await post(rig.app, { hook_event_name: 'PostToolUse', session_id: rotated, tool_name: 'Read', tool_input: { file_path: '/p/a' } }, headers('inc-2'));
    await drained(rig);
    expect(rig.state.listSessions({ status: 'running' }).find(s => s.id === 'inc-2')?.claudeSessionId).toBe(rotated);
    // The old route still feeds the same bridge through the same function.
    saveRunning(rig.state, 'inc-3');
    const viaScript = await request(rig.app).post('/hooks/events?instar_sid=inc-3').set('Authorization', `Bearer ${TOKEN}`).send({ event: 'PostToolUse', session_id: CS, tool_name: 'Bash' });
    expect(viaScript.status).toBe(200);
    expect(rig.setClaude.at(-1)).toEqual(['inc-3', CS]);
  });

  it('criteria 4 + 4a: GET /sessions telemetry for the tmux name, scoped to the current incarnation; survives a restart', async () => {
    await post(rig.app, { hook_event_name: 'PostToolUse', session_id: CS, tool_name: 'Bash', tool_input: { command: 'ls' } }, headers('inc-1'));
    await post(rig.app, { hook_event_name: 'TaskCompleted', session_id: CS, task_id: 't-1', task_subject: 's' }, headers('inc-1'));
    await drained(rig);
    let list = await request(rig.app).get('/sessions').set('Authorization', `Bearer ${TOKEN}`);
    let row = (list.body as Array<{ tmuxSession: string; telemetry?: { eventCount: number; toolsUsed: string[]; taskCompleted: boolean } }>).find(s => s.tmuxSession === TMUX)!;
    expect(row.telemetry).toMatchObject({ eventCount: 2, toolsUsed: ['Bash'], taskCompleted: true });

    // Respawn under the same tmux name (new INSTAR_SESSION_ID, resumed Claude session id).
    saveRunning(rig.state, 'inc-2');
    await post(rig.app, { hook_event_name: 'PostToolUse', session_id: CS, tool_name: 'Read', tool_input: { file_path: '/x' } }, headers('inc-2'));
    await drained(rig);
    list = await request(rig.app).get('/sessions').set('Authorization', `Bearer ${TOKEN}`);
    row = list.body.find((s: { tmuxSession: string }) => s.tmuxSession === TMUX);
    expect(row.telemetry).toMatchObject({ eventCount: 1, toolsUsed: ['Read'], taskCompleted: false });

    // Server restart: a fresh receiver rebuilds the index from disk.
    await rig.server.stop();
    const root = rig.root;
    rig = await boot(root);
    list = await request(rig.app).get('/sessions').set('Authorization', `Bearer ${TOKEN}`);
    row = list.body.find((s: { tmuxSession: string }) => s.tmuxSession === TMUX);
    expect(row.telemetry).toMatchObject({ eventCount: 1, toolsUsed: ['Read'], taskCompleted: false });
  });

  it('criterion 5a: refusals happen before parsing — empty token / empty session 204, wrong token 401, forwarded 403; nothing parsed or dispatched', async () => {
    const big = JSON.stringify({ hook_event_name: 'Stop', session_id: CS, pad: 'x'.repeat(3 * 1024 * 1024) });
    const send = (h: Record<string, string>) => {
      let r = request(rig.app).post('/hooks/native-events').set('Content-Type', 'application/json');
      for (const [k, v] of Object.entries(h)) r = r.set(k, v);
      return r.send(big);
    };
    const c = rig.server.nativeHookIngest.counters;
    expect((await send({ ...headers('inc-1'), Authorization: 'Bearer' })).status).toBe(204);
    expect((await send({ ...headers('inc-1'), 'X-Instar-Session-Id': '' })).status).toBe(204);
    expect((await send({ ...headers('inc-1'), Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await send({ ...headers('inc-1'), 'X-Forwarded-For': '203.0.113.9' })).status).toBe(403);
    expect((await send({ ...headers('inc-1'), 'Cf-Connecting-Ip': '203.0.113.9' })).status).toBe(403);
    await drained(rig);
    expect(c.admitted).toBe(0);
    expect(c.emptyCredential).toBe(2);
    expect(c.wrongToken).toBe(1);
    expect(c.forbidden).toBe(2);
    expect(rig.receiver.getSessionEvents(CS)).toEqual([]);
    // A body over 4 MB is refused before parsing too.
    const huge = await request(rig.app).post('/hooks/native-events').set(headers('inc-1')).set('Content-Type', 'application/json')
      .send(JSON.stringify({ hook_event_name: 'Stop', session_id: CS, pad: 'y'.repeat(5 * 1024 * 1024) }));
    expect(huge.status).toBe(413);
    expect(c.tooLarge).toBe(1);
    // An admitted 3 MB body is accepted (it is within the cap) and stored projected.
    expect((await send(headers('inc-1'))).status).toBe(204);
    await drained(rig);
    const stored = rig.receiver.getSessionEvents(CS);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0])).not.toContain('xxxxxxxx');
  });

  it('criterion 5a: the file viewer refuses hook-events and subagent-tracking paths', async () => {
    await post(rig.app, { hook_event_name: 'Stop', session_id: CS }, headers('inc-1'));
    await drained(rig);
    const fileApp = express();
    fileApp.use(express.json());
    fileApp.use(createFileRoutes({ config: { projectDir: rig.root, stateDir: rig.stateDir, port: 0, projectName: 'nh-it' } as unknown as InstarConfig }));
    for (const rel of [`.instar/hook-events/${CS}.jsonl`, '.instar/subagent-tracking/x.jsonl']) {
      for (const route of ['/api/files/read', '/api/files/download']) {
        const res = await request(fileApp).get(route).query({ path: rel });
        expect(res.status, `${route} ${rel}`).toBe(403);
      }
    }
  });

  it('criterion 5b: a malformed allowed field is dropped and counted, not stored', async () => {
    await post(rig.app, { hook_event_name: 'SessionEnd', session_id: CS, reason: { not: 'a string' }, tool_name: 'n'.repeat(10 * 1024) }, headers('inc-1'));
    await post(rig.app, { hook_event_name: 'Bogus', session_id: CS }, headers('inc-1'));
    await drained(rig);
    const c = rig.server.nativeHookIngest.counters;
    expect(c.malformedFields).toBe(2);
    expect(c.malformedEvents).toBe(1);
    const stored = rig.receiver.getSessionEvents(CS);
    expect(stored).toHaveLength(1);
    expect(stored[0].payload).not.toHaveProperty('reason');
    expect(stored[0].payload).not.toHaveProperty('tool_name');
  });

  it('criterion 5b: 5,000 events posted faster than they can be stored leave at most 1,000 pending and count the overflow', async () => {
    // Freeze the drain worker so storage genuinely falls behind.
    const ingest = rig.server.nativeHookIngest as unknown as { schedule: (fn: () => void) => void; draining: boolean };
    const parked: Array<() => void> = [];
    ingest.schedule = (fn) => { parked.push(fn); };
    const srv = (rig.server as unknown as { server: http.Server }).server;
    const port = (srv.address() as { port: number }).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
    const body = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: CS, tool_name: 'Read', tool_input: { file_path: '/p' } });
    const one = () => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/hooks/native-events', method: 'POST', agent, headers: { ...headers('inc-1'), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      req.end(body);
    });
    for (let b = 0; b < 50; b++) {
      const codes = await Promise.all(Array.from({ length: 100 }, one));
      expect(codes.every(c => c === 204)).toBe(true);
    }
    agent.destroy();
    expect(rig.server.nativeHookIngest.pending).toBe(1000);
    expect(rig.server.nativeHookIngest.counters.queueOverflow).toBe(4000);
    // Unfreeze: the backlog drains and every queued event is stored.
    ingest.schedule = (fn) => setImmediate(fn);
    while (parked.length) parked.shift()!();
    await drained(rig);
    for (let i = 0; i < 100 && rig.server.nativeHookIngest.pending > 0; i++) await new Promise(r => setTimeout(r, 5));
    expect(rig.server.nativeHookIngest.counters.stored).toBe(1000);
  }, 60_000);
});
