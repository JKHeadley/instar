import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeKeyHealth,
  claudeKeyFingerprint,
  decideKeyRefresh,
  nextProbeDelay,
  type ClaudeKeyHealthDeps,
  type ClaudeKeyProbeResult,
  DEAD_PROBE_START_MS,
  NOTICE_MAX_ATTEMPTS,
  OK_MIN_PROBE_INTERVAL_MS,
  OPERATOR_DEAD_TEXT,
  OPERATOR_OK_TEXT,
  PROBE_BREAKER_MS,
  PROBE_CEILING_MS,
  REFRESH_BATCH,
  REFRESH_MAX_ATTEMPTS,
} from '../../src/core/ClaudeKeyHealth.js';
import { classifyClaudeAuthFailure } from '../../src/core/claudeChildAuth.js';
import { interpretProbe } from '../../src/core/claudeKeyProbe.js';

const KEY_A = `sk-ant-oat01-${'a'.repeat(40)}`;
const KEY_B = `sk-ant-oat01-${'b'.repeat(40)}`;

// Real output of Claude Code 2.1.316, measured 2026-11-03.
const REJECTED = JSON.stringify({ is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' });
const NOT_LOGGED_IN = JSON.stringify({ is_error: true, api_error_status: null, result: 'Not logged in · Please run /login' });

function rig(overrides: Partial<ClaudeKeyHealthDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-key-health-'));
  const r = {
    stateFile: path.join(dir, 'state.json'),
    key: KEY_A as string | undefined,
    raw: undefined as string | undefined,
    applied: 0,
    disk: KEY_A as string | null | undefined,
    probeResults: [] as ClaudeKeyProbeResult[],
    probed: [] as string[],
    operator: [] as string[],
    operatorDelivers: true,
    people: [] as Array<[string, string]>,
    stuck: [] as string[],
    launch: {} as Record<string, string | null>,
    refreshed: [] as string[],
    refreshOk: true,
    reports: [] as string[],
    clock: 1_000_000,
    cleared: 0,
  };
  const make = () => new ClaudeKeyHealth({
    stateFile: r.stateFile,
    currentKey: () => r.key,
    currentRawKey: () => r.raw ?? r.key,
    readKeyFromDisk: () => r.disk,
    applyKey: (k) => { r.key = k ?? undefined; r.raw = undefined; r.applied += 1; },
    probe: async (k) => { r.probed.push(k); return r.probeResults.shift() ?? 'ok'; },
    notifyOperator: async (t) => { r.operator.push(t); return r.operatorDelivers; },
    notifyPerson: async (s, t) => { r.people.push([s, t]); return true; },
    listStuckSessions: async () => r.stuck,
    sessionLaunchFingerprint: (s) => r.launch[s] ?? null,
    refresh: async (s) => { r.refreshed.push(s); return { ok: r.refreshOk }; },
    clearLoginReports: () => { r.cleared += 1; },
    report: ({ reason }) => { r.reports.push(reason); },
    now: () => r.clock,
    manualTimers: true,
    ...overrides,
  });
  return { r, make };
}

async function kill(h: ClaudeKeyHealth, r: ReturnType<typeof rig>['r']) {
  r.probeResults.push('rejected', 'rejected');
  h.noteCallOutcome('rejected');
  await vi.waitFor(() => expect(h.status()?.status).toBe('suspect'));
  await h.confirm();
  expect(h.status()?.status).toBe('dead');
}

describe('reading the CLI', () => {
  it('names a 401 as rejected and "Not logged in" as no-auth, never the other way round', () => {
    expect(classifyClaudeAuthFailure(REJECTED)).toBe('rejected');
    expect(classifyClaudeAuthFailure(NOT_LOGGED_IN)).toBe('no-auth');
  });

  it('treats any other failure or unreadable output as not an auth verdict', () => {
    expect(classifyClaudeAuthFailure(JSON.stringify({ is_error: true, api_error_status: 429, result: 'limit' }))).toBeNull();
    expect(classifyClaudeAuthFailure(JSON.stringify({ is_error: true, api_error_status: 500, result: 'boom' }))).toBeNull();
    expect(classifyClaudeAuthFailure('not json')).toBeNull();
    expect(classifyClaudeAuthFailure(JSON.stringify({ is_error: false, result: 'Not logged in' }))).toBeNull();
  });

  it('a probe is ok only on a clean answer', () => {
    expect(interpretProbe(false, JSON.stringify({ is_error: false, result: 'OK' }))).toBe('ok');
    expect(interpretProbe(true, REJECTED)).toBe('rejected');
    expect(interpretProbe(true, NOT_LOGGED_IN)).toBe('no-auth');
    expect(interpretProbe(true, '')).toBe('inconclusive');
    expect(interpretProbe(false, 'garbage')).toBe('inconclusive');
    expect(interpretProbe(true, JSON.stringify({ is_error: true, api_error_status: 429 }))).toBe('inconclusive');
  });
});

describe('deciding a key is dead', () => {
  let t: ReturnType<typeof rig>;
  beforeEach(() => { t = rig(); });

  it('one 401 tells nobody, a second makes it dead and tells the operator once', async () => {
    const h = t.make();
    t.r.probeResults.push('rejected');
    h.noteCallOutcome('rejected');
    await vi.waitFor(() => expect(h.status()?.status).toBe('suspect'));
    expect(t.r.operator).toEqual([]);
    t.r.probeResults.push('rejected');
    await h.confirm();
    expect(h.status()?.status).toBe('dead');
    expect(t.r.operator).toEqual([OPERATOR_DEAD_TEXT]);
    await h.tick();
    expect(t.r.operator).toHaveLength(1);
  });

  it('a blip clears: a good confirming probe returns to ok and tells nobody', async () => {
    const h = t.make();
    t.r.probeResults.push('rejected', 'ok');
    h.noteCallOutcome('rejected');
    await vi.waitFor(() => expect(h.status()?.status).toBe('suspect'));
    await h.confirm();
    expect(h.status()?.status).toBe('ok');
    expect(t.r.operator).toEqual([]);
  });

  it.each(['inconclusive', 'no-auth'] as const)('%s never makes a key dead', async (result) => {
    const h = t.make();
    t.r.probeResults.push(result);
    h.noteCallOutcome('rejected');
    await vi.waitFor(() => expect(t.r.probed).toHaveLength(1));
    await vi.waitFor(() => expect(h.status()?.status).toBe('ok'));
    expect(t.r.operator).toEqual([]);
  });

  it('no-auth is reported as an Instar fault, once, never as a bad key', async () => {
    const h = t.make();
    t.r.probeResults.push('no-auth');
    h.noteCallOutcome('no-auth');
    await vi.waitFor(() => expect(t.r.reports).toHaveLength(1));
    expect(t.r.reports[0]).toContain('did not reach');
    expect(t.r.operator).toEqual([]);
  });

  it('limits probes in ok state however many calls fail', async () => {
    const h = t.make();
    t.r.probeResults.push('inconclusive', 'inconclusive', 'inconclusive');
    for (let i = 0; i < 20; i++) { h.noteCallOutcome('rejected'); await Promise.resolve(); }
    await vi.waitFor(() => expect(t.r.probed.length).toBeGreaterThan(0));
    expect(t.r.probed).toHaveLength(1);
    t.r.clock += OK_MIN_PROBE_INTERVAL_MS;
    h.noteCallOutcome('rejected');
    await vi.waitFor(() => expect(t.r.probed).toHaveLength(2));
  });

  it('discards a probe whose key changed while it ran', async () => {
    let release!: (v: ClaudeKeyProbeResult) => void;
    const h = t.make();
    const slow = rig({ probe: () => new Promise((res) => { release = res; }) });
    const h2 = slow.make();
    h2.noteCallOutcome('rejected');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    slow.r.key = KEY_B;
    release('rejected');
    await new Promise((res) => setTimeout(res, 5));
    expect(h2.status()?.status).toBe('ok');
    expect(h.status()?.status).toBe('ok');
  });

  it('is inert with no oauth key', async () => {
    t.r.key = undefined;
    t.r.disk = null;
    const h = t.make();
    h.noteCallOutcome('rejected');
    expect(await h.handle({ session: 's', protected: false })).toBe(false);
    expect(t.r.probed).toEqual([]);
    expect(h.status()).toBeNull();
  });

  it('never writes the key to its state file', async () => {
    const h = t.make();
    await kill(h, t.r);
    const raw = fs.readFileSync(t.r.stateFile, 'utf-8');
    expect(raw).not.toContain(KEY_A);
    expect(raw).toContain(claudeKeyFingerprint(KEY_A));
  });
});

describe('telling people', () => {
  it('records told only on confirmed delivery, retries, and stops at the cap', async () => {
    const t = rig();
    t.r.operatorDelivers = false;
    const h = t.make();
    await kill(h, t.r);
    for (let i = 0; i < NOTICE_MAX_ATTEMPTS + 3; i++) await h.tick();
    expect(t.r.operator).toHaveLength(NOTICE_MAX_ATTEMPTS);
    expect(t.r.reports.some((m) => m.includes('could not be told'))).toBe(true);
  });

  it('tells each stuck person once, and says the operator was told only when that is true', async () => {
    const t = rig();
    t.r.stuck = ['one'];
    const h = t.make();
    await kill(h, t.r);
    await h.handle({ session: 'one', protected: false });
    await h.handle({ session: 'two', protected: false });
    expect(t.r.people.map(([s]) => s)).toEqual(['one', 'two']);
    expect(t.r.people[0][1]).toContain('My operator has been told.');

    const u = rig();
    u.r.operatorDelivers = false;
    u.r.stuck = ['one'];
    await kill(u.make(), u.r);
    expect(u.r.people[0][1]).not.toContain('My operator has been told.');
  });
});

describe('probing while dead', () => {
  it('backs off to the ceiling, then stops after the breaker window', async () => {
    const t = rig();
    const h = t.make();
    await kill(h, t.r);
    t.r.probed.length = 0;
    t.r.probeResults.push(...Array(100).fill('rejected'));
    const start = t.r.clock;
    while (t.r.clock - start < PROBE_BREAKER_MS + 6 * 60 * 60_000) { t.r.clock += 60_000; await h.tick(); }
    const withinWindow = 24 + 3;
    expect(t.r.probed.length).toBeLessThanOrEqual(withinWindow);
    expect(nextProbeDelay(DEAD_PROBE_START_MS)).toBe(DEAD_PROBE_START_MS * 2);
    expect(nextProbeDelay(PROBE_CEILING_MS)).toBe(PROBE_CEILING_MS);
    const before = t.r.probed.length;
    t.r.clock += 10 * 60 * 60_000;
    await h.tick();
    expect(t.r.probed).toHaveLength(before);
  });

  it('a successful internal call ends a false alarm straight away, even past the breaker', async () => {
    const t = rig();
    const h = t.make();
    await kill(h, t.r);
    t.r.clock += PROBE_BREAKER_MS * 2;
    t.r.probeResults.push('ok');
    h.noteCallOutcome('ok');
    await vi.waitFor(() => expect(h.status()?.status).toBe('ok'));
  });
});

describe('restoring', () => {
  it('a changed key proves nothing until a probe passes', async () => {
    const t = rig();
    const h = t.make();
    await kill(h, t.r);
    t.r.disk = KEY_B;
    t.r.probeResults.push('inconclusive');
    await h.tick();
    expect(t.r.key).toBe(KEY_B);
    expect(t.r.probed.at(-1)).toBe(KEY_B);
    expect(h.status()?.status).toBe('dead');
    expect(t.r.operator).not.toContain(OPERATOR_OK_TEXT);
  });

  it('a rejected new key stays dead and the operator is told about it', async () => {
    const t = rig();
    const h = t.make();
    await kill(h, t.r);
    t.r.disk = KEY_B;
    t.r.probeResults.push('rejected');
    await h.tick();
    expect(h.status()?.status).toBe('dead');
    expect(t.r.operator).toEqual([OPERATOR_DEAD_TEXT, OPERATOR_DEAD_TEXT]);
  });

  it('a working key recovers the sessions at the login screen, says so, and a later death is told again', async () => {
    const t = rig();
    const h = t.make();
    t.r.stuck = ['one', 'two'];
    await kill(h, t.r);
    t.r.disk = KEY_B;
    t.r.probeResults.push('ok');
    await h.tick();
    expect(h.status()?.status).toBe('ok');
    expect(t.r.refreshed).toEqual(['one', 'two']);
    expect(t.r.operator.at(-1)).toBe(OPERATOR_OK_TEXT);
    expect(t.r.cleared).toBe(1);
    t.r.clock += OK_MIN_PROBE_INTERVAL_MS;
    await kill(h, t.r);
    expect(t.r.operator.filter((m) => m === OPERATOR_DEAD_TEXT)).toHaveLength(2);
  });

  it('works big sweeps in batches and keeps going after the state is ok', async () => {
    const t = rig();
    const h = t.make();
    t.r.stuck = Array.from({ length: REFRESH_BATCH + 3 }, (_, i) => `s${i}`);
    await kill(h, t.r);
    t.r.disk = KEY_B;
    t.r.probeResults.push('ok');
    await h.tick();
    expect(t.r.refreshed).toHaveLength(REFRESH_BATCH);
    await h.tick();
    expect(t.r.refreshed).toHaveLength(REFRESH_BATCH + 3);
  });

  it('gives up on a refused session after the cap and reports it', async () => {
    const t = rig();
    const h = t.make();
    t.r.stuck = ['busy'];
    t.r.refreshOk = false;
    await kill(h, t.r);
    t.r.disk = KEY_B;
    t.r.probeResults.push('ok');
    for (let i = 0; i < REFRESH_MAX_ATTEMPTS + 3; i++) await h.tick();
    expect(t.r.refreshed).toHaveLength(REFRESH_MAX_ATTEMPTS);
    expect(t.r.reports.some((m) => m.includes('"busy"'))).toBe(true);
    expect(decideKeyRefresh({ attempts: 3, maxAttempts: 3 })).toBe('gave-up');
  });

  it('a key restored by hand before a restart is found at boot', async () => {
    const t = rig();
    await kill(t.make(), t.r);
    t.r.key = KEY_B;
    t.r.disk = KEY_B;
    t.r.stuck = ['one'];
    t.r.probeResults.push('ok');
    const next = t.make();
    await next.boot();
    expect(next.status()?.status).toBe('ok');
    expect(t.r.refreshed).toEqual(['one']);
  });

  it('a crash mid-sweep finishes at boot', async () => {
    const t = rig();
    fs.writeFileSync(t.r.stateFile, JSON.stringify({ status: 'ok', sweepPending: true }));
    t.r.stuck = ['one'];
    const h = t.make();
    await h.boot();
    await h.tick();
    expect(t.r.refreshed).toEqual(['one']);
  });

  it('keeps the last key when the file cannot be read', async () => {
    const t = rig();
    const h = t.make();
    await kill(h, t.r);
    t.r.disk = undefined;
    await h.tick();
    expect(t.r.key).toBe(KEY_A);
  });
});

describe('second-pass review defects', () => {
  it('tests a key already on disk instead of paging about the replaced one', async () => {
    const t = rig();
    const h = t.make();
    t.r.disk = KEY_B;
    t.r.probeResults.push('ok');
    h.noteCallOutcome('rejected');
    await vi.waitFor(() => expect(t.r.probed).toEqual([KEY_B]));
    expect(t.r.operator).toEqual([]);
  });

  it('probes a key restored while the server was down, even past the breaker', async () => {
    const t = rig();
    await kill(t.make(), t.r);
    t.r.clock += PROBE_BREAKER_MS * 2;
    t.r.key = KEY_B;
    t.r.disk = KEY_B;
    t.r.probeResults.push('ok');
    const next = t.make();
    await next.boot();
    expect(next.status()?.status).toBe('ok');
  });

  it('overlapping passes do not double-refresh or burn attempts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const calls: string[] = [];
    const t = rig({ refresh: async (s) => { calls.push(s); await gate; return { ok: true }; } });
    const h = t.make();
    t.r.stuck = ['one'];
    await kill(h, t.r);
    t.r.disk = KEY_B;
    t.r.probeResults.push('ok');
    const first = h.tick();
    await vi.waitFor(() => expect(calls).toEqual(['one']));
    await h.tick();
    release();
    await first;
    expect(calls).toEqual(['one']);
  });

  it('a failed call during suspect waits for the confirming delay', async () => {
    const t = rig();
    const h = t.make();
    t.r.probeResults.push('rejected', 'rejected');
    h.noteCallOutcome('rejected');
    await vi.waitFor(() => expect(h.status()?.status).toBe('suspect'));
    t.r.clock += OK_MIN_PROBE_INTERVAL_MS;
    h.noteCallOutcome('rejected');
    await new Promise((res) => setTimeout(res, 5));
    expect(t.r.probed).toHaveLength(1);
    expect(h.status()?.status).toBe('suspect');
  });

  it('a failed call while dead does not spawn a probe outside the backoff', async () => {
    const t = rig();
    const h = t.make();
    await kill(h, t.r);
    const before = t.r.probed.length;
    for (let i = 0; i < 10; i++) h.noteCallOutcome('rejected');
    await new Promise((res) => setTimeout(res, 5));
    expect(t.r.probed).toHaveLength(before);
  });

  it('a key removed from disk is cleared and the dead state ends', async () => {
    const t = rig();
    const h = t.make();
    await kill(h, t.r);
    t.r.disk = null;
    await h.tick();
    expect(t.r.key).toBeUndefined();
    expect(h.status()).toBeNull();
    t.r.key = KEY_A;
    t.r.disk = KEY_A;
    expect(h.status()?.status).toBe('ok');
  });

  it('the sweep is once per session per key, even if the same key dies twice', async () => {
    const t = rig();
    const h = t.make();
    t.r.stuck = ['one'];
    await kill(h, t.r);
    t.r.probeResults.push('ok');
    t.r.clock += DEAD_PROBE_START_MS;
    await h.tick();
    await h.tick();
    expect(t.r.refreshed).toEqual(['one']);
    t.r.clock += OK_MIN_PROBE_INTERVAL_MS;
    await kill(h, t.r);
    t.r.probeResults.push('ok');
    t.r.clock += DEAD_PROBE_START_MS;
    await h.tick();
    await h.tick();
    expect(t.r.refreshed).toEqual(['one']);
  });

  it('remembers a respawned session under its new name, as Slack renames it', async () => {
    const t = rig({ refresh: async (s) => { t.r.refreshed.push(s); return { ok: true, newSessionName: 'one-new' }; } });
    const h = t.make();
    t.r.stuck = ['one'];
    await kill(h, t.r);
    t.r.probeResults.push('ok');
    t.r.clock += DEAD_PROBE_START_MS;
    await h.tick();
    await h.tick();
    t.r.stuck = ['one-new'];
    t.r.clock += OK_MIN_PROBE_INTERVAL_MS;
    await kill(h, t.r);
    t.r.probeResults.push('ok');
    t.r.clock += DEAD_PROBE_START_MS;
    await h.tick();
    await h.tick();
    expect(t.r.refreshed).toEqual(['one']);
  });

  it('nothing is restarted once the key is gone, including work already queued', async () => {
    const t = rig();
    const h = t.make();
    t.r.stuck = Array.from({ length: REFRESH_BATCH + 2 }, (_, i) => `s${i}`);
    await kill(h, t.r);
    t.r.disk = KEY_B;
    t.r.probeResults.push('ok');
    await h.tick();
    const done = t.r.refreshed.length;
    t.r.disk = null;
    await h.tick();
    await h.tick();
    expect(t.r.refreshed).toHaveLength(done);
  });

  it('a boot with a pending sweep and no key queues nothing', async () => {
    const t = rig();
    fs.writeFileSync(t.r.stateFile, JSON.stringify({ status: 'ok', sweepPending: true }));
    t.r.key = undefined;
    t.r.disk = null;
    t.r.stuck = ['one'];
    const h = t.make();
    await h.boot();
    await h.tick();
    expect(t.r.refreshed).toEqual([]);
  });

  it('an API key on disk is not seen as a change on every pass', async () => {
    const t = rig();
    t.r.key = undefined;
    t.r.raw = 'sk-ant-api03-paid';
    t.r.disk = 'sk-ant-api03-paid';
    const h = t.make();
    await h.tick();
    await h.tick();
    expect(t.r.applied).toBe(0);
  });
});

describe('a session at the login screen with a good key', () => {
  async function goodKeyRig() {
    const t = rig();
    const h = t.make();
    t.r.probeResults.push('ok');
    return { t, h };
  }

  it('printing login text in a session on the current key causes no refresh', async () => {
    const { t, h } = await goodKeyRig();
    t.r.launch.chat = claudeKeyFingerprint(KEY_A);
    expect(await h.handle({ session: 'chat', protected: false })).toBe(true);
    expect(t.r.refreshed).toEqual([]);
  });

  it('a session with no launch key (stored login) is left alone', async () => {
    const { t, h } = await goodKeyRig();
    t.r.launch.chat = null;
    await h.handle({ session: 'chat', protected: false });
    expect(t.r.refreshed).toEqual([]);
  });

  it('a session launched on an old key is refreshed once', async () => {
    const { t, h } = await goodKeyRig();
    t.r.launch.chat = claudeKeyFingerprint(KEY_B);
    await h.handle({ session: 'chat', protected: false });
    expect(t.r.refreshed).toEqual(['chat']);
    t.r.clock += OK_MIN_PROBE_INTERVAL_MS;
    await h.handle({ session: 'chat', protected: false });
    expect(t.r.refreshed).toEqual(['chat']);
  });

  it('a protected session is never refreshed', async () => {
    const { t, h } = await goodKeyRig();
    t.r.launch.chat = claudeKeyFingerprint(KEY_B);
    await h.handle({ session: 'chat', protected: true });
    expect(t.r.refreshed).toEqual([]);
  });
});
