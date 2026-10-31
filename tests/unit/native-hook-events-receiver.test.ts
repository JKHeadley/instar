/**
 * Native hook events — HookEventReceiver incarnation scope, in-memory
 * summaries, trim hysteresis and live-aware eviction; SubagentTracker
 * staleness cap and incarnation-scoped SessionEnd
 * (docs/specs/native-hook-events.md D1, D2).
 *
 * Acceptance criteria covered: 4a (unit: an old incarnation's TaskCompleted
 * does not satisfy a later incarnation; after a restart the index is rebuilt
 * and lookups resolve), 5 (61-minute subagent no longer active, incl. after
 * restart; SessionEnd clears only its own incarnation; in-memory summary ==
 * rebuilt-from-disk summary), 5c (eviction removes the least-recently-received
 * session, never a live one, and drops its summary).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HookEventReceiver, type HookEventPayload } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-recv-'));
}

const CS = 'c1a1a1a1-0000-4000-8000-000000000001';

function ev(event: string, inc: string, extra: Partial<HookEventPayload> = {}, cs = CS): HookEventPayload {
  return { event, session_id: cs, instar_session_id: inc, instar_session: 'echo-t1', ...extra };
}

describe('HookEventReceiver — tmux lookups are scoped to the current incarnation', () => {
  it('criterion 4a: after a respawn under the same tmux name, the old incarnation\'s TaskCompleted does not count', () => {
    const dir = tmp();
    let current = 'inc-1';
    const r = new HookEventReceiver({ stateDir: dir, resolveCurrentInstarSessionId: (t) => (t === 'echo-t1' ? current : null) });
    r.receive(ev('PostToolUse', 'inc-1', { tool_name: 'Bash' }));
    r.receive(ev('TaskCompleted', 'inc-1', { task_id: 't1' }));
    r.receive(ev('SessionEnd', 'inc-1', { reason: 'other' }));
    expect(r.hasTaskCompletedForTmux('echo-t1')).toBe(true);
    expect(r.getExitReasonForTmux('echo-t1')).toBe('other');
    // Respawn: same tmux name, new INSTAR_SESSION_ID; --resume keeps the Claude session id.
    current = 'inc-2';
    expect(r.hasTaskCompletedForTmux('echo-t1')).toBe(false);
    expect(r.getSessionSummaryForTmux('echo-t1')).toBeNull();
    r.receive(ev('PostToolUse', 'inc-2', { tool_name: 'Read' }));
    const s = r.getSessionSummaryForTmux('echo-t1')!;
    expect(s.eventCount).toBe(1);
    expect(s.toolsUsed).toEqual(['Read']);
    expect(r.hasTaskCompletedForTmux('echo-t1')).toBe(false);
    expect(r.getExitReasonForTmux('echo-t1')).toBeNull();
    // An unknown tmux name and events stored without an incarnation are never returned.
    expect(r.getSessionSummaryForTmux('nobody')).toBeNull();
  });

  it('criterion 4a: after a server restart the incarnation index is rebuilt and lookups still resolve', () => {
    const dir = tmp();
    const resolver = (t: string) => (t === 'echo-t1' ? 'inc-7' : null);
    const r1 = new HookEventReceiver({ stateDir: dir, resolveCurrentInstarSessionId: resolver });
    r1.receive(ev('PostToolUse', 'inc-7', { tool_name: 'Bash' }));
    r1.receive(ev('TaskCompleted', 'inc-7'));
    // A second Claude session id for the same incarnation (in-process /clear).
    r1.receive(ev('PostToolUse', 'inc-7', { tool_name: 'Edit' }, 'c2b2b2b2-0000-4000-8000-000000000002'));
    const r2 = new HookEventReceiver({ stateDir: dir, resolveCurrentInstarSessionId: resolver });
    expect(r2.claudeSessionIdsForIncarnation('inc-7').sort()).toEqual([CS, 'c2b2b2b2-0000-4000-8000-000000000002'].sort());
    expect(r2.hasTaskCompletedForTmux('echo-t1')).toBe(true);
    expect(r2.getSessionSummaryForTmux('echo-t1')).toEqual(r1.getSessionSummaryForTmux('echo-t1'));
  });

  it('criterion 5: an in-memory summary equals one rebuilt from disk for the same retained events (incl. after a trim)', () => {
    const dir = tmp();
    const r1 = new HookEventReceiver({ stateDir: dir, maxEventsPerSession: 20, resolveCurrentInstarSessionId: () => 'inc-1' });
    for (let i = 0; i < 37; i++) {
      r1.receive(ev(i % 9 === 0 ? 'SubagentStart' : 'PostToolUse', i < 30 ? 'inc-1' : 'inc-2', { tool_name: `t${i % 4}`, agent_type: 'Explore', ...(i % 5 === 0 ? { last_assistant_message: `m${i}` } : {}) }));
    }
    const r2 = new HookEventReceiver({ stateDir: dir, maxEventsPerSession: 20, resolveCurrentInstarSessionId: () => 'inc-1' });
    expect(r2.getSessionSummary(CS)).toEqual(r1.getSessionSummary(CS));
    expect(r2.getSessionSummaryForTmux('x')).toEqual(r1.getSessionSummaryForTmux('x'));
    // Summary describes exactly the retained events.
    expect(r1.getSessionSummary(CS)!.eventCount).toBe(r1.getSessionEvents(CS).length);
  });

  it('trims with hysteresis: reaching the cap trims to 80%, not on every event', () => {
    const dir = tmp();
    const r = new HookEventReceiver({ stateDir: dir, maxEventsPerSession: 10 });
    for (let i = 0; i < 10; i++) r.receive(ev('PostToolUse', 'i', { tool_name: `t${i}` }));
    expect(r.getSessionEvents(CS)).toHaveLength(8);
    r.receive(ev('PostToolUse', 'i', { tool_name: 'next' }));
    expect(r.getSessionEvents(CS)).toHaveLength(9); // no rewrite until the cap is reached again
    expect(r.getSessionEvents(CS).at(-1)!.payload.tool_name).toBe('next');
  });

  it('criterion 5c: eviction removes the least-recently-received non-live session, never a live one, and drops its summary', async () => {
    const dir = tmp();
    const live = new Set<string>(['inc-live']);
    const r = new HookEventReceiver({ stateDir: dir, maxSessions: 2, isLiveInstarSession: (id) => live.has(id), resolveCurrentInstarSessionId: (t) => (t === 'live-tmux' ? 'inc-live' : t === 'old-tmux' ? 'inc-old' : null) });
    const sleep = () => new Promise((res) => setTimeout(res, 5));
    // The live session is the OLDEST received — LRU alone would evict it.
    r.receive(ev('PostToolUse', 'inc-live', {}, 'zzzz-live'));
    await sleep();
    r.receive(ev('PostToolUse', 'inc-old', {}, 'aaaa-old'));
    await sleep();
    r.receive(ev('PostToolUse', 'inc-new', {}, 'mmmm-new'));
    const sessions = r.listSessions();
    expect(sessions).toContain('zzzz-live');
    expect(sessions).toContain('mmmm-new');
    expect(sessions).not.toContain('aaaa-old');
    expect(r.getSessionSummary('aaaa-old')).toBeNull();
    expect(r.getSessionSummaryForTmux('old-tmux')).toBeNull();
    expect(r.claudeSessionIdsForIncarnation('inc-old')).toEqual([]);
    expect(r.getSessionSummaryForTmux('live-tmux')).not.toBeNull();
    // With every session live, the limit is exceeded rather than a live file deleted.
    live.add('inc-new');
    live.add('inc-x');
    r.receive(ev('PostToolUse', 'inc-x', {}, 'bbbb-x'));
    expect(r.listSessions().sort()).toEqual(['bbbb-x', 'mmmm-new', 'zzzz-live']);
  });
});

describe('SubagentTracker — staleness cap and incarnation-scoped SessionEnd', () => {
  it('criterion 5: a subagent with no stop for 61 minutes no longer counts as active, including after a restart', () => {
    const dir = tmp();
    let now = Date.parse('2026-10-27T10:00:00Z');
    const t1 = new SubagentTracker({ stateDir: dir, now: () => now });
    t1.onStart('agent-1', 'Explore', CS, { instarSessionId: 'inc-1' });
    expect(t1.hasActiveSubagents(CS)).toBe(true);
    now += 59 * 60_000;
    expect(t1.hasActiveSubagents(CS)).toBe(true);
    now += 2 * 60_000; // 61 minutes
    expect(t1.hasActiveSubagents(CS)).toBe(false);
    // Restart: the boot rebuild applies the same cap.
    const t2 = new SubagentTracker({ stateDir: dir, now: () => now });
    expect(t2.hasActiveSubagents(CS)).toBe(false);
    // ...while a fresh one rebuilt at boot still counts.
    t2.onStart('agent-2', 'Plan', CS, { instarSessionId: 'inc-1' });
    const t3 = new SubagentTracker({ stateDir: dir, now: () => now + 60_000 });
    expect(t3.hasActiveSubagents(CS)).toBe(true);
  });

  it('criterion 5: an old incarnation\'s late SessionEnd leaves a newer incarnation\'s subagent active', () => {
    const dir = tmp();
    const t = new SubagentTracker({ stateDir: dir });
    const stops: string[] = [];
    t.on('stop', (p: { agentId: string }) => stops.push(p.agentId));
    t.onStart('old-agent', 'Explore', CS, { instarSessionId: 'inc-1' });
    t.onStart('new-agent', 'Explore', CS, { instarSessionId: 'inc-2' });
    expect(t.onSessionEnd(CS, 'inc-1')).toBe(1);
    expect(stops).toEqual(['old-agent']);
    expect(t.hasActiveSubagents(CS)).toBe(true);
    expect(t.getActiveSubagents(CS).map(r => r.agentId)).toEqual(['new-agent']);
    // A SessionEnd with no incarnation clears nothing.
    expect(t.onSessionEnd(CS, null)).toBe(0);
    expect(t.onSessionEnd(CS, 'inc-2')).toBe(1);
    expect(t.hasActiveSubagents(CS)).toBe(false);
    // Persisted: a restart does not resurrect them.
    expect(new SubagentTracker({ stateDir: dir }).hasActiveSubagents(CS)).toBe(false);
  });
});
