/**
 * The server's a2a redeliver callback (createOutboxRedeliver) with encrypt-to-pinned enforcing
 * (spec threadline-standalone-pairing D9): sendAuto can now throw EncryptToPinnedSendError, and
 * that must read as "not redelivered" (false), never as a send. Other errors still propagate so
 * the sentinel logs them.
 */
import { describe, it, expect } from 'vitest';
import { createOutboxRedeliver } from '../../src/monitoring/A2ARedeliverySentinel.js';
import { EncryptToPinnedSendError } from '../../src/threadline/client/ThreadlineClient.js';

const entry = { messageId: 'm-1', peerFp: 'ab'.repeat(16), threadId: 't-1' } as never;

describe('createOutboxRedeliver', () => {
  it('re-sends the stored body and reports true', () => {
    const calls: unknown[][] = [];
    const r = createOutboxRedeliver({ readOutboxEntry: () => ({ text: 'body', threadId: 't-0' }), sendAuto: (...a) => { calls.push(a); return 'x'; } });
    expect(r(entry)).toBe(true);
    expect(calls).toEqual([['ab'.repeat(16), 'body', 't-1']]);
  });

  it('a missing body: false, nothing sent', () => {
    let called = false;
    const r = createOutboxRedeliver({ readOutboxEntry: () => null, sendAuto: () => { called = true; } });
    expect(r(entry)).toBe(false);
    expect(called).toBe(false);
  });

  it('EncryptToPinnedSendError (enforce fails closed): false — not redelivered', () => {
    const r = createOutboxRedeliver({
      readOutboxEntry: () => ({ text: 'body' }),
      sendAuto: (fp) => { throw new EncryptToPinnedSendError(fp, new Error('x'), 'lookup-failed'); },
    });
    expect(r(entry)).toBe(false);
  });

  it('control: any other send error propagates (the sentinel logs it)', () => {
    const r = createOutboxRedeliver({ readOutboxEntry: () => ({ text: 'body' }), sendAuto: () => { throw new Error('socket closed'); } });
    expect(() => r(entry)).toThrow('socket closed');
  });
});
