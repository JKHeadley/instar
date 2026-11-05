/**
 * A tmux name is reused when a conversation comes back to a machine, so a lookup by name
 * must find the session that is live now. Found live on 2026-11-04: a drain closed a
 * finished record and left the running session on the machine the conversation had left.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { pickSessionByTmux } from '../../src/core/pickSessionByTmux.js';

let dir: string; let state: StateManager;
const session = (id: string, status: string, startedAt: string) => ({
  id, name: 'proof-1', status, tmuxSession: 'echo-proof-1', startedAt, framework: 'claude-code',
}) as never;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'by-tmux-'));
  state = new StateManager(dir);
});
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/session-by-tmux.test.ts:cleanup' }));

describe('findSessionByTmux', () => {
  it('the live case: a finished record listed first does not hide the running one', () => {
    state.saveSession(session('00000000-old', 'completed', '2026-11-04T12:33:54.521Z'));
    state.saveSession(session('ffffffff-new', 'running', '2026-11-04T22:30:06.328Z'));
    expect(state.listSessions()[0].status).toBe('completed'); // what `.find` used to return
    expect(state.findSessionByTmux('echo-proof-1')?.id).toBe('ffffffff-new');
  });
  it('a running record wins even when a finished one is newer', () => {
    state.saveSession(session('aaaaaaaa-run', 'running', '2026-11-04T10:00:00.000Z'));
    state.saveSession(session('bbbbbbbb-end', 'completed', '2026-11-04T11:00:00.000Z'));
    expect(state.findSessionByTmux('echo-proof-1')?.id).toBe('aaaaaaaa-run');
  });
  it('with nothing running, the newest record', () => {
    state.saveSession(session('aaaaaaaa-old', 'completed', '2026-11-04T10:00:00.000Z'));
    state.saveSession(session('bbbbbbbb-new', 'killed', '2026-11-04T11:00:00.000Z'));
    expect(state.findSessionByTmux('echo-proof-1')?.id).toBe('bbbbbbbb-new');
  });
  it('an unknown name finds nothing', () => expect(state.findSessionByTmux('nope')).toBeUndefined());
});

describe('pickSessionByTmux', () => {
  it('a finished stdio record does not hide the live http session (Threadline failure reports)', () => {
    const records = [
      { tmuxSession: 'echo-proof-1', status: 'completed', threadlineMcpTransport: 'stdio' },
      { tmuxSession: 'echo-proof-1', status: 'running', threadlineMcpTransport: 'http' },
    ];
    expect(pickSessionByTmux(records, 'echo-proof-1')?.threadlineMcpTransport).toBe('http');
  });
  it('leaves the caller\'s list in its order', () => {
    const records = [
      { tmuxSession: 'a', status: 'completed', startedAt: '2026-11-04T10:00:00.000Z' },
      { tmuxSession: 'a', status: 'completed', startedAt: '2026-11-04T11:00:00.000Z' },
    ];
    const before = [...records];
    expect(pickSessionByTmux(records, 'a')).toBe(before[1]);
    expect(records).toEqual(before);
  });
});

describe('guard: no lookup by tmux name takes the first listed record', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  it('src has none', () => {
    const bad = walk(path.join(process.cwd(), 'src')).filter((f) => {
      if (f.endsWith('DeviceLimitSessionMover.ts')) return false; // injected running list
      return /(listSessions|sessionRecords)\(\)\??\s*\.find\([^\n]*tmuxSession/.test(fs.readFileSync(f, 'utf8'));
    });
    expect(bad).toEqual([]);
  });
});
