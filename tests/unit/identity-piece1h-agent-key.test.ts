/**
 * identity-security-piece1h: a missing or unreadable agent API key.
 * Spec: docs/specs/identity-security-piece1h-no-token-refusal.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware, bearerMatches, isUnreadableToken, isUsableToken, setNoTokenServedCounter, signViewPath } from '../../src/server/middleware.js';
import { AgentKeyHealth, KEY_REREAD_GIVE_UP_MS, KEY_REREAD_NOTIFY_AFTER } from '../../src/server/agentKeyHealth.js';
import { sessionAuthToken } from '../../src/core/SessionManager.js';
import { fixAuth } from '../../src/commands/fixAuth.js';
import { isAgentKeyRefusal, withAgentKey } from '../../src/lifeline/TelegramLifeline.js';
import { ForwardKeyRefusedError, isTerminalForwardError } from '../../src/lifeline/forwardErrors.js';
import { WebSocketManager } from '../../src/server/WebSocketManager.js';

const PLACEHOLDER = { secret: true } as unknown as string;

function mockReq(opts: { path?: string; auth?: string; sig?: string }): Request {
  const headers: Record<string, unknown> = {};
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  return { path: opts.path ?? '/status', method: 'GET', headers, query: opts.sig ? { sig: opts.sig } : {},
    socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
}
function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = { statusCode: 0, body: undefined } as Response & { statusCode: number; body: unknown };
  res.status = ((n: number) => { res.statusCode = n; return res; }) as Response['status'];
  res.json = ((b: unknown) => { res.body = b; return res; }) as Response['json'];
  return res;
}
function run(token: unknown, req: Request): { nexted: boolean; res: ReturnType<typeof mockRes> } {
  const mw = authMiddleware(() => token as string | undefined, 'agent');
  const res = mockRes();
  let nexted = false;
  const next: NextFunction = () => { nexted = true; };
  mw(req, res, next);
  return { nexted, res };
}

describe('key classification', () => {
  it('a usable key is a non-empty string; an unreadable key is present but not a string', () => {
    expect(isUsableToken('abc')).toBe(true);
    expect(isUsableToken('')).toBe(false);
    expect(isUsableToken(undefined)).toBe(false);
    expect(isUsableToken(PLACEHOLDER)).toBe(false);
    expect(isUnreadableToken(PLACEHOLDER)).toBe(true);
    expect(isUnreadableToken(undefined)).toBe(false);
    expect(isUnreadableToken('')).toBe(false);
    expect(isUnreadableToken('abc')).toBe(false);
  });
});

describe('auth middleware', () => {
  it('an unreadable key: a protected route gets 503 agent-credential-unavailable, never a crash', () => {
    const { nexted, res } = run(PLACEHOLDER, mockReq({ auth: 'anything' }));
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'agent-credential-unavailable' });
    // no credential at all: the ordinary 401, as with a real key
    expect(run(PLACEHOLDER, mockReq({})).res.statusCode).toBe(401);
    // any other non-string value (false, 0) is unreadable, never "no key"
    expect(run(false, mockReq({ auth: 'x' })).res.statusCode).toBe(503);
    expect(run(0, mockReq({ auth: 'x' })).res.statusCode).toBe(503);
  });

  it('an unreadable key: public routes with their own proof stay reachable', () => {
    expect(run(PLACEHOLDER, mockReq({ path: '/health' })).nexted).toBe(true);
  });

  it('an unreadable key: dashboard session (dst_) and session (mps_) tokens are still judged on their own proof', () => {
    // dst_ with no verifier wired: its own 401, not the key's 503
    const r = run(PLACEHOLDER, mockReq({ auth: 'dst_abc' }));
    expect(r.res.statusCode).toBe(401);
    const m = run(PLACEHOLDER, mockReq({ auth: 'mps_abc' }));
    expect(m.res.statusCode).toBe(401);
  });

  it('an unreadable key: a view signature is refused, not hashed with an object', () => {
    const sig = signViewPath('/view/abc', 'real-key');
    const r = run(PLACEHOLDER, mockReq({ path: '/view/abc', sig }));
    expect(r.nexted).toBe(false);
    expect(r.res.statusCode).toBe(401); // no bearer: the ordinary refusal, and no crash
  });

  it('no key: served as today and counted', () => {
    const counted = vi.fn();
    setNoTokenServedCounter(counted);
    try {
      expect(run(undefined, mockReq({})).nexted).toBe(true);
      expect(counted).toHaveBeenCalledTimes(1);
      expect(counted.mock.calls[0][0]).toMatchObject({ method: 'GET', path: '/status', remote: '127.0.0.1' });
      // health probes are not would-refuse callers
      expect(run(undefined, mockReq({ path: '/health' })).nexted).toBe(true);
      expect(counted).toHaveBeenCalledTimes(1);
    } finally {
      setNoTokenServedCounter(() => {});
    }
  });

  it('a real key: right bearer passes, wrong bearer 403 as today', () => {
    expect(run('k1', mockReq({ auth: 'k1' })).nexted).toBe(true);
    expect(run('k1', mockReq({ auth: 'nope' })).res.statusCode).toBe(403);
  });
});

describe('bearerMatches', () => {
  const req = (auth?: string) => ({ headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  it('refuses for an unreadable key, open as today for no key, compares a real key', () => {
    expect(bearerMatches(req('x'), PLACEHOLDER)).toBe(false);
    expect(bearerMatches(req(), undefined)).toBe(true);
    expect(bearerMatches(req('k1'), 'k1')).toBe(true);
    expect(bearerMatches(req('k2'), 'k1')).toBe(false);
  });
});

describe('session environment', () => {
  it('a session gets the key only when it is a string, otherwise an explicit empty value', () => {
    expect(sessionAuthToken('k1')).toBe('k1');
    expect(sessionAuthToken(undefined)).toBe('');
    expect(sessionAuthToken(PLACEHOLDER)).toBe('');
  });
});

describe('the "fix auth" reply', () => {
  function liveConfig(initial: unknown, opts: { failWrite?: boolean } = {}) {
    let value = initial;
    return { get: <T>(_k: string, d: T) => (value ?? d) as T, set: (_k: string, v: unknown) => { if (!opts.failWrite) value = v; }, peek: () => value };
  }

  it('creates a 32-byte key, applies it to the running config, and posts none of it', () => {
    const lc = liveConfig(undefined);
    const config: { authToken?: unknown } = {};
    const reply = fixAuth(lc as never, config);
    const key = lc.peek() as string;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(config.authToken).toBe(key);
    expect(reply).not.toContain(key.slice(0, 6));
    expect(reply).toMatch(/^Done\./);
  });

  it('reports a failed write instead of "Done"', () => {
    const config: { authToken?: unknown } = {};
    const reply = fixAuth(liveConfig(undefined, { failWrite: true }) as never, config);
    expect(reply).toMatch(/couldn't save/);
    expect(config.authToken).toBeUndefined();
  });

  it('leaves an existing or unreadable key alone, judged by the running server first', () => {
    // a healthy agent whose key lives in the secret store: placeholder in the file, string in memory
    expect(fixAuth(liveConfig(PLACEHOLDER) as never, { authToken: 'k1' })).toMatch(/already has a key/);
    expect(fixAuth(liveConfig('k1') as never, { authToken: 'k1' })).toMatch(/already has a key/);
    // the running key could not be loaded: left alone, the server's retry is named
    expect(fixAuth(liveConfig(PLACEHOLDER) as never, { authToken: PLACEHOLDER })).toMatch(/could not be loaded/);
  });

  it('on a multi-machine agent it sets no key on one machine alone', () => {
    const lc = liveConfig(undefined);
    const reply = fixAuth(lc as never, {}, 1);
    expect(lc.peek()).toBeUndefined();
    expect(reply).toMatch(/2 machines/);
  });
});

describe('WebSocket upgrade reads the key live', () => {
  it('a key set after start (the owner\'s "fix auth", a recovered store) applies to the next connection', () => {
    let key: unknown = undefined;
    const ws = new WebSocketManager({ server: { on: vi.fn() } as never, sessionManager: { listRunningSessions: () => [] } as never,
      state: { get: () => null, set: () => {} } as never, authToken: () => key });
    const verify = (t: string) => (ws as unknown as { verifyToken: (t: string) => boolean }).verifyToken(t);
    expect(verify('anything')).toBe(true); // no key: open, as today
    key = PLACEHOLDER;
    expect(verify('anything')).toBe(false); // unreadable: refused
    key = 'k1';
    expect(verify('anything')).toBe(false);
    expect(verify('k1')).toBe(true);
    ws.shutdown?.();
  });
});

describe('Telegram relay key helpers', () => {
  it('adds Authorization only for a real string key', () => {
    expect(withAgentKey({}, 'k1')).toEqual({ Authorization: 'Bearer k1' });
    expect(withAgentKey({}, undefined)).toEqual({});
    expect(withAgentKey({ Authorization: 'Bearer old' }, PLACEHOLDER)).toEqual({});
  });

  it('a key refusal is 401 (not a secret refusal), 403 invalid token, or 503 key unavailable', async () => {
    const r = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    expect(await isAgentKeyRefusal(r(401, { error: 'Missing or invalid Authorization header' }))).toBe(true);
    expect(await isAgentKeyRefusal(r(401, { error: 'lifeline-secret-required' }))).toBe(false);
    expect(await isAgentKeyRefusal(r(403, { error: 'Invalid auth token' }))).toBe(true);
    expect(await isAgentKeyRefusal(r(403, { error: 'agent_id_mismatch' }))).toBe(false);
    expect(await isAgentKeyRefusal(r(503, { error: 'agent-credential-unavailable' }))).toBe(true);
    expect(await isAgentKeyRefusal(r(503, { retryAfterMs: 1000 }))).toBe(false);
    expect(await isAgentKeyRefusal(r(200, {}))).toBe(false);
  });

  it('a key still refused after the re-read re-queues (terminal for the retry loop), separate from a secret refusal', () => {
    const e = new ForwardKeyRefusedError(403);
    expect(isTerminalForwardError(e)).toBe(true);
    expect(e.kind).toBe('key-refused');
  });
});

describe('AgentKeyHealth: re-reading an unloaded key', () => {
  function harness(reads: unknown[]) {
    let now = 0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let key: unknown = PLACEHOLDER;
    const notify = vi.fn().mockResolvedValue(true);
    const resolved = vi.fn();
    const h = new AgentKeyHealth({
      current: () => key,
      reload: () => { const v = reads.shift(); if (v instanceof Error) throw v; return v; },
      apply: (k) => { key = k; },
      notify, resolved,
      now: () => now,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
    });
    return { h, timers, notify, resolved, key: () => key, advance: (ms: number) => { now += ms; } };
  }

  it('waits a minute, then backs off; tells the owner only after 3 failures; closes when the key loads', async () => {
    const t = harness([PLACEHOLDER, new Error('store locked'), PLACEHOLDER, 'fresh-key']);
    t.h.start();
    expect(t.timers.map((x) => x.ms)).toEqual([60_000]);
    for (let i = 0; i < KEY_REREAD_NOTIFY_AFTER; i++) await t.h.tick();
    expect(t.timers.map((x) => x.ms)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith(false);
    await t.h.tick();
    expect(t.key()).toBe('fresh-key');
    expect(t.resolved).toHaveBeenCalledTimes(1);
  });

  it('caps the delay at 30 minutes and gives up after 24 hours with a final notice', async () => {
    const t = harness(Array(100).fill(PLACEHOLDER));
    t.h.start();
    for (let i = 0; i < 8; i++) await t.h.tick();
    expect(Math.max(...t.timers.map((x) => x.ms))).toBe(30 * 60_000);
    t.advance(KEY_REREAD_GIVE_UP_MS);
    const before = t.timers.length;
    await t.h.tick();
    expect(t.notify).toHaveBeenLastCalledWith(true);
    expect(t.timers.length).toBe(before);
    await t.h.tick();
    expect(t.notify).toHaveBeenCalledTimes(2);
  });

  it('a restart continues the same window: no reset of the backoff or the 24-hour stop', async () => {
    let saved: { firstFailureAt: number; failures: number; gaveUp?: boolean } | null = null;
    let now = 0;
    const timers: number[] = [];
    const make = () => new AgentKeyHealth({ current: () => PLACEHOLDER, reload: () => PLACEHOLDER, apply: () => {},
      notify: vi.fn().mockResolvedValue(true), resolved: () => {}, now: () => now,
      loadWindow: () => saved, saveWindow: (w) => { saved = w; },
      setTimer: (_fn, ms) => { timers.push(ms); return timers.length; }, clearTimer: () => {} });
    const a = make(); a.start(); await a.tick(); await a.tick();
    expect(saved).toMatchObject({ firstFailureAt: 0, failures: 2 });
    a.stop();
    const b = make(); b.start();
    expect(timers.at(-1)).toBe(240_000); // continues at the third step, not back at 1 minute
    now = KEY_REREAD_GIVE_UP_MS;
    await b.tick();
    expect(saved).toMatchObject({ gaveUp: true });
    const c = make(); timers.length = 0; c.start();
    expect(timers).toHaveLength(0); // gave up: a restart does not start again
  });

  it('does nothing when the key is readable', () => {
    const t = harness([]);
    (t as unknown as { h: AgentKeyHealth }).h = new AgentKeyHealth({ current: () => 'k1', reload: () => 'k1', apply: () => {}, notify: t.notify, resolved: t.resolved,
      setTimer: (fn, ms) => { t.timers.push({ fn, ms }); return 1; }, clearTimer: () => {} });
    t.h.start();
    expect(t.timers).toHaveLength(0);
  });
});

describe('no unguarded hashing of the agent key', () => {
  // A key the secret store did not load is an object: hashing or HMAC-keying it throws. Every site
  // that hashes `authToken` must check it is a string first, or be listed here with its guard.
  const GUARDED: Array<[string, string]> = [
    ['src/server/routes.ts', "createHash('sha256').update(ctx.config.authToken)"], // /jobs/events: inside isUsableToken; owner-authed: try/catch → false
    ['src/server/AgentServer.ts', "createHash('sha256').update(configRef.authToken)"], // revoke-all: length check + try/catch
    ['src/server/AgentServer.ts', '`email-recipient:${config.authToken'], // template string: never throws
    ['src/monitoring/delivery-failure-sentinel.ts', '${cfg.authToken}'], // template string: never throws
    ['src/server/WebSocketManager.ts', "createHash('sha256').update(this.authToken)"], // verifyToken: after the isUsableToken return
    ['src/server/middleware.ts', "createHash('sha256').update(authToken)"], // bearerMatches: after the isUsableToken return
    ['src/server/middleware.ts', "createHmac('sha256', authToken)"], // signViewPath / verifyViewSignature: typeof check on the line above
  ];
  it('every site is guarded', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          fs.readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
            if (!/(update|createHmac)\([^;]*authToken/.test(line)) return;
            if (line.includes('typeof')) return;
            const rel = path.relative(process.cwd(), p);
            if (GUARDED.some(([f, snip]) => rel === f && line.includes(snip))) return;
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
