/**
 * Native hook events — E2E lifecycle tier ("feature is alive").
 * Spec: docs/specs/native-hook-events.md, acceptance criterion 7.
 *
 * Mirrors the production path end to end:
 *   1. the update path (PostUpdateMigrator.migrateSettings) rewrites a real
 *      agent's reporter entries to native http hooks when the flag is on and
 *      the configured Claude Code is >= 2.1.310;
 *   2. the server boot reconcile runs with the same decision function server.ts
 *      calls (decideNativeReporterFromConfig + bootReconcileNativeReporter);
 *   3. a REAL AgentServer listens on a loopback port with the real
 *      HookEventReceiver, wired through the same consumer functions server.ts
 *      uses (wireCompactionTrigger1);
 *   4. the hook as Claude Code would fire it — the URL and headers read out of
 *      the migrated settings file, `${VAR}` expanded from the session env —
 *      POSTs a real Stop body; it answers 204 and the event is retrievable by
 *      name. With the flag off the same agent keeps the command entries.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { wireCompactionTrigger1 } from '../../src/monitoring/hookEventConsumers.js';
import { decideNativeReporterFromConfig, bootReconcileNativeReporter, type NativeHookConfigView } from '../../src/core/nativeHookEventsGate.js';
import { buildHttpHookSettings, isNativeReporterHook, NATIVE_REPORTER_EVENTS } from '../../src/data/http-hook-templates.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

const TOKEN = 'native-hooks-e2e-token';
const CS = '5e5e5e5e-0000-4000-8000-0000000000e2';
const TMUX = 'nh-e2e-topic';
const INC = 'inc-e2e-1';

function fakeClaude(root: string, version: string): string {
  const dir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  const bin = path.join(dir, 'bin', 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  return bin;
}

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

type HookEntry = { matcher?: string; hooks: Array<Record<string, unknown>> };

function setup(flag: boolean, port: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const claudeBin = fakeClaude(root, '2.1.310');
  const fileConfig = {
    projectName: 'nh-e2e', port, authToken: TOKEN,
    sessions: { claudePath: claudeBin },
    ...(flag ? { hooks: { nativeEventReporter: { enabled: true } } } : {}),
  };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(fileConfig, null, 2));
  const settingsPath = path.join(root, '.claude', 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: buildHttpHookSettings(`http://localhost:${port}`) }, null, 2));
  return { root, stateDir, settingsPath, claudeBin, fileConfig };
}

let toStop: AgentServer | null = null;
afterEach(async () => {
  if (toStop) await toStop.stop();
  toStop = null;
});

describe('native hook events — alive through the production path', () => {
  it('flag on: the migrated settings carry native hooks, and a hook fired from them is stored by name (criterion 7)', async () => {
    const port = await freePort();
    const e = setup(true, port);

    // 1. Update path.
    const migrator = new PostUpdateMigrator({
      projectDir: e.root, stateDir: e.stateDir, port, hasTelegram: false, projectName: 'nh-e2e', claudeCodePath: e.claudeBin,
    });
    const r = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (migrator as unknown as { migrateSettings(x: unknown): void }).migrateSettings(r);
    expect(r.errors).toEqual([]);
    const settings = JSON.parse(fs.readFileSync(e.settingsPath, 'utf8')) as { hooks: Record<string, HookEntry[]> };
    for (const ev of NATIVE_REPORTER_EVENTS) {
      const reporters = (settings.hooks[ev] ?? []).flatMap((x) => x.hooks).filter((h) => isNativeReporterHook(h) || String(h.command ?? '').includes('hook-event-reporter'));
      expect(reporters, ev).toHaveLength(1);
      expect(isNativeReporterHook(reporters[0]), ev).toBe(true);
    }

    // 2. Boot reconcile, same functions as server.ts.
    const decision = decideNativeReporterFromConfig(e.fileConfig as NativeHookConfigView, { projectDir: e.root, port });
    expect(decision.native).toBe(true);
    const boot = bootReconcileNativeReporter({ projectDir: e.root, decision, log: () => {} });
    expect(boot.changedAtBoot).toBe(false); // the update path already reconciled it
    expect(boot.launchCheck()).toBe(false);

    // 3. A real server on the real loopback port.
    const state = new StateManager(e.stateDir);
    state.saveSession({ id: INC, name: TMUX, status: 'running', tmuxSession: TMUX, startedAt: new Date().toISOString() } as Session);
    const receiver = new HookEventReceiver({
      stateDir: e.stateDir,
      resolveCurrentInstarSessionId: (t) => state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === t)?.id ?? null,
      isLiveInstarSession: (id) => state.listSessions({ status: 'running' }).some((s) => s.id === id),
    });
    const reported: string[] = [];
    wireCompactionTrigger1(receiver, {
      report: (name) => reported.push(name),
      getSessionById: (id) => state.listSessions({ status: 'running' }).find((s) => s.id === id),
      topicSessionNames: () => [TMUX],
      setTimeoutFn: (fn) => { fn(); return 0; },
    });
    const config = {
      projectName: 'nh-e2e', projectDir: e.root, stateDir: e.stateDir, port, authToken: TOKEN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: e.claudeBin, maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    const sessionManager = {
      listRunningSessions: () => state.listSessions({ status: 'running' }),
      getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
      getSession: () => null,
      getSessionById: (id: string) => state.listSessions({ status: 'running' }).find((s) => s.id === id),
      setClaudeSessionId: (inc: string, cs: string) => {
        const s = state.listSessions({ status: 'running' }).find((x) => x.id === inc);
        if (s) state.saveSession({ ...s, claudeSessionId: cs });
      },
    };
    const server = new AgentServer({
      config, sessionManager: sessionManager as never, state, hookEventReceiver: receiver, subagentTracker: new SubagentTracker({ stateDir: e.stateDir }),
    });
    toStop = server;
    await server.start();

    // 4. Fire the hook the way Claude Code does: URL + headers from the settings
    //    file, ${VAR} expanded from the session's env.
    const hook = settings.hooks.Stop.flatMap((x) => x.hooks).find(isNativeReporterHook)!;
    const env: Record<string, string> = { INSTAR_AUTH_TOKEN: TOKEN, INSTAR_SESSION_ID: INC, INSTAR_SESSION_NAME: TMUX, INSTAR_AGENT_ID: 'nh-e2e' };
    const expand = (v: string) => v.replace(/\$\{([A-Z_]+)\}/g, (_, k: string) => ((hook.allowedEnvVars as string[]).includes(k) ? env[k] ?? '' : ''));
    const hdrs: Record<string, string> = { 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(hook.headers as Record<string, string>)) hdrs[k] = expand(v);
    const fire = (body: unknown) => fetch(String(hook.url), { method: 'POST', headers: hdrs, body: JSON.stringify(body) });

    const stopRes = await fire({
      session_id: CS, transcript_path: `/tmp/p/${CS}.jsonl`, cwd: e.root, permission_mode: 'bypassPermissions',
      hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'All done.',
    });
    expect(stopRes.status).toBe(204);
    expect(await stopRes.text()).toBe('');
    const compactRes = await fire({ session_id: CS, transcript_path: `/tmp/p/${CS}.jsonl`, cwd: e.root, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' });
    expect(compactRes.status).toBe(204);

    for (let i = 0; i < 200 && receiver.getSessionEvents(CS).length < 2; i++) await new Promise((res) => setTimeout(res, 10));
    const events = receiver.getSessionEvents(CS);
    expect(events.map((x) => x.payload.event)).toEqual(['Stop', 'PreCompact']);
    expect(events[0].payload).toMatchObject({ event: 'Stop', instar_session_id: INC, instar_session: TMUX, last_assistant_message: 'All done.' });
    // Wired consumers are alive: the session-id bridge and the scoped Trigger 1.
    expect(state.listSessions({ status: 'running' }).find((s) => s.id === INC)?.claudeSessionId).toBe(CS);
    expect(reported).toEqual([TMUX]);
    // Counters on the authenticated /health.
    const health = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { hookEvents?: Record<string, number> };
    expect(health.hookEvents).toMatchObject({ admitted: 2, stored: 2, failedProcessing: 0 });
  });

  it('flag off: the same agent keeps the command reporter entries (no native hook written)', async () => {
    const port = await freePort();
    const e = setup(false, port);
    const before = fs.readFileSync(e.settingsPath, 'utf8');
    const migrator = new PostUpdateMigrator({
      projectDir: e.root, stateDir: e.stateDir, port, hasTelegram: false, projectName: 'nh-e2e', claudeCodePath: e.claudeBin,
    });
    (migrator as unknown as { migrateSettings(x: unknown): void }).migrateSettings({ upgraded: [], skipped: [], errors: [] });
    const settings = JSON.parse(fs.readFileSync(e.settingsPath, 'utf8')) as { hooks: Record<string, HookEntry[]> };
    const all = Object.values(settings.hooks).flat().flatMap((x) => x.hooks);
    expect(all.some(isNativeReporterHook)).toBe(false);
    for (const ev of NATIVE_REPORTER_EVENTS) {
      expect((settings.hooks[ev] ?? []).flatMap((x) => x.hooks).some((h) => String(h.command ?? '').includes('hook-event-reporter')), ev).toBe(true);
    }
    expect(JSON.parse(before).hooks.PostToolUse).toBeDefined();
  });
});
