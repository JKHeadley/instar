// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Wiring-integrity + semantic tests for sentinelWiring.
 *
 * These are the tests that would have caught the PR #334 bug: the two
 * sentinels shipped as orphan classes, never instantiated, and the release
 * notes falsely claimed "wired into server startup". A wiring-integrity test
 * asserts the deps are real functions that delegate to the underlying
 * SessionManager primitives — not nulls or silent no-ops.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

import { describe, it, expect } from 'vitest';
import {
  makeAttentionPoster,
  buildSocketDisconnectDeps,
  buildActiveWorkSilenceDeps,
  buildContextWedgeDeps,
  OutputActivityTracker,
  looksActivelyWorking,
  type SentinelSessionSurface,
} from '../../../src/monitoring/sentinelWiring.js';

interface Call { tmuxSession: string; key?: string; lines?: number; }

function makeSurface(opts: {
  sessions?: Array<{ tmuxSession: string; framework?: string }>;
  output?: string | ((s: string) => string);
  alive?: boolean;
  sendKeyResult?: boolean;
  captureCalls?: Call[];
  keyCalls?: Call[];
} = {}): SentinelSessionSurface {
  const sessions = opts.sessions ?? [{ tmuxSession: 'agent-1' }];
  const captureCalls = opts.captureCalls ?? [];
  const keyCalls = opts.keyCalls ?? [];
  return {
    captureOutput: (tmuxSession, lines) => {
      captureCalls.push({ tmuxSession, lines });
      if (typeof opts.output === 'function') return opts.output(tmuxSession);
      return opts.output ?? null;
    },
    isSessionAlive: () => opts.alive ?? true,
    sendKey: (tmuxSession, key) => {
      keyCalls.push({ tmuxSession, key });
      return opts.sendKeyResult ?? true;
    },
    listRunningSessions: () => sessions,
  };
}

describe('makeAttentionPoster', () => {
  it('returns true on 201 (delivered)', async () => {
    const fetchImpl = (async () => ({ status: 201 })) as unknown as typeof fetch;
    const post = makeAttentionPoster({ port: 4040, authToken: 'tok', fetchImpl });
    expect(await post({ id: 'x', title: 't', summary: 's' })).toBe(true);
  });

  it('returns false on 422 (tone-gate block — the gate doing its job)', async () => {
    const fetchImpl = (async () => ({ status: 422 })) as unknown as typeof fetch;
    const post = makeAttentionPoster({ port: 4040, authToken: 'tok', fetchImpl });
    expect(await post({ id: 'x', title: 't', summary: 's' })).toBe(false);
  });

  it('returns false (does not throw) on network error', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const post = makeAttentionPoster({ port: 4040, authToken: 'tok', fetchImpl });
    expect(await post({ id: 'x', title: 't', summary: 's' })).toBe(false);
  });

  it('posts to /attention with category degradation + bearer auth', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedAuth = '';
    const fetchImpl = (async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      capturedAuth = init.headers.Authorization;
      return { status: 201 };
    }) as unknown as typeof fetch;
    const post = makeAttentionPoster({ port: 4242, authToken: 'sekret', fetchImpl });
    await post({ id: 'socket-disconnect:agent-1', title: 'T', summary: 'S' });
    expect(capturedUrl).toBe('http://localhost:4242/attention');
    expect(capturedBody.category).toBe('degradation');
    expect(capturedBody.id).toBe('socket-disconnect:agent-1');
    expect(capturedAuth).toBe('Bearer sekret');
  });
});

