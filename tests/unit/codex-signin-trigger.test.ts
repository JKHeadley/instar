// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * SessionManager.checkCodexSigninTrigger (spec codex-device-limit-tripwire §2 B): a Codex session
 * whose live tail keeps looking like a sign-in problem for 60 s asks the quota poller for ONE
 * fresh read. Brakes: one request per 10 min; after a read found the account working, quiet until
 * the tail changes or 60 min pass. The screen is never judged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
  execFile: vi.fn().mockImplementation((_c: string, _a: string[], o: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
    if (typeof o === 'function') cb = o as typeof cb;
    cb?.(null, { stdout: '' });
  }),
}));

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const T0 = Date.parse('2026-10-31T12:00:00Z');
const SEC = 1000;
const MIN = 60 * SEC;
const SIGNIN = 'Error: you have been signed out on this device. Please log in again.';

describe('SessionManager.checkCodexSigninTrigger', () => {
  let tmpDir: string;
  let clock = T0;
  let pane = '';
  let calls: Array<{ accountId: string; session: string }>;
  let working: boolean | void = undefined;
  let sm: SessionManager;
  let check: (session: Record<string, unknown>) => Promise<void>;

  const session = (extra: Record<string, unknown> = {}) => ({
    id: 's1', name: 'codex-topic', tmuxSession: 'proj-codex-topic', status: 'running',
    framework: 'codex-cli', subscriptionAccountId: 'acct-a', startedAt: new Date(T0).toISOString(), ...extra,
  });
  /** Advance the clock and run one tick's check. */
  const tick = async (ms: number, s = session()) => { clock += ms; await check(s); };

  beforeEach(() => {
    clock = T0;
    pane = SIGNIN;
    calls = [];
    working = undefined;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-signin-'));
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude', projectName: 'proj', projectDir: tmpDir,
      maxSessions: 10, protectedSessions: [], completionPatterns: [],
    };
    sm = new SessionManager(config, new StateManager(stateDir));
    (sm as unknown as { captureOutputMaybeAsync: () => Promise<string> }).captureOutputMaybeAsync = async () => pane;
    sm.setCodexSigninTriggerSink(async (input) => { calls.push(input); return working; });
    check = (s) => (sm as unknown as { checkCodexSigninTrigger: (s: unknown) => Promise<void> }).checkCodexSigninTrigger(s);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/codex-signin-trigger.test.ts' });
  });

  it('a broad match held 60 s calls the sink once, not before the dwell', async () => {
    await tick(0);
    await tick(20 * SEC);
    await tick(20 * SEC);
    expect(calls).toHaveLength(0);
    await tick(20 * SEC); // 60 s since first seen
    expect(calls).toEqual([{ accountId: 'acct-a', session: 'proj-codex-topic' }]);
    await tick(20 * SEC);
    await tick(20 * SEC);
    expect(calls).toHaveLength(1);
  });

  it('captures at most once per 20 s', async () => {
    let captures = 0;
    (sm as unknown as { captureOutputMaybeAsync: () => Promise<string> }).captureOutputMaybeAsync = async () => { captures++; return pane; };
    await tick(0);
    await tick(5 * SEC);
    await tick(5 * SEC);
    expect(captures).toBe(1);
    await tick(10 * SEC);
    expect(captures).toBe(2);
  });

  it('retry window: a persisting screen asks again only after 10 min', async () => {
    await tick(0); await tick(20 * SEC); await tick(20 * SEC); await tick(20 * SEC);
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 29; i++) await tick(20 * SEC); // 9 min 40 s later
    expect(calls).toHaveLength(1);
    await tick(20 * SEC); // 10 min after the request
    expect(calls).toHaveLength(2);
  });

  it('sink returning true ⇒ quiet for the same tail until it changes or 60 min pass', async () => {
    working = true;
    await tick(0); await tick(20 * SEC); await tick(20 * SEC); await tick(20 * SEC);
    expect(calls).toHaveLength(1);
    await tick(11 * MIN); // same tail, past the retry window: still quiet
    await tick(20 * MIN);
    expect(calls).toHaveLength(1);
    pane = `${SIGNIN}\nPlease sign in again (device limit)`; // the tail changed
    await tick(20 * SEC);
    expect(calls).toHaveLength(2);
  });

  it('quiet ends after 60 min for an unchanged tail', async () => {
    working = true;
    await tick(0); await tick(20 * SEC); await tick(20 * SEC); await tick(20 * SEC);
    await tick(59 * MIN);
    expect(calls).toHaveLength(1);
    await tick(61 * SEC);
    expect(calls).toHaveLength(2);
  });

  it('relogin- sessions and sessions without a pool account are skipped', async () => {
    const relogin = session({ tmuxSession: 'relogin-42', name: 'relogin-42' });
    const nameOnly = session({ tmuxSession: 'proj-x', name: 'relogin-x' });
    const noAcct = session({ tmuxSession: 'proj-y', subscriptionAccountId: undefined });
    for (const s of [relogin, nameOnly, noAcct]) {
      clock = T0;
      for (let i = 0; i < 6; i++) await tick(20 * SEC, s);
    }
    expect(calls).toHaveLength(0);
  });

  it('no match clears the state, so the dwell restarts', async () => {
    await tick(0); await tick(20 * SEC); await tick(20 * SEC);
    pane = 'Working on your task…';
    await tick(20 * SEC);
    pane = SIGNIN;
    await tick(20 * SEC); // first seen again
    await tick(20 * SEC);
    await tick(20 * SEC);
    expect(calls).toHaveLength(0);
    await tick(20 * SEC);
    expect(calls).toHaveLength(1);
  });

  it('a throwing sink never escapes the tick and is retried after the window', async () => {
    sm.setCodexSigninTriggerSink(async (input) => { calls.push(input); throw new Error('poller down'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await tick(0); await tick(20 * SEC); await tick(20 * SEC);
    await expect(tick(20 * SEC)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    await tick(10 * MIN);
    expect(calls).toHaveLength(2);
  });

  it('no sink ⇒ nothing captured', async () => {
    sm.setCodexSigninTriggerSink(null);
    let captures = 0;
    (sm as unknown as { captureOutputMaybeAsync: () => Promise<string> }).captureOutputMaybeAsync = async () => { captures++; return pane; };
    await tick(0);
    expect(captures).toBe(0);
  });
});
