/**
 * Verifies the uncaught-exception recoverability policy (#43). The server's
 * process-level uncaughtException handler crashes by default; this policy is the
 * allowlist of isolated, recoverable errors it should log-and-continue on
 * instead of closing its databases and exiting. Both sides of the boundary are
 * tested with realistic messages.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isNonFatalUncaught,
  shouldLogStackForUncaught,
  __resetUncaughtStackDedupeForTests,
} from '../../src/core/uncaughtExceptionPolicy.js';

describe('isNonFatalUncaught', () => {
  it('treats the Slack Socket Mode reconnect race as recoverable (#43 — must not crash the agent)', () => {
    expect(isNonFatalUncaught(new Error('Sent before connected.'))).toBe(true);
    // Substring match — the WS layer may decorate the message.
    expect(isNonFatalUncaught(new Error('WebSocket error: Sent before connected'))).toBe(true);
  });

  it('treats the existing HTTP double-response races as recoverable (precedent unchanged)', () => {
    expect(isNonFatalUncaught(new Error('Cannot set headers after they are sent to the client'))).toBe(true);
    expect(isNonFatalUncaught(new Error('write after end'))).toBe(true);
    expect(isNonFatalUncaught(new Error('ERR_HTTP_HEADERS_SENT'))).toBe(true);
    expect(isNonFatalUncaught(new Error('ERR_STREAM_WRITE_AFTER_END'))).toBe(true);
  });

  it('treats a standby read-only write as recoverable (must not crash-loop on a peer-held lease)', () => {
    // The exact throw from StateManager.guardWrite() on a standby machine.
    expect(
      isNonFatalUncaught(
        new Error('StateManager is read-only (this machine is on standby). Blocked: appendEvent'),
      ),
    ).toBe(true);
    // Any blocked operation name, decorated message — substring match.
    expect(
      isNonFatalUncaught(new Error('FATAL: StateManager is read-only (this machine is on standby). Blocked: write')),
    ).toBe(true);
  });

  it('treats network-class outbound failures as recoverable (CMT-1548 — a transient outage must not crash the agent)', () => {
    // The exact crasher: an uncaught `fetch failed` during an upstream/peer
    // outage (e.g. the multi-machine lease-wire broadcast to an offline peer)
    // took the whole server down on 2026-06-15. A failed outbound call is
    // isolated; the owning subsystem retries.
    expect(isNonFatalUncaught(new Error('fetch failed'))).toBe(true);
    expect(isNonFatalUncaught(new TypeError('fetch failed'))).toBe(true); // undici throws a TypeError
    expect(isNonFatalUncaught(new Error('connect ECONNREFUSED 127.0.0.1:4042'))).toBe(true);
    expect(isNonFatalUncaught(new Error('read ECONNRESET'))).toBe(true);
    expect(isNonFatalUncaught(new Error('connect ETIMEDOUT'))).toBe(true);
    expect(isNonFatalUncaught(new Error('getaddrinfo ENOTFOUND relay.example.com'))).toBe(true);
    expect(isNonFatalUncaught(new Error('getaddrinfo EAI_AGAIN relay.example.com'))).toBe(true);
    expect(isNonFatalUncaught(new Error('socket hang up'))).toBe(true);
  });

  it('treats an UNKNOWN error as fatal (crash is the safe default)', () => {
    expect(isNonFatalUncaught(new Error('mutex lock failed'))).toBe(false);
    expect(isNonFatalUncaught(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isNonFatalUncaught(new Error('better-sqlite3 database is closed'))).toBe(false);
    // A non-network "failed" message must NOT be caught by the network patterns
    // (boundary stays tight — we match specific tokens, not a bare "failed").
    expect(isNonFatalUncaught(new Error('assertion failed'))).toBe(false);
    expect(isNonFatalUncaught(new Error('migration failed'))).toBe(false);
  });

  it('is robust to non-Error inputs', () => {
    expect(isNonFatalUncaught(undefined)).toBe(false);
    expect(isNonFatalUncaught(null)).toBe(false);
    expect(isNonFatalUncaught('Sent before connected')).toBe(true); // string with a known pattern
    expect(isNonFatalUncaught({})).toBe(false);
    expect(isNonFatalUncaught(new Error(''))).toBe(false); // empty message → not matched
  });
});

/**
 * #72 — the suppressed-uncaught handler logs the offending stack the FIRST time
 * a given origin appears (so a double-responding route is diagnosable) then
 * message-only for repeats (these races fire ~10-20x/hour; the stack would flood).
 */
describe('shouldLogStackForUncaught', () => {
  beforeEach(() => __resetUncaughtStackDedupeForTests());

  function errWithStack(message: string, stack: string): Error {
    const e = new Error(message);
    e.stack = stack;
    return e;
  }

  it('logs the stack the FIRST time an origin is seen, then suppresses repeats', () => {
    const e = errWithStack(
      'Cannot set headers after they are sent to the client',
      'Error: Cannot set headers...\n  at routeFoo (/app/src/routes/foo.ts:10:5)',
    );
    expect(shouldLogStackForUncaught(e)).toBe(true); // first → log stack
    expect(shouldLogStackForUncaught(e)).toBe(false); // repeat → suppress
    // Key is the stack string, so a fresh Error with the SAME stack is still deduped.
    expect(shouldLogStackForUncaught(errWithStack('Cannot set headers...', e.stack!))).toBe(false);
  });

  it('surfaces a DIFFERENT origin (distinct stack) once, even for the same message', () => {
    const a = errWithStack('Cannot set headers after they are sent', 'Error\n  at routeA (/app/a.ts:1:1)');
    const b = errWithStack('Cannot set headers after they are sent', 'Error\n  at routeB (/app/b.ts:2:2)');
    expect(shouldLogStackForUncaught(a)).toBe(true);
    expect(shouldLogStackForUncaught(b)).toBe(true); // different stack → its own first-log
    expect(shouldLogStackForUncaught(a)).toBe(false); // a already seen
  });

  it('returns false for non-Error / stackless input (nothing to attach)', () => {
    expect(shouldLogStackForUncaught(undefined)).toBe(false);
    expect(shouldLogStackForUncaught('Cannot set headers')).toBe(false);
    const noStack = new Error('x');
    noStack.stack = undefined;
    expect(shouldLogStackForUncaught(noStack)).toBe(false);
  });

  it('re-surfaces a stack after the dedup memory is reset', () => {
    const e = errWithStack('write after end', 'Error: write after end\n  at routeZ');
    expect(shouldLogStackForUncaught(e)).toBe(true);
    expect(shouldLogStackForUncaught(e)).toBe(false);
    __resetUncaughtStackDedupeForTests();
    expect(shouldLogStackForUncaught(e)).toBe(true); // logs again after reset
  });

  it('bounds memory: clears tracking past the cap so it cannot grow without limit', () => {
    const first = errWithStack('write after end', 'Error\n  at origin0');
    expect(shouldLogStackForUncaught(first)).toBe(true);
    expect(shouldLogStackForUncaught(first)).toBe(false); // now tracked
    // Exceed MAX_TRACKED_STACKS (200) with distinct stacks → triggers a clear.
    for (let i = 1; i <= 200; i++) {
      shouldLogStackForUncaught(errWithStack('write after end', `Error\n  at origin${i}`));
    }
    expect(shouldLogStackForUncaught(first)).toBe(true); // cleared past cap → surfaces again
  });
});