describe('buildSocketDisconnectDeps — wiring integrity', () => {
  it('all deps are real functions, not null/no-op', () => {
    const deps = buildSocketDisconnectDeps({ sessions: makeSurface(), escalate: async () => {} });
    expect(typeof deps.getRecentOutput).toBe('function');
    expect(typeof deps.resumeFn).toBe('function');
    expect(typeof deps.notifyFn).toBe('function');
    expect(typeof deps.listSessionNames).toBe('function');
  });

  it('getRecentOutput delegates to captureOutput and coerces null → empty string', () => {
    const captureCalls: Call[] = [];
    const surface = makeSurface({ output: null, captureCalls });
    const deps = buildSocketDisconnectDeps({ sessions: surface, escalate: async () => {} });
    expect(deps.getRecentOutput('agent-1')).toBe('');
    expect(captureCalls.length).toBe(1);
    expect(captureCalls[0].tmuxSession).toBe('agent-1');
  });

  it('resumeFn returns false when the session is not alive (no key sent)', async () => {
    const keyCalls: Call[] = [];
    const surface = makeSurface({ alive: false, keyCalls });
    const deps = buildSocketDisconnectDeps({ sessions: surface, escalate: async () => {} });
    expect(await deps.resumeFn('agent-1')).toBe(false);
    expect(keyCalls.length).toBe(0);
  });

  it('resumeFn sends a bare Enter (not Ctrl+C) when alive', async () => {
    const keyCalls: Call[] = [];
    const surface = makeSurface({ alive: true, keyCalls });
    const deps = buildSocketDisconnectDeps({ sessions: surface, escalate: async () => {} });
    expect(await deps.resumeFn('agent-1')).toBe(true);
    expect(keyCalls).toEqual([{ tmuxSession: 'agent-1', key: 'Enter' }]);
  });

  it('notifyFn delegates the (sessionName, text) pair to the escalate callback', async () => {
    const calls: Array<{ name: string; text: string }> = [];
    const deps = buildSocketDisconnectDeps({
      sessions: makeSurface(),
      escalate: async (name, text) => { calls.push({ name, text }); },
    });
    await deps.notifyFn('agent-1', 'lost its connection');
    expect(calls).toEqual([{ name: 'agent-1', text: 'lost its connection' }]);
  });

  it('listSessionNames maps running sessions to their tmux names', () => {
    const surface = makeSurface({ sessions: [{ tmuxSession: 'a' }, { tmuxSession: 'b' }] });
    const deps = buildSocketDisconnectDeps({ sessions: surface, escalate: async () => {} });
    expect(deps.listSessionNames!()).toEqual(['a', 'b']);
  });
});

describe('buildContextWedgeDeps — wiring integrity + recovery policy', () => {
  it('all deps are real functions, not null/no-op', () => {
    const deps = buildContextWedgeDeps({
      sessions: makeSurface(),
      escalate: async () => {},
      autoRecovery: { enabled: false },
      freshRespawn: async () => true,
    });
    expect(typeof deps.getRecentOutput).toBe('function');
    expect(typeof deps.recoverFn).toBe('function');
    expect(typeof deps.notifyFn).toBe('function');
    expect(typeof deps.listSessionNames).toBe('function');
  });

  it('getRecentOutput delegates to captureOutput and coerces null → empty string', () => {
    const captureCalls: Call[] = [];
    const surface = makeSurface({ output: null, captureCalls });
    const deps = buildContextWedgeDeps({
      sessions: surface, escalate: async () => {},
      autoRecovery: { enabled: false }, freshRespawn: async () => true,
    });
    expect(deps.getRecentOutput('agent-1')).toBe('');
    expect(captureCalls.length).toBe(1);
  });

  it("recoverFn → 'detect-only' when autoRecovery disabled (freshRespawn NOT called)", async () => {
    let respawnCalls = 0;
    const deps = buildContextWedgeDeps({
      sessions: makeSurface(), escalate: async () => {},
      autoRecovery: { enabled: false },
      freshRespawn: async () => { respawnCalls++; return true; },
    });
    expect(await deps.recoverFn('agent-1')).toBe('detect-only');
    expect(respawnCalls).toBe(0);
  });

  it("recoverFn → 'dry-run' when enabled + dryRun (freshRespawn NOT called)", async () => {
    let respawnCalls = 0;
    const deps = buildContextWedgeDeps({
      sessions: makeSurface(), escalate: async () => {},
      autoRecovery: { enabled: true, dryRun: true },
      freshRespawn: async () => { respawnCalls++; return true; },
    });
    expect(await deps.recoverFn('agent-1')).toBe('dry-run');
    expect(respawnCalls).toBe(0);
  });

  it("recoverFn → 'respawned' when enabled + live and freshRespawn succeeds", async () => {
    const deps = buildContextWedgeDeps({
      sessions: makeSurface(), escalate: async () => {},
      autoRecovery: { enabled: true, dryRun: false },
      freshRespawn: async () => true,
    });
    expect(await deps.recoverFn('agent-1')).toBe('respawned');
  });

  it("recoverFn → 'failed' when freshRespawn returns false", async () => {
    const deps = buildContextWedgeDeps({
      sessions: makeSurface(), escalate: async () => {},
      autoRecovery: { enabled: true, dryRun: false },
      freshRespawn: async () => false,
    });
    expect(await deps.recoverFn('agent-1')).toBe('failed');
  });

  it("recoverFn → 'failed' when freshRespawn throws (no crash)", async () => {
    const deps = buildContextWedgeDeps({
      sessions: makeSurface(), escalate: async () => {},
      autoRecovery: { enabled: true, dryRun: false },
      freshRespawn: async () => { throw new Error('boom'); },
    });
    expect(await deps.recoverFn('agent-1')).toBe('failed');
  });

  it('notifyFn delegates the (sessionName, text) pair to escalate', async () => {
    const calls: Array<{ name: string; text: string }> = [];
    const deps = buildContextWedgeDeps({
      sessions: makeSurface(),
      escalate: async (name, text) => { calls.push({ name, text }); },
      autoRecovery: { enabled: false }, freshRespawn: async () => true,
    });
    await deps.notifyFn('agent-1', 'wedged');
    expect(calls).toEqual([{ name: 'agent-1', text: 'wedged' }]);
  });

  it('listSessionNames maps running sessions to tmux names', () => {
    const surface = makeSurface({ sessions: [{ tmuxSession: 'a' }, { tmuxSession: 'b' }] });
    const deps = buildContextWedgeDeps({
      sessions: surface, escalate: async () => {},
      autoRecovery: { enabled: false }, freshRespawn: async () => true,
    });
    expect(deps.listSessionNames!()).toEqual(['a', 'b']);
  });
});

