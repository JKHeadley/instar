// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — the clean stopping point, open background tasks, and the ask brakes
 * (context-budget-layered-summaries §7.3, §7.2 "Ask brakes"; Phase 2 runner
 * inputs). Every unknown is not clean; brakes only ever make asking rarer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanStop, openBackgroundTasks, brakeOnStop, recordAsk, recordBackoff, ASK_BRAKES, type CleanStopEvidence } from '../../src/monitoring/foldCleanStop.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/fold-clean-stop.test.ts';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });
const stateDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-stop-')); dirs.push(d); return d; };

const ev = (over: Partial<CleanStopEvidence> = {}): CleanStopEvidence => ({
  sessionExists: true, paneIdle: true, liveToolShell: false, liveHelpers: false, openBackgroundTasks: 0,
  waitingUserMessages: 0, nextCheckInAt: null, now: 1_000_000, foldDurationMs: 60_000, ...over,
});

describe('cleanStop', () => {
  it('clean only when every check is affirmatively clean', () => {
    expect(cleanStop(ev())).toEqual({ clean: true });
  });
  it.each([
    [{ sessionExists: false }, 'no-session'], [{ sessionExists: 'unknown' }, 'session-unknown'],
    [{ paneIdle: false }, 'mid-turn'], [{ paneIdle: 'unknown' }, 'pane-unknown'],
    [{ liveToolShell: true }, 'live-child-process'], [{ liveToolShell: 'unknown' }, 'child-process-unknown'],
    [{ liveHelpers: true }, 'live-helpers'], [{ liveHelpers: 'unknown' }, 'helpers-unknown'],
    [{ openBackgroundTasks: null }, 'background-unknown'], [{ openBackgroundTasks: 1 }, 'background-task-open'],
    [{ waitingUserMessages: null }, 'inbound-unknown'], [{ waitingUserMessages: 2 }, 'user-message-waiting'],
    [{ nextCheckInAt: undefined }, 'check-in-unknown'],
  ] as const)('%o ⇒ not clean (%s)', (over, reason) => {
    expect(cleanStop(ev(over as Partial<CleanStopEvidence>))).toEqual({ clean: false, reason });
  });
  it('a check-in within 2× the fold duration is too close; just past it is clean', () => {
    expect(cleanStop(ev({ nextCheckInAt: 1_000_000 + 120_000 }))).toEqual({ clean: false, reason: 'check-in-too-close' });
    expect(cleanStop(ev({ nextCheckInAt: 1_000_000 + 120_001 }))).toEqual({ clean: true });
  });
});

