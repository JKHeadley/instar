/**
 * Verifies the uncaught-exception recoverability policy (#43). The server's
 * process-level uncaughtException handler crashes by default; this policy is the
 * allowlist of isolated, recoverable errors it should log-and-continue on
 * instead of closing its databases and exiting. Both sides of the boundary are
 * tested with realistic messages.
 */
import { describe, it, expect } from 'vitest';
import { isNonFatalUncaught } from '../../src/core/uncaughtExceptionPolicy.js';

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

  it('treats an UNKNOWN error as fatal (crash is the safe default)', () => {
    expect(isNonFatalUncaught(new Error('mutex lock failed'))).toBe(false);
    expect(isNonFatalUncaught(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isNonFatalUncaught(new Error('better-sqlite3 database is closed'))).toBe(false);
  });

  it('is robust to non-Error inputs', () => {
    expect(isNonFatalUncaught(undefined)).toBe(false);
    expect(isNonFatalUncaught(null)).toBe(false);
    expect(isNonFatalUncaught('Sent before connected')).toBe(true); // string with a known pattern
    expect(isNonFatalUncaught({})).toBe(false);
    expect(isNonFatalUncaught(new Error(''))).toBe(false); // empty message → not matched
  });
});