describe('looksActivelyWorking — both sides of the boundary', () => {
  it('true when a Claude spinner glyph is present', () => {
    expect(looksActivelyWorking('⠹ thinking...', 'claude-code')).toBe(true);
  });

  it('true when "esc to interrupt" is visible', () => {
    expect(looksActivelyWorking('Running Bash... (esc to interrupt)', 'claude-code')).toBe(true);
  });

  it('true on a tool-call frame', () => {
    expect(looksActivelyWorking('Read(src/foo.ts)', 'claude-code')).toBe(true);
  });

  it('false on an idle prompt frame', () => {
    expect(looksActivelyWorking('> \n  ? for shortcuts', 'claude-code')).toBe(false);
  });

  it('false on empty output', () => {
    expect(looksActivelyWorking('', 'claude-code')).toBe(false);
  });

  it('recognizes a Codex active frame when given the codex framework', () => {
    // "generating" is a codex-cli active signature, NOT a claude-code one —
    // proves the per-session framework is actually used (regression guard for
    // the second-pass finding where framework was never populated).
    expect(looksActivelyWorking('codex is generating a response', 'codex-cli')).toBe(true);
  });
});

describe('OutputActivityTracker — per-session framework is honored', () => {
  it('classifies a Codex active frame as not paused when framework=codex-cli', () => {
    const surface = makeSurface({
      output: 'exec(npm test) streaming...',
      sessions: [{ tmuxSession: 'codex-1', framework: 'codex-cli' }],
    });
    const tracker = new OutputActivityTracker(surface);
    expect(tracker.snapshot()[0].paused).toBe(false);
  });
});

