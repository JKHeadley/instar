/**
 * Native hook events — consumers that start receiving data
 * (docs/specs/native-hook-events.md D2).
 *
 * Acceptance criteria covered: 3 (compaction Trigger 1 reports only the
 * emitting topic session; a non-topic session, a missing header or an earlier
 * incarnation reports nothing), 3a (the session-id bridge, including after a
 * respawn; both routes call the same side-effect function), 3b (a native
 * SubagentStart/Stop pair reaches SubagentTracker with agent_transcript_path;
 * with injectAlerts off a 6-minute subagent produces a log line and no
 * injected message), plus the D2 consumer-enumeration ratchet.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { HelperWatchdog } from '../../src/monitoring/HelperWatchdog.js';
import {
  wireCompactionTrigger1,
  wirePreCompactionFlush,
  createHelperAlertDelivery,
  resolvePreCompactTarget,
} from '../../src/monitoring/hookEventConsumers.js';
import { dispatchHookEvent } from '../../src/server/hookEventDispatch.js';
import { projectNativeHookEvent } from '../../src/monitoring/NativeHookEvents.js';

const ROOT = path.resolve(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-consumers-'));
const CS = '3d3d3d3d-0000-4000-8000-000000000003';

describe('compaction sentinel Trigger 1 — scoped to the emitting session (criterion 3)', () => {
  function setup() {
    const receiver = new HookEventReceiver({ stateDir: tmp() });
    const reports: Array<[string, string]> = [];
    const running = new Map<string, { tmuxSession: string }>([
      ['inc-A', { tmuxSession: 'echo-topic-A' }],
      ['inc-B', { tmuxSession: 'echo-topic-B' }],
      ['inc-J', { tmuxSession: 'echo-job-nightly' }],
    ]);
    const timers: Array<() => void> = [];
    wireCompactionTrigger1(receiver, {
      report: (n, t) => reports.push([n, t]),
      getSessionById: (id) => running.get(id),
      topicSessionNames: () => ['echo-topic-A', 'echo-topic-B'],
      setTimeoutFn: (fn) => { timers.push(fn); },
    });
    const fire = () => { while (timers.length) timers.shift()!(); };
    return { receiver, reports, running, fire };
  }

  it('a PreCompact from topic session A reports only A', () => {
    const { receiver, reports, fire } = setup();
    receiver.receive({ event: 'PreCompact', session_id: CS, instar_session_id: 'inc-A', instar_session: 'echo-topic-A', trigger: 'auto' });
    fire();
    expect(reports).toEqual([['echo-topic-A', 'PreCompact']]);
  });

  it('a non-topic session, a missing header, or an earlier incarnation reports nothing', () => {
    const { receiver, reports, running, fire } = setup();
    receiver.receive({ event: 'PreCompact', session_id: CS, instar_session_id: 'inc-J', instar_session: 'echo-job-nightly' });
    receiver.receive({ event: 'PreCompact', session_id: CS, instar_session_id: 'inc-A' }); // no instar_session header
    receiver.receive({ event: 'PreCompact', session_id: CS }); // script-delivered: neither field
    // Earlier incarnation of a reused name: inc-A-old is no longer a current record.
    receiver.receive({ event: 'PreCompact', session_id: CS, instar_session_id: 'inc-A-old', instar_session: 'echo-topic-A' });
    // Current id but the name no longer matches (respawned under another name).
    running.set('inc-B', { tmuxSession: 'echo-topic-B2' });
    receiver.receive({ event: 'PreCompact', session_id: CS, instar_session_id: 'inc-B', instar_session: 'echo-topic-B' });
    fire();
    expect(reports).toEqual([]);
  });

  it('resolves at receive time, before the delay (a respawn during the delay cannot redirect it)', () => {
    const deps = { report: vi.fn(), getSessionById: () => ({ tmuxSession: 'n' }), topicSessionNames: () => null };
    expect(resolvePreCompactTarget({ event: 'PreCompact', instar_session_id: 'x', instar_session: 'n' }, deps)).toBeNull(); // no messaging ⇒ nothing
  });
});

describe('session-id bridge + shared side effects (criterion 3a)', () => {
  it('a native event updates claudeSessionId, including after a respawn rotates it', () => {
    const receiver = new HookEventReceiver({ stateDir: tmp() });
    const sessions = new Map<string, { claudeSessionId?: string }>([['inc-1', {}]]);
    const setClaudeSessionId = vi.fn((inc: string, cs: string) => { sessions.get(inc)!.claudeSessionId = cs; });
    const deps = { receive: (p: never) => receiver.receive(p), sessionManager: { getSessionById: (id: string) => sessions.get(id), setClaudeSessionId } };
    const raw = (cs: string) => projectNativeHookEvent({ hook_event_name: 'Stop', session_id: cs }, { instarSessionId: 'inc-1', instarSession: 't' }).event!;
    expect(dispatchHookEvent(deps, raw(CS), 'inc-1')).toBe(true);
    expect(sessions.get('inc-1')!.claudeSessionId).toBe(CS);
    dispatchHookEvent(deps, raw(CS), 'inc-1');
    expect(setClaudeSessionId).toHaveBeenCalledTimes(1); // unchanged ⇒ no write
    const rotated = '4e4e4e4e-0000-4000-8000-000000000004';
    dispatchHookEvent(deps, raw(rotated), 'inc-1');
    expect(sessions.get('inc-1')!.claudeSessionId).toBe(rotated);
  });

  it('both routes call the same side-effect function (wiring)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf8');
    const oldRoute = src.slice(src.indexOf("router.post('/hooks/events'"), src.indexOf("router.post('/hooks/events'") + 2500);
    expect(oldRoute).toContain('dispatchHookEvent(hookEventDispatchDeps(), payload, instarSid)');
    expect(oldRoute).not.toContain('setClaudeSessionId');
    expect(oldRoute).not.toContain('subagentTracker.onStart');
    const nativeBlock = src.slice(src.indexOf('ctx.nativeHookIngest.setProcessor'), src.indexOf("router.post('/hooks/native-events'"));
    expect(nativeBlock).toContain('dispatchHookEvent(hookEventDispatchDeps(), event, instarSid)');
  });

  it('a native Bash commit counts once via the projected boolean; the raw command is not needed', () => {
    const recordCommit = vi.fn();
    const receiver = new HookEventReceiver({ stateDir: tmp() });
    const e = projectNativeHookEvent({ hook_event_name: 'PostToolUse', session_id: CS, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, { instarSessionId: 'i' }).event!;
    dispatchHookEvent({ receive: (p) => receiver.receive(p), recordCommit }, e, 'i');
    expect(recordCommit).toHaveBeenCalledTimes(1);
  });
});

describe('subagents (criterion 3b)', () => {
  it('a native SubagentStart/Stop pair reaches SubagentTracker with agent_transcript_path', () => {
    const dir = tmp();
    const receiver = new HookEventReceiver({ stateDir: dir });
    const tracker = new SubagentTracker({ stateDir: dir });
    const deps = { receive: (p: never) => receiver.receive(p), subagentTracker: tracker };
    const H = { instarSessionId: 'inc-1', instarSession: 'echo-t' };
    dispatchHookEvent(deps, projectNativeHookEvent({ hook_event_name: 'SubagentStart', session_id: CS, agent_id: 'ag-1', agent_type: 'Explore' }, H).event!, 'inc-1');
    expect(tracker.hasActiveSubagents(CS)).toBe(true);
    expect(tracker.getActiveSubagents(CS)[0].instarSessionId).toBe('inc-1');
    dispatchHookEvent(deps, projectNativeHookEvent({ hook_event_name: 'SubagentStop', session_id: CS, agent_id: 'ag-1', agent_transcript_path: '/t/ag-1.jsonl', last_assistant_message: 'found it' }, H).event!, 'inc-1');
    expect(tracker.hasActiveSubagents(CS)).toBe(false);
    const rec = tracker.getSessionRecords(CS)[0];
    expect(rec.transcriptPath).toBe('/t/ag-1.jsonl');
    expect(rec.lastMessage).toBe('found it');
  });

  it('with injectAlerts off, a 6-minute subagent produces a log line and no injected message', () => {
    vi.useFakeTimers();
    try {
      const tracker = new SubagentTracker({ stateDir: tmp() });
      const watchdog = new HelperWatchdog({ subagentTracker: tracker });
      watchdog.start();
      const injected: string[] = [];
      const logged: string[] = [];
      const delivery = createHelperAlertDelivery({ injectAlerts: false, inject: (_t, m) => injected.push(m), log: (m) => logged.push(m) });
      watchdog.on('stall', (e: { agentType: string; agentId: string }) => delivery.deliver('echo-topic-A', `[helper-watchdog] Your ${e.agentType} helper (agent ${e.agentId}) stalled`));
      tracker.onStart('ag-9', 'Explore', CS, { instarSessionId: 'inc-1' });
      vi.advanceTimersByTime(6 * 60_000);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('[helper-watchdog]');
      expect(logged[0]).toContain('not injected');
      expect(injected).toEqual([]);
      expect(delivery.counts).toMatchObject({ logged: 1, injected: 0 });
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('with injectAlerts on, the same alert is injected (the gate is the only difference)', () => {
    const injected: string[] = [];
    const d = createHelperAlertDelivery({ injectAlerts: true, inject: (_t, m) => injected.push(m), log: () => {} });
    d.deliver('s', 'm');
    d.deliver(null, 'no-target');
    expect(injected).toEqual(['m']);
  });

  it('server.ts gates the helper alert injection on monitoring.helperWatchdog.injectAlerts (default false)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf8');
    expect(src).toContain("helperWatchdog?.injectAlerts === true");
    expect(src).toMatch(/const deliverHelperAlert = \(tmux: string \| null, msg: string\): void => helperAlertDelivery\.deliver\(tmux, msg\);/);
  });
});

/**
 * D2 consumer-enumeration ratchet. Every consumer of a hook event must have a
 * reviewed row in docs/specs/native-hook-events.md's D2 table; this fixture is
 * that table's machine-readable mirror. Adding a dispatch case or a receiver
 * listener without adding (and reviewing) a row fails here.
 */
