// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * A key put in during a usage limit must go into use, and the waiting conversations must answer.
 *
 * B2Lead live proof on nimbus (2026-11-07 14:00-14:51 PST) failed here: the server read a key saved by
 * `instar set-claude-key` only while ClaudeKeyHealth was already alarmed. Under a usage limit it never
 * is, so the usage probe and every restarted session kept the old, walled key; "limited" never ended
 * and no conversation answered (818 s and 1008 s). These tests wire the real ClaudeKeyHealth and the
 * real UsageLimitWatch together the way server.ts does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeKeyHealth, KEY_WATCH_MS, claudeKeyFingerprint } from '../../src/core/ClaudeKeyHealth.js';
import { OPERATOR_OK_TEXT, PROBE_START_MS, UsageLimitWatch } from '../../src/core/UsageLimitWatch.js';

const WALLED = `sk-ant-oat01-${'w'.repeat(40)}`;
const ROOMY = `sk-ant-oat01-${'r'.repeat(40)}`;

function rig(opts: { withSync: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-key-pickup-'));
  const r = {
    dir,
    clock: 1_000_000,
    inUse: WALLED as string | undefined, // config.sessions.anthropicApiKey
    disk: WALLED as string | null,       // .instar/config.json
    sessionsLaunchedWith: [] as Array<string | undefined>,
    probedWith: [] as Array<string | undefined>,
    answeredAfter: new Set<string>(),
    operator: [] as string[],
    logs: [] as string[],
  };
  const keyHealth = new ClaudeKeyHealth({
    stateFile: path.join(dir, 'key.json'),
    currentKey: () => r.inUse,
    currentRawKey: () => r.inUse,
    readKeyFromDisk: () => r.disk,
    applyKey: (k) => { r.inUse = k ?? undefined; },
    probe: async () => 'ok',
    notifyOperator: async () => true,
    notifyPerson: async () => true,
    listStuckSessions: async () => [],
    sessionLaunchFingerprint: () => null,
    refresh: async () => ({ ok: true }),
    clearLoginReports: () => {},
    report: () => {},
    now: () => r.clock,
    manualTimers: true,
  });
  const usage = new UsageLimitWatch({
    stateFile: path.join(dir, 'usage.json'),
    confirmSession: () => true,
    anotherAccountHasRoom: () => false,
    accountKnownToHaveRoom: () => false,
    stillWalled: () => true,
    bannerFor: () => null,
    channelFor: (s) => ({ platform: 'slack', channelId: `D-${s}` }),
    // The real probe uses the key in use; only the key with room answers.
    probe: async () => { r.probedWith.push(r.inUse); return r.inUse === ROOMY ? 'ok' : 'limited'; },
    ...(opts.withSync ? { syncKey: () => keyHealth.refreshKeyFromDisk() } : {}),
    keyFingerprint: () => (r.inUse ? claudeKeyFingerprint(r.inUse) : null),
    isKeyAgent: () => true,
    listWalledSessions: async () => [],
    isSessionRunning: () => true,
    recoveryPrompt: async (s) => ({ prompt: `answer ${s}`, held: 1 }),
    // A restarted session launches on the key in use; it answers only if that key has room.
    refresh: async (s) => {
      r.sessionsLaunchedWith.push(r.inUse);
      if (r.inUse === ROOMY) r.answeredAfter.add(s);
      return { ok: true };
    },
    answeredSince: async (s) => r.answeredAfter.has(s),
    notifyOperator: async (t) => { r.operator.push(t); return true; },
    notifySession: async () => true,
    notifyChannel: async () => true,
    report: () => {},
    now: () => r.clock,
    logger: { log: (m) => r.logs.push(m), warn: (m) => r.logs.push(m) },
    manualTimers: true,
  });
  return { r, keyHealth, usage };
}

describe('a key put in during a usage limit (B2Lead pickup)', () => {
  let t: ReturnType<typeof rig>;
  afterEach(() => { fs.rmSync(t.r.dir, { recursive: true, force: true }); });

  describe('with the key sync wired (the fix)', () => {
    beforeEach(async () => {
      t = rig({ withSync: true });
      await t.keyHealth.boot();
      t.usage.boot();
      t.usage.start();
      await t.usage.noteWall('echo-dm');
      await t.usage.noteWall('gear-dm');
      expect(t.usage.isLimited()).toBe(true);
    });

    it('a working key saved on disk clears "limited" on the next pass, without waiting out the probe backoff', async () => {
      t.r.disk = ROOMY; // instar set-claude-key, no restart
      await t.usage.tick();
      expect(t.r.inUse).toBe(ROOMY);
      expect(t.r.probedWith).toEqual([ROOMY]);
      expect(t.usage.isLimited()).toBe(false);
      expect(t.r.operator.at(-1)).toBe(OPERATOR_OK_TEXT);
    });

    it('the waiting conversations restart on the new key and are answered', async () => {
      t.r.disk = ROOMY;
      await t.usage.tick();
      expect(t.r.sessionsLaunchedWith).toEqual([ROOMY, ROOMY]);
      await t.usage.tick(); // the answer check
      expect([...t.r.answeredAfter].sort()).toEqual(['echo-dm', 'gear-dm']);
      expect(t.usage.status()).toBeNull();
    });

    it('no new key: still limited, the probe tests the key in use, and each probe is logged', async () => {
      await t.usage.tick();
      expect(t.r.probedWith).toEqual([]); // first probe waits
      t.r.clock += PROBE_START_MS;
      await t.usage.tick();
      expect(t.r.probedWith).toEqual([WALLED]);
      expect(t.usage.isLimited()).toBe(true);
      expect(t.r.sessionsLaunchedWith).toEqual([]);
      expect(t.r.logs).toContain('[UsageLimitWatch] usage probe: limited (limited)');
    });

    it('another key that is also out of usage keeps the limit and restarts nothing', async () => {
      const ALSO_WALLED = `sk-ant-oat01-${'x'.repeat(40)}`;
      t.r.disk = ALSO_WALLED;
      await t.usage.tick();
      expect(t.r.probedWith).toEqual([ALSO_WALLED]);
      expect(t.usage.isLimited()).toBe(true);
      expect(t.r.sessionsLaunchedWith).toEqual([]);
    });
  });

  it('without the sync (the 2026-11-07 failure): the saved key is never used and the limit never ends', async () => {
    t = rig({ withSync: false });
    await t.keyHealth.boot();
    t.usage.boot();
    t.usage.start();
    await t.usage.noteWall('echo-dm');
    t.r.disk = ROOMY;
    for (let i = 0; i < 4; i++) { t.r.clock += PROBE_START_MS * 3; await t.usage.tick(); }
    expect(t.r.inUse).toBe(WALLED);
    expect(t.r.probedWith.every((k) => k === WALLED)).toBe(true);
    expect(t.usage.isLimited()).toBe(true);
  });
});

describe('ClaudeKeyHealth reads a saved key while the key is fine', () => {
  const KEY_A = `sk-ant-oat01-${'a'.repeat(40)}`;
  const KEY_B = `sk-ant-oat01-${'b'.repeat(40)}`;
  const make = (manualTimers: boolean) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-watch-'));
    const r = { dir, inUse: KEY_A as string | undefined, disk: KEY_A as string | null | undefined, applied: 0 };
    const h = new ClaudeKeyHealth({
      stateFile: path.join(dir, 'key.json'),
      currentKey: () => r.inUse,
      currentRawKey: () => r.inUse,
      readKeyFromDisk: () => r.disk,
      applyKey: (k) => { r.inUse = k ?? undefined; r.applied += 1; },
      probe: async () => 'ok',
      notifyOperator: async () => true,
      notifyPerson: async () => true,
      listStuckSessions: async () => [],
      sessionLaunchFingerprint: () => null,
      refresh: async () => ({ ok: true }),
      clearLoginReports: () => {},
      report: () => {},
      manualTimers,
    });
    return { r, h };
  };

  it('refreshKeyFromDisk puts a changed key into use, and leaves an unchanged or unreadable one alone', async () => {
    const { r, h } = make(true);
    await h.boot();
    expect(h.status()?.status ?? 'ok').toBe('ok');
    h.refreshKeyFromDisk();
    expect(r.applied).toBe(0);
    r.disk = undefined; // unreadable: keep the last key
    h.refreshKeyFromDisk();
    expect(r.inUse).toBe(KEY_A);
    r.disk = KEY_B;
    h.refreshKeyFromDisk();
    expect(r.inUse).toBe(KEY_B);
    expect(r.applied).toBe(1);
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  it('a read that throws is logged, never thrown', async () => {
    const { r, h } = make(true);
    await h.boot();
    (h as unknown as { deps: { readKeyFromDisk: () => never } }).deps.readKeyFromDisk = () => { throw new Error('EACCES'); };
    expect(() => h.refreshKeyFromDisk()).not.toThrow();
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  it('its own watch picks up the key with no alarm and no session at the login screen', async () => {
    vi.useFakeTimers();
    try {
      const { r, h } = make(false);
      await h.boot();
      r.disk = KEY_B;
      vi.advanceTimersByTime(KEY_WATCH_MS);
      expect(r.inUse).toBe(KEY_B);
      h.stop();
      r.disk = KEY_A;
      vi.advanceTimersByTime(KEY_WATCH_MS * 3);
      expect(r.inUse).toBe(KEY_B); // stopped means stopped
      fs.rmSync(r.dir, { recursive: true, force: true });
    } finally { vi.useRealTimers(); }
  });
});

describe('server wiring', () => {
  const server = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
  const block = server.slice(server.indexOf('new UsageLimitWatch({'), server.indexOf('usageLimitWatch.boot();'));
  it('the usage watch syncs the saved key through the key monitor before it reads the fingerprint', () => {
    expect(block).toContain('syncKey: () => claudeKeyHealth.refreshKeyFromDisk(),');
    expect(server.indexOf('const claudeKeyHealth = new ClaudeKeyHealth({')).toBeLessThan(server.indexOf('new UsageLimitWatch({'));
  });
});

describe('reading the saved key for the watch', () => {
  it('a secret-store placeholder is unreadable (keep the key in use), never "no key"', async () => {
    const { readConfiguredAnthropicKey } = await import('../../src/core/Config.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-read-'));
    const write = (sessions: unknown) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sessions }));
    try {
      write({ credentials: { anthropic: { kind: 'oauth-token', value: { secret: true } } } });
      expect(readConfiguredAnthropicKey(dir)).toBeUndefined();
      write({ anthropicApiKey: { secret: true } });
      expect(readConfiguredAnthropicKey(dir)).toBeUndefined();
      write({ credentials: { anthropic: { kind: 'oauth-token', value: ROOMY } } });
      expect(readConfiguredAnthropicKey(dir)).toBe(ROOMY);
      write({});
      expect(readConfiguredAnthropicKey(dir)).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a session walled on its very first turn (no hook ever reported its transcript id)', () => {
  // Shapes measured on nimbus 2026-11-07, Claude Code 2.1.319.
  const SID = '4ae633ea-8857-4fe2-a302-453a5c6bf1b8';
  const TMUX = 'nimbus-interactive-1794095060111';
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-')); fs.mkdirSync(path.join(home, 'sessions')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const pidFile = (pid: number, row: Record<string, unknown>) =>
    fs.writeFileSync(path.join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, cwd: '/home/agent/.instar/agents/nimbus', kind: 'interactive', ...row }));
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  it('reads the id Claude Code recorded for exactly this tmux session', async () => {
    const { claudeSessionIdFromPidFiles } = await import('../../src/monitoring/sessionUsageLimitEvidence.js');
    pidFile(2326605, { sessionId: SID, tmux: `${TMUX}:@0.%0`, startedAt: 1794095061775 });
    pidFile(2326735, { sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', tmux: 'nimbus-interactive-1794095062106:@0.%0', startedAt: 1794095063000 });
    expect(claudeSessionIdFromPidFiles(home, TMUX, alive([2326605, 2326735]))).toBe(SID);
  });

  it('never guesses: a name that only shares a prefix, a dead process, an unsafe id, a renamed file, no folder', async () => {
    const { claudeSessionIdFromPidFiles } = await import('../../src/monitoring/sessionUsageLimitEvidence.js');
    pidFile(11, { sessionId: SID, tmux: `${TMUX}0:@0.%0` }); // nimbus-interactive-...1110
    expect(claudeSessionIdFromPidFiles(home, TMUX, alive([11]))).toBeNull();
    pidFile(12, { sessionId: SID, tmux: `${TMUX}:@0.%0` });
    expect(claudeSessionIdFromPidFiles(home, TMUX, alive([]))).toBeNull();
    pidFile(13, { sessionId: '--resume', tmux: `${TMUX}:@0.%0` });
    pidFile(14, { pid: 99, sessionId: SID, tmux: `${TMUX}:@0.%0` });
    expect(claudeSessionIdFromPidFiles(home, TMUX, alive([13, 14, 99]))).toBeNull();
    expect(claudeSessionIdFromPidFiles(path.join(home, 'nope'), TMUX, alive([12]))).toBeNull();
  });

  it('the newest live process wins when a pane was relaunched', async () => {
    const { claudeSessionIdFromPidFiles } = await import('../../src/monitoring/sessionUsageLimitEvidence.js');
    pidFile(20, { sessionId: 'old-11111111', tmux: `${TMUX}:@0.%0`, startedAt: 1 });
    pidFile(21, { sessionId: SID, tmux: `${TMUX}:@0.%0`, startedAt: 2 });
    expect(claudeSessionIdFromPidFiles(home, TMUX, alive([20, 21]))).toBe(SID);
  });

  it('SessionManager proves the wall from the transcript and binds the id; without the record it still says no', async () => {
    const { SessionManager } = await import('../../src/core/SessionManager.js');
    const projectDir = '/home/agent/.instar/agents/nimbus';
    const projects = path.join(home, 'projects', projectDir.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, `${SID}.jsonl`), [
      { type: 'user', sessionId: SID, message: { role: 'user', content: '[slack:D0CEF9FC8UB] Proof 2, Echo: reply with exactly ECHO-USE.' } },
      { type: 'assistant', sessionId: SID, isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets 11am (UTC)" }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    pidFile(process.pid, { sessionId: SID, tmux: `${TMUX}:@0.%0`, startedAt: 1 }); // this test process is alive
    const bound: Array<[string, string]> = [];
    const fake = {
      listRunningSessions: () => [{ id: 'inst-1', tmuxSession: TMUX, framework: 'claude-code', cwd: projectDir }],
      configHomeForSession: () => home,
      config: { projectDir },
      setClaudeSessionId: (a: string, b: string) => { bound.push([a, b]); },
    };
    const confirm = (SessionManager.prototype as unknown as { confirmSessionUsageLimit: (this: unknown, t: string) => string | false }).confirmSessionUsageLimit;
    expect(confirm.call(fake, TMUX)).toBe(SID);
    expect(bound).toEqual([['inst-1', SID]]);
    fs.rmSync(path.join(home, 'sessions', `${process.pid}.json`));
    bound.length = 0;
    expect(confirm.call(fake, TMUX)).toBe(false);
    expect(bound).toEqual([]);
  });
});

// One private tmux server for the whole block. Killing the server after each test and starting
// a new one on the same socket raced on the CI runner: the next `new-session` reached the dying
// server and failed (CI run 42431009814, shard 4/4 on node 20 and 22). The second test does not
// touch tmux at all, so one server, started once and killed once, is also the honest shape.
const { execFileSync: realExecFileSync, spawnSync: realSpawnSync } = require('node:child_process') as typeof import('node:child_process');
// Every lane that runs this file has tmux (CI builds 3.6a; the verifiers run real sessions).
const realTmux = (() => { const w = realSpawnSync('which', ['tmux'], { encoding: 'utf-8' }); return w.status === 0 && w.stdout.trim() ? w.stdout.trim() : 'tmux'; })();

describe('which Claude home a session runs on, read from real tmux', () => {
  const sock = `ulw-test-${process.pid}-${Date.now()}`;
  let dir: string; let tmuxPath: string;
  // stderr is kept so a failure names tmux's own reason instead of a bare "Command failed".
  const tmux = (...a: string[]) => realExecFileSync(realTmux, ['-L', sock, '-f', '/dev/null', ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-wrap-'));
    tmuxPath = path.join(dir, 'tmux');
    fs.writeFileSync(tmuxPath, `#!/bin/sh\nexec ${realTmux} -L ${sock} "$@"\n`, { mode: 0o755 });
    tmux('new-session', '-d', '-s', 'absent', 'sleep 60');
    tmux('new-session', '-d', '-s', 'removed', 'sleep 60'); tmux('set-environment', '-t', 'removed', '-r', 'CLAUDE_CONFIG_DIR');
    tmux('new-session', '-d', '-s', 'pinned', 'sleep 60'); tmux('set-environment', '-t', 'pinned', 'CLAUDE_CONFIG_DIR', '/x/.claude-acct');
  });
  afterAll(() => { try { tmux('kill-server'); } catch { /* already gone */ } fs.rmSync(dir, { recursive: true, force: true }); });

  it('a session that never had CLAUDE_CONFIG_DIR runs on the default home, but only for a reader that opts in', async () => {
    const { SessionManager } = await import('../../src/core/SessionManager.js');
    const read = (SessionManager.prototype as unknown as { configHomeForSession: (this: unknown, s: string, o?: object) => string | undefined }).configHomeForSession;
    const self = { config: { tmuxPath } };
    const def = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    expect(read.call(self, 'absent', { defaultWhenUnset: true })).toBeUndefined(); // unchanged for every other reader
    expect(read.call(self, 'absent', { defaultWhenUnset: true, defaultWhenAbsent: true })).toBe(def);
    expect(read.call(self, 'removed', { defaultWhenUnset: true })).toBe(def);
    expect(read.call(self, 'pinned', { defaultWhenUnset: true, defaultWhenAbsent: true })).toBe('/x/.claude-acct');
    expect(read.call(self, 'no-such-session', { defaultWhenUnset: true, defaultWhenAbsent: true })).toBeUndefined();
  });

  it('the usage proof opts in', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/SessionManager.ts'), 'utf8');
    const at = src.indexOf('confirmSessionUsageLimit(tmuxSession: string)');
    expect(src.slice(at, at + 900)).toContain('{ defaultWhenUnset: true, defaultWhenAbsent: true }');
  });
});
