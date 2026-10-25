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

  it('treats a malformed window (missing fields) as absent rather than guessing', () => {
    const r = liveResult();
    (r.rateLimitsByLimitId as Record<string, Record<string, unknown>>).codex.primary = {
      usedPercent: 'lots',
    };
    const snap = mapLiveResponse(r, NOW_MS);
    expect(snap!.primary).toBeNull();
    expect(snap!.windowsUnavailable).toBe(true);
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
        if (opts.garbageFirst) child.stdout.emit('data', Buffer.from('not json at all\n'));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`));
      });
    };
    if (msg.id === 1) {
      reply(opts.initError ? { id: 1, error: { message: 'nope' } } : { id: 1, result: {} });
    } else if (msg.id === 2) {
      if (opts.readErrorMessage) reply({ id: 2, error: { code: -32600, message: opts.readErrorMessage } });
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
    expect(read).toEqual({ kind: 'auth-failed' });
    expect(child.killed).toBe(true);
    // The null-returning wrapper still reads it as "no snapshot" for existing callers.
    const again = scriptedChild({ readErrorMessage: 'codex account authentication required to read rate limits' });
    expect(await readLiveCodexRateLimits({ nowMs: NOW_MS, spawnImpl: again.spawnImpl })).toBeNull();
  });

  it('keeps a non-auth protocol error, an init error and a timeout as unavailable (never evidence of sign-out)', async () => {
    expect(await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: scriptedChild({ readError: true }).spawnImpl }))
      .toEqual({ kind: 'unavailable' });
    expect(await readLiveCodexRateLimitsDetailed({ nowMs: NOW_MS, spawnImpl: scriptedChild({ initError: true }).spawnImpl }))
      .toEqual({ kind: 'unavailable' });
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