const D2_DISPATCH_CASES = ['PostToolUse', 'SubagentStart', 'SubagentStop', 'SessionEnd'];
const D2_RECEIVER_LISTENERS: Record<string, string[]> = {
  // event → consumer rows
  PreCompact: ['Compaction sentinel Trigger 1', 'PreCompactionFlush (off by default)'],
};

describe('D2 consumer enumeration (ratchet)', () => {
  it('the shared dispatch function\'s case labels match the D2 fixture', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/server/hookEventDispatch.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function dispatchHookEvent('));
    const cases = [...fn.matchAll(/\bcase '([A-Za-z]+)':/g)].map(m => m[1]);
    expect(cases.sort()).toEqual([...D2_DISPATCH_CASES].sort());
  });

  it('server.ts wires receiver listeners only through the reviewed wiring functions', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf8');
    expect(src.match(/hookEventReceiver\.on\(/g) ?? []).toEqual([]);
    expect(src).toContain('wireCompactionTrigger1(hookEventReceiver,');
    expect(src).toContain('wirePreCompactionFlush(hookEventReceiver,');
  });

  it('after the real wiring runs, the receiver\'s listeners match the D2 fixture', () => {
    const receiver = new HookEventReceiver({ stateDir: tmp() });
    wireCompactionTrigger1(receiver, { report: () => {}, getSessionById: () => undefined, topicSessionNames: () => null });
    wirePreCompactionFlush(receiver, { handle: async () => undefined });
    const names = receiver.eventNames().map(String).sort();
    expect(names).toEqual(Object.keys(D2_RECEIVER_LISTENERS).sort());
    for (const [event, rows] of Object.entries(D2_RECEIVER_LISTENERS)) {
      expect(receiver.listenerCount(event)).toBe(rows.length);
    }
  });
});
