import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  readLiveCodexRateLimits,
  readLiveCodexRateLimitsDetailed,
  isCodexAuthError,
  mapLiveResponse,
  buildCodexLiveUsageReader,
  buildCodexLiveUsageReaderDetailed,
  capUtf8,
  CODEX_REFUSAL_TEXT_MAX_BYTES,
} from '../../src/providers/adapters/openai-codex/observability/codexLiveRateLimitReader.js';

/**
 * Unit coverage for the ZERO-SPEND live codex rate-limit reader (`codex
 * app-server` → account/rateLimits/read). Both sides of every boundary: a
 * clean protocol exchange → structured snapshot; every failure shape (spawn
 * error, timeout, protocol error, early exit, garbage output) → null, because
 * null is what sends the caller to the rollout-tail fallback.
 */

const NOW_MS = Date.parse('2026-09-20T18:00:00Z');

/** A live response shaped like the real capture from 2026-09-20 (sagemindai). */
function liveResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 86, windowDurationMins: 10080, resetsAt: 1790000000 },
      secondary: null,
      planType: 'prolite',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 86, windowDurationMins: 10080, resetsAt: 1790000000 },
        secondary: null,
        planType: 'prolite',
        rateLimitReachedType: null,
      },
    },
    ...overrides,
  };
}

describe('mapLiveResponse', () => {
  it('maps the codex bucket into the rollout snapshot shape', () => {
    const snap = mapLiveResponse(liveResult(), NOW_MS);
    expect(snap).not.toBeNull();
    expect(snap!.source).toBe('codex-app-server');
    expect(snap!.primary!.usedPercent).toBe(86);
    expect(snap!.primary!.remainingPercent).toBe(14);
    expect(snap!.primary!.windowMinutes).toBe(10080);
    expect(snap!.primary!.resetsAtIso).toBe(new Date(1790000000 * 1000).toISOString());
    expect(snap!.primary!.resetsInSeconds).toBe(Math.round((1790000000 * 1000 - NOW_MS) / 1000));
    expect(snap!.secondary).toBeNull();
    expect(snap!.planType).toBe('prolite');
    expect(snap!.capturedAt).toBe(new Date(NOW_MS).toISOString());
    expect(snap!.windowsUnavailable).toBeUndefined();
  });

  it('carries a live rate_limit_reached marker through (the walled-account case)', () => {
    const r = liveResult();
    (r.rateLimitsByLimitId as Record<string, Record<string, unknown>>).codex.rateLimitReachedType =
      'rate_limit_reached';
    const snap = mapLiveResponse(r, NOW_MS);
    expect(snap!.rateLimitReachedType).toBe('rate_limit_reached');
  });

  it('falls back to the single-bucket view when the by-id map is absent, codex-family only', () => {
    const codexSingle = mapLiveResponse(liveResult({ rateLimitsByLimitId: null }), NOW_MS);
    expect(codexSingle!.primary!.usedPercent).toBe(86);

    // A single view without a limitId is the pre-limit_id shape: codex family.
    const legacy = liveResult({ rateLimitsByLimitId: null });
    delete (legacy.rateLimits as Record<string, unknown>).limitId;
    expect(mapLiveResponse(legacy, NOW_MS)!.primary!.usedPercent).toBe(86);

    // A FOREIGN single view must never be presented as this account's quota.
    const foreign = liveResult({ rateLimitsByLimitId: null });
    (foreign.rateLimits as Record<string, unknown>).limitId = 'premium';
    expect(mapLiveResponse(foreign, NOW_MS)).toBeNull();
  });

  it('reports windowsUnavailable when the codex bucket carries no usable window', () => {
    const r = liveResult();
    (r.rateLimitsByLimitId as Record<string, Record<string, unknown>>).codex.primary = null;
    const snap = mapLiveResponse(r, NOW_MS);
    expect(snap).not.toBeNull();
    expect(snap!.windowsUnavailable).toBe(true);
    expect(snap!.primary).toBeNull();
    expect(snap!.secondary).toBeNull();
  });

  it('rejects a malformed reported window rather than treating it as absent', () => {
    const r = liveResult();
    (r.rateLimitsByLimitId as Record<string, Record<string, unknown>>).codex.primary = {
      usedPercent: 'lots',
    };
    expect(mapLiveResponse(r, NOW_MS)).toBeNull();
  });

  it('rejects a favorable primary when the reported exhausted secondary is malformed', () => {
    const r = liveResult();
    const bucket = (r.rateLimitsByLimitId as Record<string, Record<string, unknown>>).codex;
    bucket.primary = { usedPercent: 10, windowDurationMins: 300, resetsAt: 1790000000 };
    bucket.secondary = { usedPercent: 100, windowDurationMins: 10080 };
    expect(mapLiveResponse(r, NOW_MS)).toBeNull();
  });
});

