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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
