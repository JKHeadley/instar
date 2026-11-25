/**
 * Command hook reporter — integration tier. The REAL reporter script (the copy every existing agent
 * gets on update) runs as a child process against the REAL AgentServer pipeline (auth, createRoutes,
 * /hooks/events, HookEventReceiver, SubagentTracker), fed real Claude Code hook bodies on stdin.
 *
 * Earned 2026-11-21: the reporter read `hook_event` (Claude Code sends `hook_event_name`) and never
 * sent the instar session id, so every Stop, SubagentStart, SubagentStop, TaskCompleted, SessionEnd
 * and PreCompact event was stored as "Unknown" and no consumer of those events ever ran.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { resolvePreCompactTarget } from '../../src/monitoring/hookEventConsumers.js';
import { getHookEventReporterScript as initReporterScript } from '../../src/commands/init.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

void request; void express;

const TOKEN = 'cmd-reporter-it-token';
const CS = '9a9a9a9a-0000-4000-8000-00000000000a';
const TMUX = 'cr-it-topic-1';

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
  root = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-reporter-it-'));
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


function reporterScript(root: string): string {
  const m = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
  const file = path.join(root, 'hook-event-reporter.js');
  fs.writeFileSync(file, (m as unknown as { getHookEventReporterScript(): string }).getHookEventReporterScript());
  return file;
}

function runReporter(script: string, port: number, inc: string, body: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, INSTAR_SERVER_URL: `http://127.0.0.1:${port}`, INSTAR_AUTH_TOKEN: TOKEN, INSTAR_SESSION_ID: inc, INSTAR_SESSION_NAME: TMUX },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', () => resolve());
    child.stdin.end(JSON.stringify(body));
  });
}

/** The reporter exits within 50 ms by design; the server finishes the request on its own time. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

describe('command hook reporter → /hooks/events (real script, real server)', () => {
  let rig: Rig;
  let listener: http.Server;
  let port: number;
  let script: string;
  beforeEach(async () => {
    rig = await boot();
    saveRunning(rig.state, 'inc-1');
    listener = http.createServer(rig.app);
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()));
    port = (listener.address() as { port: number }).port;
    script = reporterScript(rig.root);
  });
  afterEach(async () => {
    await new Promise<void>((r) => listener.close(() => r()));
    await rig.server.stop();
  });

  it('every real event body is stored with its real name and the instar session id', async () => {
    for (const body of realBodies()) {
      const before = rig.receiver.getSessionEvents(CS).length;
      await runReporter(script, port, 'inc-1', body);
      await until(() => rig.receiver.getSessionEvents(CS).length > before);
    }
    const events = rig.receiver.getSessionEvents(CS).map((e: { payload: Record<string, unknown> }) => e.payload);
    expect(events.map((e) => e.event)).toEqual(['PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'TaskCompleted', 'PreCompact', 'SessionEnd']);
    for (const e of events) expect(e.instar_session_id).toBe('inc-1');
    expect(events.some((e) => e.event === 'Unknown')).toBe(false);
  });

  it('the Stop event reaches a Stop listener with the session id (the practice-fold trigger)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    rig.receiver.on('Stop', (p: Record<string, unknown>) => seen.push(p));
    await runReporter(script, port, 'inc-1', realBodies().find((b) => b.hook_event_name === 'Stop')!);
    await until(() => seen.length > 0);
    expect(seen).toHaveLength(1);
    expect(seen[0].instar_session_id).toBe('inc-1');
  });

  it('a command-path subagent start then stop opens and closes the matching agent, with its transcript path', async () => {
    const bodies = realBodies();
    await runReporter(script, port, 'inc-1', bodies.find((b) => b.hook_event_name === 'SubagentStart')!);
    await until(() => rig.tracker.getActiveSubagents(CS).length > 0);
    expect(JSON.stringify(rig.tracker.getActiveSubagents(CS))).toContain('agent-77');
    const stopBody = bodies.find((b) => b.hook_event_name === 'SubagentStop')!;
    await runReporter(script, port, 'inc-1', stopBody);
    await until(() => rig.tracker.getActiveSubagents(CS).length === 0);
    expect(rig.tracker.getActiveSubagents(CS)).toHaveLength(0);
    const stored = rig.receiver.getSessionEvents(CS).map((e: { payload: Record<string, unknown> }) => e.payload).find((e) => e.event === 'SubagentStop')!;
    expect(stored.agent_transcript_path).toBe(stopBody.agent_transcript_path);
  });

  it('the script never sends message text; text a client posts directly is redacted and kept to its last 200 characters', async () => {
    await runReporter(script, port, 'inc-1', { ...realBodies().find((b) => b.hook_event_name === 'Stop')!, last_assistant_message: 'x'.repeat(5000) });
    await until(() => rig.receiver.getSessionEvents(CS).length > 0);
    const fromScript = rig.receiver.getSessionEvents(CS).map((e: { payload: Record<string, unknown> }) => e.payload).find((e) => e.event === 'Stop')!;
    expect(fromScript.last_assistant_message).toBeUndefined();
    const res = await request(rig.app).post('/hooks/events?instar_sid=inc-1').set('Authorization', `Bearer ${TOKEN}`)
      .send({ event: 'SubagentStop', session_id: CS, agent_id: 'agent-9', last_assistant_message: 'y'.repeat(5000) + ' END-OF-REPLY' });
    expect(res.status).toBe(200);
    const direct = rig.receiver.getSessionEvents(CS).map((e: { payload: Record<string, unknown> }) => e.payload).find((e) => e.event === 'SubagentStop')!;
    expect(String(direct.last_assistant_message).length).toBeLessThanOrEqual(200);
    expect(String(direct.last_assistant_message).endsWith('END-OF-REPLY')).toBe(true);
  });

  it('a payload naming a different session id is overwritten with the route\'s own', async () => {
    const res = await request(rig.app).post('/hooks/events?instar_sid=inc-1').set('Authorization', `Bearer ${TOKEN}`)
      .send({ event: 'Stop', session_id: CS, instar_session_id: 'someone-else' });
    expect(res.status).toBe(200);
    const stop = rig.receiver.getSessionEvents(CS).map((e: { payload: Record<string, unknown> }) => e.payload).find((e) => e.event === 'Stop')!;
    expect(stop.instar_session_id).toBe('inc-1');
  });

  it('a command-path PreCompact names exactly the emitting topic session for Compaction Trigger 1; a stale incarnation names none', async () => {
    await runReporter(script, port, 'inc-1', realBodies().find((b) => b.hook_event_name === 'PreCompact')!);
    await until(() => rig.receiver.getSessionEvents(CS).length > 0);
    const pre = rig.receiver.getSessionEvents(CS).map((e: { payload: Record<string, unknown> }) => e.payload).find((e) => e.event === 'PreCompact')!;
    const deps = {
      getSessionById: (id: string) => rig.state.listSessions({ status: 'running' }).find((x) => x.id === id) ?? null,
      topicSessionNames: () => [TMUX],
      report: () => undefined,
    } as never;
    expect(resolvePreCompactTarget(pre as never, deps)).toBe(TMUX);
    saveRunning(rig.state, 'inc-2'); // respawn under the same tmux name: inc-1 is no longer running
    expect(resolvePreCompactTarget(pre as never, deps)).toBeNull();
  });

  it('the init copy and the update copy send byte-identical JSON on every fixture, including the legacy spelling, the unnamed fallback and malformed fields (captured before the route)', async () => {
    const initFile = path.join(rig.root, 'hook-event-reporter.init.js');
    fs.writeFileSync(initFile, initReporterScript());
    const captured: string[] = [];
    const cap = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { captured.push(b); res.end('{}'); }); });
    await new Promise<void>((r) => cap.listen(0, '127.0.0.1', () => r()));
    const capPort = (cap.address() as { port: number }).port;
    const bodies = [
      ...realBodies(),
      { session_id: CS, hook_event: 'Stop' }, // legacy spelling
      { session_id: CS, cwd: '/home/u/proj' }, // no name and no tool: stays Unknown
      { session_id: CS, hook_event_name: 'SubagentStart', agent_id: { not: 'a string' }, agent_type: 'a'.repeat(500), agent_transcript_path: 'relative.jsonl', reason: 'r'.repeat(65) }, // malformed
    ];
    for (const which of [script, initFile]) {
      for (const body of bodies) {
        const before = captured.length;
        await runReporter(which, capPort, 'inc-1', body);
        await until(() => captured.length > before);
      }
    }
    await new Promise<void>((r) => cap.close(() => r()));
    expect(captured).toHaveLength(bodies.length * 2);
    expect(captured.slice(bodies.length)).toEqual(captured.slice(0, bodies.length));
    const wire = captured.slice(0, bodies.length).map((c) => JSON.parse(c) as Record<string, unknown>);
    expect(wire[bodies.length - 3].event).toBe('Stop');
    expect(wire[bodies.length - 2].event).toBe('Unknown');
    const bad = wire[bodies.length - 1];
    expect(bad.event).toBe('SubagentStart');
    for (const k of ['agent_id', 'agent_type', 'agent_transcript_path', 'reason']) expect(bad[k]).toBeUndefined(); // bounded before sending
  });
;

  it('Codex-shaped bodies (its two registered events) are stored under their names with the instar session id', async () => {
    // Shape from Codex events already stored on Echo (uuidv7 session id, rollout transcript path, cwd) plus the
    // hook_event_name field; if a Codex build omits that field, the event stays named as before (no regression).
    const cx = '01a20037-aa0e-7bb0-8b09-eb864bd46779';
    const base = { session_id: cx, cwd: '/home/u/proj', transcript_path: `/home/u/.codex/sessions/2026/11/21/rollout-2026-11-21T14-26-17-${cx}.jsonl` };
    await runReporter(script, port, 'inc-1', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    await until(() => rig.receiver.getSessionEvents(cx).length > 0);
    await runReporter(script, port, 'inc-1', { ...base, hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: 'ls' } });
    await until(() => rig.receiver.getSessionEvents(cx).length > 1);
    const evs = rig.receiver.getSessionEvents(cx).map((e: { payload: Record<string, unknown> }) => e.payload);
    expect(evs.map((e) => e.event)).toEqual(['UserPromptSubmit', 'PostToolUse']);
    for (const e of evs) expect(e.instar_session_id).toBe('inc-1');
    expect(JSON.stringify(evs)).not.toContain('hello'); // the prompt text is not forwarded
  });

  it('an invalid route session id is used for neither storage nor dispatch', async () => {
    const res = await request(rig.app).post('/hooks/events?instar_sid=' + encodeURIComponent('bad id!')).set('Authorization', `Bearer ${TOKEN}`)
      .send({ event: 'Stop', session_id: CS, instar_session_id: 'inc-1' });
    expect(res.status).toBe(200);
    const stop = rig.receiver.getSessionEvents(CS).map((e: { payload: Record<string, unknown> }) => e.payload).find((e) => e.event === 'Stop')!;
    expect(stop.instar_session_id).toBeUndefined();
    expect(rig.setClaude.some(([inc]) => inc === 'bad id!')).toBe(false);
  });

  it('an invalid session id in the environment is sent in neither the query nor the body (the hook sends nothing)', async () => {
    const captured: string[] = [];
    const cap = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { captured.push(b); res.end('{}'); }); });
    await new Promise<void>((r) => cap.listen(0, '127.0.0.1', () => r()));
    const capPort = (cap.address() as { port: number }).port;
    await runReporter(script, capPort, 'bad id with spaces', realBodies().find((b) => b.hook_event_name === 'Stop')!);
    await until(() => captured.length > 0, 500);
    await new Promise<void>((r) => cap.close(() => r()));
    expect(captured).toHaveLength(0); // neither the query nor the body carries it: nothing is sent
  });
});
