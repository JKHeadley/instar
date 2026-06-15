/**
 * handleProcessLevelError + the anchored 'WebSocket is not open' allowlist entry
 * (Robustness Net #1, Goal 3).
 *
 * Both process-level handlers (uncaughtException AND unhandledRejection) delegate
 * to one shared handleProcessLevelError so they cannot drift: one narrow allowlist,
 * one fail-toward-crash default, one dedup'd log. These tests exercise BOTH sides of
 * the boundary under BOTH labels with injected cleanup/exit fakes (so the fatal path
 * is observable without actually exiting), and pin the anchored allowlist entry —
 * including the NEGATIVE cases that the bare 'is not open' substring would wrongly
 * swallow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleProcessLevelError,
  isNonFatalUncaught,
  __resetUncaughtStackDedupeForTests,
} from '../../src/core/uncaughtExceptionPolicy.js';

type Label = 'uncaughtException' | 'unhandledRejection';
const LABELS: Label[] = ['uncaughtException', 'unhandledRejection'];

function makeOpts() {
  const onFatalCleanup = vi.fn();
  const exit = vi.fn() as unknown as (code: number) => never;
  return { onFatalCleanup, exit, opts: { onFatalCleanup, exit } };
}

beforeEach(() => {
  __resetUncaughtStackDedupeForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('handleProcessLevelError — recoverable (allowlisted) errors', () => {
  it.each(LABELS)('%s: the Node built-in WebSocket non-OPEN message is recovered (no cleanup, no exit)', (label) => {
    const { onFatalCleanup, exit, opts } = makeOpts();
    const verdict = handleProcessLevelError(
      new Error('WebSocket is not open: readyState 2 (CLOSING)'),
      label,
      opts,
    );
    expect(verdict).toBe('recovered');
    expect(onFatalCleanup).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it.each(LABELS)('%s: the ws-polyfill "Sent before connected" message is recovered', (label) => {
    const { onFatalCleanup, exit, opts } = makeOpts();
    expect(handleProcessLevelError(new Error('Sent before connected.'), label, opts)).toBe('recovered');
    expect(onFatalCleanup).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('recovers a non-Error string rejection that matches the allowlist (unhandledRejection)', () => {
    const { exit, opts } = makeOpts();
    expect(handleProcessLevelError('WebSocket is not open: readyState 3', 'unhandledRejection', opts)).toBe('recovered');
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('handleProcessLevelError — fatal (unknown) errors crash by default', () => {
  it.each(LABELS)('%s: an unrecognized error runs cleanup then exits(1)', (label) => {
    const { onFatalCleanup, exit, opts } = makeOpts();
    const verdict = handleProcessLevelError(new Error('genuine unknown corruption'), label, opts);
    expect(verdict).toBe('fatal');
    expect(onFatalCleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a cleanup that throws does not stop the exit (best-effort cleanup)', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const onFatalCleanup = vi.fn(() => { throw new Error('cleanup blew up'); });
    const verdict = handleProcessLevelError(new Error('unknown'), 'uncaughtException', { onFatalCleanup, exit });
    expect(verdict).toBe('fatal');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a non-Error, non-allowlisted rejection reason is fatal', () => {
    const { exit, opts } = makeOpts();
    expect(handleProcessLevelError({ weird: 'object' }, 'unhandledRejection', opts)).toBe('fatal');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('anchored allowlist — must NOT swallow look-alike fatal errors', () => {
  it('the registration "is not open" message does NOT match (would be a fatal swallow)', () => {
    // TelegramAdapter / AuthGate emit "<name> is not open for public registration".
    expect(isNonFatalUncaught(new Error('Workspace is not open for public registration'))).toBe(false);
  });

  it('a "database connection is not open" message does NOT match', () => {
    // SqliteRegistry's already-closed-handle throw — a genuine DB-layer error.
    expect(isNonFatalUncaught(new Error('database connection is not open'))).toBe(false);
  });

  it('the bare phrase "is not open" alone does NOT match (anchor requires "WebSocket")', () => {
    expect(isNonFatalUncaught(new Error('the door is not open'))).toBe(false);
  });

  it('still matches the real Node built-in WebSocket message form', () => {
    expect(isNonFatalUncaught(new Error('WebSocket is not open: readyState 2'))).toBe(true);
  });

  it('routes the registration look-alike to the fatal path end-to-end', () => {
    const { onFatalCleanup, exit, opts } = makeOpts();
    expect(handleProcessLevelError(new Error('Acme is not open for public registration'), 'uncaughtException', opts)).toBe('fatal');
    expect(onFatalCleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