describe('OutputActivityTracker — change detection + active/idle filtering', () => {
  it('reports lastOutputAt 0 on first sighting (no observed change yet → sentinel skips it)', () => {
    // Regression guard for the 2026-05-22 flood: a session we have only seen
    // once must NOT be treated as "was producing output". lastOutputAt 0 means
    // the silence sentinel's `lastOutputAt <= 0` guard skips it.
    const surface = makeSurface({ output: '⠹ working', sessions: [{ tmuxSession: 'agent-1' }] });
    const tracker = new OutputActivityTracker(surface, () => 1_000_000);
    expect(tracker.snapshot()[0].lastOutputAt).toBe(0);
  });

  it('a never-changing active-looking frame stays at lastOutputAt 0 (frozen-since-before-start guard)', () => {
    // This is the exact flood scenario: a long-dead session whose frozen last
    // frame contains "esc to interrupt". looksActivelyWorking is true, but the
    // hash never changes — so it must never become silence-eligible.
    let now = 1_000_000;
    const surface = makeSurface({
      output: 'Running Bash(npm test) (esc to interrupt)',
      sessions: [{ tmuxSession: 'zombie-1' }],
    });
    const tracker = new OutputActivityTracker(surface, () => now);
    for (let i = 0; i < 30; i++) { now += 60_000; }
    // Even after 30 minutes of ticks, the never-changed frame is still 0.
    expect(tracker.snapshot()[0].lastOutputAt).toBe(0);
    now += 60_000;
    expect(tracker.snapshot()[0].lastOutputAt).toBe(0);
  });

  it('lastOutputAt is set only after an observed change, then holds steady until the next change', () => {
    let now = 1_000_000;
    let frame = '⠹ working step 1';
    const surface = makeSurface({ output: () => frame, sessions: [{ tmuxSession: 'agent-1' }] });
    const tracker = new OutputActivityTracker(surface, () => now);
    // First sighting → 0 (unconfirmed).
    expect(tracker.snapshot()[0].lastOutputAt).toBe(0);
    // Observed change → stamped at the change time.
    now += 60_000;
    frame = '⠹ working step 2';
    const changed = tracker.snapshot()[0];
    expect(changed.lastOutputAt).toBe(now);
    // Unchanged again → holds steady at the last change time (does NOT advance).
    now += 60_000;
    expect(tracker.snapshot()[0].lastOutputAt).toBe(changed.lastOutputAt);
  });

  it('marks an active (mid-task) frame as not paused', () => {
    const surface = makeSurface({ output: 'Bash(npm test) (esc to interrupt)' });
    const tracker = new OutputActivityTracker(surface);
    expect(tracker.snapshot()[0].paused).toBe(false);
  });

  it('marks an idle-prompt frame as paused (sentinel will skip it)', () => {
    const surface = makeSurface({ output: '> \n  ? for shortcuts' });
    const tracker = new OutputActivityTracker(surface);
    expect(tracker.snapshot()[0].paused).toBe(true);
  });

  it('drops tracking for sessions that have ended', () => {
    let sessions = [{ tmuxSession: 'agent-1' }, { tmuxSession: 'agent-2' }];
    const surface: SentinelSessionSurface = {
      captureOutput: () => '⠹ working',
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => sessions,
    };
    const tracker = new OutputActivityTracker(surface);
    expect(tracker.snapshot().length).toBe(2);
    sessions = [{ tmuxSession: 'agent-1' }];
    expect(tracker.snapshot().map(s => s.sessionName)).toEqual(['agent-1']);
  });
});

describe('buildActiveWorkSilenceDeps — wiring integrity', () => {
  it('listSessions delegates to the tracker snapshot', () => {
    const surface = makeSurface({ output: '⠹ working', sessions: [{ tmuxSession: 'agent-1' }] });
    const tracker = new OutputActivityTracker(surface);
    const deps = buildActiveWorkSilenceDeps({ tracker, sessions: surface, escalate: async () => {} });
    const list = deps.listSessions();
    expect(list[0].sessionName).toBe('agent-1');
  });

  it('nudgeFn alive-gates then sends Enter', async () => {
    const keyCalls: Call[] = [];
    const surface = makeSurface({ alive: true, keyCalls });
    const tracker = new OutputActivityTracker(surface);
    const deps = buildActiveWorkSilenceDeps({ tracker, sessions: surface, escalate: async () => {} });
    expect(await deps.nudgeFn('agent-1')).toBe(true);
    expect(keyCalls).toEqual([{ tmuxSession: 'agent-1', key: 'Enter' }]);
  });

  it('nudgeFn returns false (no key) when the session is dead', async () => {
    const keyCalls: Call[] = [];
    const surface = makeSurface({ alive: false, keyCalls });
    const tracker = new OutputActivityTracker(surface);
    const deps = buildActiveWorkSilenceDeps({ tracker, sessions: surface, escalate: async () => {} });
    expect(await deps.nudgeFn('agent-1')).toBe(false);
    expect(keyCalls.length).toBe(0);
  });

  it('notifyFn delegates the (sessionName, text) pair to the escalate callback', async () => {
    const calls: Array<{ name: string; text: string }> = [];
    const surface = makeSurface();
    const tracker = new OutputActivityTracker(surface);
    const deps = buildActiveWorkSilenceDeps({
      tracker, sessions: surface,
      escalate: async (name, text) => { calls.push({ name, text }); },
    });
    await deps.notifyFn('agent-1', 'went quiet');
    expect(calls).toEqual([{ name: 'agent-1', text: 'went quiet' }]);
  });
});