// ── The protocol exchange, against a scripted fake app-server child ─────────

class FakeStream extends EventEmitter {
  written: string[] = [];
  write(chunk: string): boolean {
    this.written.push(chunk);
    this.emit('written', chunk);
    return true;
  }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStream();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0);
    return true;
  }
}

/** Script a fake `codex app-server`: replies to initialize (id 1) and the read (id 2). */
function scriptedChild(opts: {
  initError?: boolean;
  readResult?: Record<string, unknown> | null;
  readError?: boolean;
  /** The app-server's error message for the read (id 2), e.g. its signed-out refusal. */
  readErrorMessage?: string;
  garbageFirst?: boolean;
  silent?: boolean;
  /** A full JSON-RPC error object for initialize (id 1). */
  initErrorObject?: Record<string, unknown>;
  /** A full JSON-RPC error object for the read (id 2). */
  readErrorObject?: Record<string, unknown>;
  /** Text the child writes to stderr before every reply (must never surface in a result). */
  stderrText?: string;
}): { child: FakeChild; spawnImpl: () => ChildProcessWithoutNullStreams } {
  const child = new FakeChild();
  child.stdin.on('written', (raw: string) => {
    if (opts.silent) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const reply = (payload: Record<string, unknown>): void => {
      // Async like a real pipe, with optional non-protocol chatter first.
      setImmediate(() => {
        if (opts.stderrText) child.stderr.emit('data', Buffer.from(opts.stderrText));
        if (opts.garbageFirst) child.stdout.emit('data', Buffer.from('not json at all\n'));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`));
      });
    };
    if (msg.id === 1) {
      if (opts.initErrorObject) reply({ id: 1, error: opts.initErrorObject });
      else reply(opts.initError ? { id: 1, error: { message: 'nope' } } : { id: 1, result: {} });
    } else if (msg.id === 2) {
      if (opts.readErrorObject) reply({ id: 2, error: opts.readErrorObject });
      else if (opts.readErrorMessage) reply({ id: 2, error: { code: -32600, message: opts.readErrorMessage } });
      else if (opts.readError) reply({ id: 2, error: { message: 'nope' } });
      else reply({ id: 2, result: opts.readResult ?? liveResult() });
    }
  });
  return { child, spawnImpl: () => child as unknown as ChildProcessWithoutNullStreams };
}

describe('readLiveCodexRateLimits', () => {
  it('performs the handshake and returns the mapped snapshot', async () => {
    const { child, spawnImpl } = scriptedChild({ garbageFirst: true });
    const snap = await readLiveCodexRateLimits({ codexHome: '/x', nowMs: NOW_MS, spawnImpl });
    expect(snap).not.toBeNull();
    expect(snap!.source).toBe('codex-app-server');
    expect(snap!.primary!.usedPercent).toBe(86);
    // The child never outlives the exchange.
    expect(child.killed).toBe(true);
    // Handshake order: initialize → initialized notification → the read.
    const methods = child.stdin.written.map((w) => (JSON.parse(w) as { method: string }).method);
    expect(methods).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
  });

  it('uses a subscription-only child environment for a fenced admission read', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    const originalEscape = process.env.INSTAR_DISABLE_RULE1_OPENAI;
    process.env.OPENAI_API_KEY = 'sk-not-for-triage';
    process.env.INSTAR_DISABLE_RULE1_OPENAI = '1';
    try {
      let spawnedEnv: NodeJS.ProcessEnv | undefined;
      let spawnedArgs: string[] | undefined;
      const { spawnImpl } = scriptedChild({});
      const snapshot = await readLiveCodexRateLimits({
        codexHome: '/tmp/verified-subscription', subscriptionOnly: true, nowMs: NOW_MS,
        spawnImpl: (cmd, args, opts) => { spawnedEnv = opts.env; spawnedArgs = args; return spawnImpl(); },
      });
      expect(snapshot).not.toBeNull();
      expect(spawnedEnv?.CODEX_HOME).toBe('/tmp/verified-subscription');
      expect(spawnedEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(spawnedEnv?.INSTAR_DISABLE_RULE1_OPENAI).toBeUndefined();
      expect(spawnedArgs).toEqual(['app-server', '-c', 'cli_auth_credentials_store="file"']);
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      if (originalEscape === undefined) delete process.env.INSTAR_DISABLE_RULE1_OPENAI;
      else process.env.INSTAR_DISABLE_RULE1_OPENAI = originalEscape;
    }
  });

  it('returns null when initialize is refused', async () => {
    const { spawnImpl } = scriptedChild({ initError: true });
    expect(await readLiveCodexRateLimits({ nowMs: NOW_MS, spawnImpl })).toBeNull();
  });

  it('returns null when the read errors', async () => {
    const { spawnImpl } = scriptedChild({ readError: true });
    expect(await readLiveCodexRateLimits({ nowMs: NOW_MS, spawnImpl })).toBeNull();
  });

  it('returns null on a silent child once the deadline passes (never hangs)', async () => {
    const { child, spawnImpl } = scriptedChild({ silent: true });
    const snap = await readLiveCodexRateLimits({ nowMs: NOW_MS, spawnImpl, timeoutMs: 50 });
    expect(snap).toBeNull();
    expect(child.killed).toBe(true);
  });

  it('does not spawn for a cancelled probe and reaps an in-flight cancelled probe', async () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    let spawns = 0;
    expect(await readLiveCodexRateLimits({ subscriptionOnly: true, signal: alreadyCancelled.signal,
      spawnImpl: () => { spawns++; return scriptedChild({ silent: true }).spawnImpl(); } })).toBeNull();
    expect(spawns).toBe(0);

    const running = new AbortController();
    const { child, spawnImpl } = scriptedChild({ silent: true });
    const read = readLiveCodexRateLimits({ subscriptionOnly: true, signal: running.signal,
      timeoutMs: 5_000, spawnImpl });
    running.abort();
    expect(await read).toBeNull();
    expect(child.killed).toBe(true);
  });

  it('returns null when the child exits before answering', async () => {
    const child = new FakeChild();
    child.stdin.on('written', () => setImmediate(() => child.emit('exit', 1)));
    const snap = await readLiveCodexRateLimits({
      nowMs: NOW_MS,
      spawnImpl: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    expect(snap).toBeNull();
  });

  it('returns null when spawning itself throws (codex binary missing)', async () => {
    const snap = await readLiveCodexRateLimits({
      nowMs: NOW_MS,
      spawnImpl: () => {
        throw new Error('ENOENT');
      },
    });
    expect(snap).toBeNull();
  });
});

describe('buildCodexLiveUsageReader (composition-root factory)', () => {
  it('returns a callable reader by default and with an empty config block', () => {
    expect(typeof buildCodexLiveUsageReader(undefined)).toBe('function');
    expect(typeof buildCodexLiveUsageReader({})).toBe('function');
    expect(typeof buildCodexLiveUsageReader({ codexLiveQuota: true })).toBe('function');
  });

  it('codexLiveQuota: false is the rollback lever — returns null (rollout-only)', () => {
    expect(buildCodexLiveUsageReader({ codexLiveQuota: false })).toBeNull();
  });
});


// ── The DETAILED read: auth refusal vs transport failure (spec skill-driven-signin-repair) ──

describe('readLiveCodexRateLimitsDetailed', () => {
  it('tells the app-server signed-out refusal apart as auth-failed (the real 2026-09-25 wording)', async () => {
    const { child, spawnImpl } = scriptedChild({
      readErrorMessage: 'codex account authentication required to read rate limits',
    });
    const read = await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl });
    expect(read).toEqual({
      kind: 'auth-failed',
      refusal: { stage: 'read', text: 'codex account authentication required to read rate limits' },
    });
    expect(child.killed).toBe(true);
    // The null-returning wrapper still reads it as "no snapshot" for existing callers.
    const again = scriptedChild({ readErrorMessage: 'codex account authentication required to read rate limits' });
    expect(await readLiveCodexRateLimits({ nowMs: NOW_MS, spawnImpl: again.spawnImpl })).toBeNull();
  });

  it('keeps a non-auth protocol error, an init error and a timeout as unavailable (never evidence of sign-out)', async () => {
    expect(await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: scriptedChild({ readError: true }).spawnImpl }))
      .toEqual({ kind: 'unavailable', refusal: { stage: 'read', text: 'nope' } });
    expect(await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: scriptedChild({ initError: true }).spawnImpl }))
      .toEqual({ kind: 'unavailable', refusal: { stage: 'initialize', text: 'nope' } });
    expect(await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: scriptedChild({ silent: true }).spawnImpl, timeoutMs: 30 }))
      .toEqual({ kind: 'unavailable' });
    expect(await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: () => { throw new Error('ENOENT'); } }))
      .toEqual({ kind: 'unavailable' });
  });

  it('returns the snapshot as ok on a clean read', async () => {
    const read = await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: scriptedChild({}).spawnImpl });
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.snapshot.source).toBe('codex-app-server');
  });

  it('classifies auth wording on both sides of the boundary', () => {
    expect(isCodexAuthError({ message: 'codex account authentication required to read rate limits' })).toBe(true);
    expect(isCodexAuthError({ message: 'Not logged in' })).toBe(true);
    expect(isCodexAuthError({ message: 'Unauthorized' })).toBe(true);
    expect(isCodexAuthError({ message: 'method not found' })).toBe(false);
    expect(isCodexAuthError({ message: 'internal error: timed out' })).toBe(false);
    expect(isCodexAuthError(null)).toBe(false);
  });

  it('the detailed factory honors the same codexLiveQuota:false rollback lever', () => {
    expect(buildCodexLiveUsageReaderDetailed({ codexLiveQuota: false })).toBeNull();
    expect(typeof buildCodexLiveUsageReaderDetailed({})).toBe('function');
  });
});

describe('readLiveCodexRateLimitsDetailed refusal text (spec codex-device-limit-tripwire §2)', () => {
  const read = (o: Parameters<typeof scriptedChild>[0]) =>
    readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: scriptedChild(o).spawnImpl });

  it('an initialize (id 1) error stays unavailable — even with auth wording — and carries an initialize refusal', async () => {
    expect(await read({ initErrorObject: { code: -32000, message: 'handshake failed' } }))
      .toEqual({ kind: 'unavailable', refusal: { stage: 'initialize', text: 'handshake failed' } });
    // No new auth detection on the handshake.
    expect(await read({ initErrorObject: { message: 'authentication required' } }))
      .toEqual({ kind: 'unavailable', refusal: { stage: 'initialize', text: 'authentication required' } });
  });

  it('a read (id 2) auth error is auth-failed with a read refusal; a non-auth one is unavailable with a read refusal', async () => {
    expect(await read({ readErrorObject: { message: 'Unauthorized' } }))
      .toEqual({ kind: 'auth-failed', refusal: { stage: 'read', text: 'Unauthorized' } });
    expect(await read({ readErrorObject: { message: 'device has too many accounts' } }))
      .toEqual({ kind: 'unavailable', refusal: { stage: 'read', text: 'device has too many accounts' } });
  });

  it('appends error.data only when it is a string', async () => {
    expect(await read({ readErrorObject: { message: 'refused', data: 'limit of 3 accounts on this device' } }))
      .toEqual({ kind: 'unavailable', refusal: { stage: 'read', text: 'refused\nlimit of 3 accounts on this device' } });
    expect(await read({ readErrorObject: { message: 'refused', data: { detail: 'object data is dropped' } } }))
      .toEqual({ kind: 'unavailable', refusal: { stage: 'read', text: 'refused' } });
    expect(await read({ initErrorObject: { message: 'init refused', data: 'extra' } }))
      .toEqual({ kind: 'unavailable', refusal: { stage: 'initialize', text: 'init refused\nextra' } });
  });

  it('caps the refusal text at 2 KiB of UTF-8 without splitting a character', async () => {
    const result = await read({ readErrorObject: { message: 'x'.repeat(5000), data: 'y'.repeat(5000) } });
    expect(result.kind).toBe('unavailable');
    const text = result.kind === 'unavailable' ? result.refusal!.text : '';
    expect(Buffer.byteLength(text, 'utf8')).toBe(CODEX_REFUSAL_TEXT_MAX_BYTES);
    expect(text).toBe('x'.repeat(CODEX_REFUSAL_TEXT_MAX_BYTES));

    const multi = capUtf8('é'.repeat(2000), CODEX_REFUSAL_TEXT_MAX_BYTES);
    expect(Buffer.byteLength(multi, 'utf8')).toBeLessThanOrEqual(CODEX_REFUSAL_TEXT_MAX_BYTES);
    expect(multi).toBe('é'.repeat(1024));
    expect(capUtf8('short', 10)).toBe('short');
  });

  it('stderr content never appears in any result', async () => {
    const marker = 'STDERR-SECRET-MARKER-9f2c';
    const results = await Promise.all([
      read({ stderrText: marker, readErrorObject: { message: 'Unauthorized' } }),
      read({ stderrText: marker, readErrorObject: { message: 'boom' } }),
      read({ stderrText: marker, initErrorObject: { message: 'init boom' } }),
      read({ stderrText: marker }),
    ]);
    for (const r of results) expect(JSON.stringify(r)).not.toContain(marker);
  });

  it('two results never share an object, so a refusal cannot leak between results', async () => {
    const a = await read({ readErrorObject: { message: 'boom' } });
    const b = await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: () => { throw new Error('ENOENT'); } });
    const c = await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: () => { throw new Error('ENOENT'); } });
    expect(b).toEqual({ kind: 'unavailable' });
    expect(b).not.toBe(c);
    expect(a).not.toBe(b);
    (b as { refusal?: unknown }).refusal = { stage: 'read', text: 'mutated' };
    expect(c).toEqual({ kind: 'unavailable' });
    // A refusal-carrying result followed by a plain failure: the plain one carries no refusal.
    expect(a).toHaveProperty('refusal');
    expect(c).not.toHaveProperty('refusal');
  });

  it('the non-detailed reader is unchanged: null on every refusal', async () => {
    expect(await readLiveCodexRateLimits({ nowMs: NOW_MS, spawnImpl: scriptedChild({ initErrorObject: { message: 'x' } }).spawnImpl })).toBeNull();
    expect(await readLiveCodexRateLimits({ nowMs: NOW_MS, spawnImpl: scriptedChild({ readErrorObject: { message: 'Unauthorized' } }).spawnImpl })).toBeNull();
  });
});