describe('openBackgroundTasks', () => {
  const use = (id: string, input: Record<string, unknown>, name = 'Bash', uuid = `u-${id}`) => JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id: string, text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  const note = (task: string, status = 'completed') => JSON.stringify({ type: 'user', message: { content: `<task-notification>\n<task-id>${task}</task-id>\n<status>${status}</status>\n</task-notification>` } });

  it('a background start with its completion is closed; without one it is open', () => {
    const closed = [use('t1', { command: 'npm test', run_in_background: true }), res('t1', 'Command running in background with ID: bkg123.'), note('bkg123')].join('\n');
    expect(openBackgroundTasks(closed)).toBe(0);
    const open = [use('t1', { command: 'npm test', run_in_background: true }), res('t1', 'Command running in background with ID: bkg123.')].join('\n');
    expect(openBackgroundTasks(open)).toBe(1);
  });
  it('a Monitor counts; a start whose id cannot be read is open; ordinary calls do not count', () => {
    const j = [use('m1', { command: 'tail -f x' }, 'Monitor'), res('m1', 'Monitor started (task mon4567, expires in 15m unless the source ends first)'), use('b2', { command: 'ls' }), use('b3', { command: 'x', run_in_background: true }), res('b3', 'no id here')].join('\n');
    expect(openBackgroundTasks(j)).toBe(2);
    expect(openBackgroundTasks([j, note('mon4567')].join('\n'))).toBe(1);
  });
  it('reads the real start shapes (Bash, Monitor, background Agent) and never a bare "task <word>"', () => {
    const j = [
      use('m1', { command: 'x' }, 'Monitor'), res('m1', 'Monitor task started. Task ID: mon12345'), // not a real shape: unread, so open
      use('a1', { prompt: 'p', run_in_background: true }, 'Agent'), res('a1', 'Async agent launched successfully.\nagentId: a579045816e584179 (internal ID)'),
      note('a579045816e584179'),
    ].join('\n');
    expect(openBackgroundTasks(j)).toBe(1);
  });

  it('a completion in one notification block never credits another block\'s task', () => {
    const two = JSON.stringify({ type: 'user', message: { content: '<task-notification>\n<task-id>first111</task-id>\n<status>running</status>\n</task-notification>\n<task-notification>\n<task-id>second22</task-id>\n<status>completed</status>\n</task-notification>' } });
    const j = [use('t1', { command: 'a', run_in_background: true }), res('t1', 'Command running in background with ID: first111.'), use('t2', { command: 'b', run_in_background: true }), res('t2', 'Command running in background with ID: second22.'), two].join('\n');
    expect(openBackgroundTasks(j)).toBe(1); // first111 is still running
  });

  it('a notification quoted in assistant text or an operator message never closes a running task', () => {
    const start = [use('t1', { command: 'x', run_in_background: true }), res('t1', 'Command running in background with ID: bz4k2m9.')];
    const quoted = '<task-notification><task-id>bz4k2m9</task-id><status>completed</status></task-notification>';
    const asAssistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `As the notice says: ${quoted}` }] } });
    const asOperator = JSON.stringify({ type: 'user', message: { content: `[telegram:141133] look: ${quoted}` } });
    const asAssistantString = JSON.stringify({ type: 'assistant', message: { content: quoted } });
    expect(openBackgroundTasks([...start, asAssistant, asOperator, asAssistantString].join('\n'))).toBe(1);
    expect(openBackgroundTasks([...start, note('bz4k2m9')].join('\n'))).toBe(0); // the injected shape does close it
  });

  it('only entries after the last fold boundary count', () => {
    const j = [use('t1', { command: 'x', run_in_background: true }, 'Bash', 'boundary'), use('t2', { command: 'y', run_in_background: true }), res('t2', 'Command running in background with ID: zz9999.'), note('zz9999', 'failed')].join('\n');
    expect(openBackgroundTasks(j, { afterEntry: 'boundary' })).toBe(0);
    expect(openBackgroundTasks(j)).toBe(1);
  });
});

describe('ask brakes', () => {
  const T = '141133';
  it('samples 1 in 3 clean stops reproducibly', () => {
    const a = stateDir(); const b = stateDir();
    const seqA = Array.from({ length: 30 }, (_, i) => brakeOnStop(a, T, i * 10 * 60_000).ask);
    const seqB = Array.from({ length: 30 }, (_, i) => brakeOnStop(b, T, i * 10 * 60_000).ask);
    expect(seqA).toEqual(seqB);
    const asked = seqA.filter(Boolean).length;
    expect(asked).toBeGreaterThan(4);
    expect(asked).toBeLessThan(18);
  });
  it('outside shadow mode every clean stop may ask, until the hourly cap', () => {
    const d = stateDir();
    expect(brakeOnStop(d, T, 0, { shadow: false }).ask).toBe(true);
    for (let i = 0; i < ASK_BRAKES.asksPerHour; i++) recordAsk(d, T, i);
    expect(brakeOnStop(d, T, 10, { shadow: false })).toMatchObject({ ask: false, reason: 'ask-cap' });
    expect(brakeOnStop(d, T, 3_600_100, { shadow: false }).ask).toBe(true); // the window rolls
  });
  it('a backoff holds for 30 minutes', () => {
    const d = stateDir();
    recordBackoff(d, T, 0);
    expect(brakeOnStop(d, T, ASK_BRAKES.backoffMs - 1, { shadow: false })).toMatchObject({ ask: false, reason: 'backoff' });
    expect(brakeOnStop(d, T, ASK_BRAKES.backoffMs, { shadow: false }).ask).toBe(true);
  });
  it('the brake file is private and a torn one starts empty', () => {
    const d = stateDir();
    brakeOnStop(d, T, 0);
    const f = path.join(d, 'state', 'context-layers', T, 'fold-asks.json');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    fs.writeFileSync(f, '{torn');
    expect(brakeOnStop(d, T, 0, { shadow: false })).toMatchObject({ ask: true, stopSeq: 1 });
    expect(() => brakeOnStop(d, '../x', 0)).toThrow();
  });
});
