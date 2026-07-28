import { describe, expect, it, vi } from 'vitest';
import { isAuthenticatedThreadlineInbound } from '../../../src/threadline/ThreadlineReplyValidation.js';

// canonical-migration-validator: threadline-inbound-canonical-store@1

const THREAD = 'cfe01486-a896-4357-88a8-0251aacd2979';
const MESSAGE = 'msg-1784436346759-dvffo8';

describe('isAuthenticatedThreadlineInbound', () => {
  it('accepts a verified legacy HMAC inbox entry on the claimed thread', () => {
    const readCanonicalInboxEntry = vi.fn(() => ({ id: MESSAGE, threadId: THREAD } as never));
    expect(isAuthenticatedThreadlineInbound({ listenerManager: { readCanonicalInboxEntry } }, THREAD, MESSAGE)).toBe(true);
  });

  it('accepts a modern canonical ThreadLog inbound when the legacy inbox is empty', () => {
    const threadLog = {
      isPathConfined: vi.fn(() => true),
      has: vi.fn((_threadId: string, _messageId: string, direction: string) => direction === 'inbound'),
    };
    expect(isAuthenticatedThreadlineInbound({
      listenerManager: { readCanonicalInboxEntry: vi.fn(() => null) },
      threadLog,
    }, THREAD, MESSAGE)).toBe(true);
    expect(threadLog.has).toHaveBeenCalledWith(THREAD, MESSAGE, 'inbound');
  });

  it('never accepts an outbound leg as reply authority', () => {
    const threadLog = { isPathConfined: vi.fn(() => true), has: vi.fn(() => false) };
    expect(isAuthenticatedThreadlineInbound({ listenerManager: { readCanonicalInboxEntry: vi.fn(() => null) }, threadLog }, THREAD, MESSAGE)).toBe(false);
    expect(threadLog.has).toHaveBeenCalledWith(THREAD, MESSAGE, 'inbound');
  });

  it('fails closed when evidence exists but the reply-claim authority is unavailable', () => {
    const threadLog = { isPathConfined: vi.fn(() => true), has: vi.fn(() => true) };
    expect(isAuthenticatedThreadlineInbound({ threadLog }, THREAD, MESSAGE)).toBe(false);
    expect(threadLog.has).not.toHaveBeenCalled();
  });

  it('rejects a legacy entry from another thread', () => {
    const readCanonicalInboxEntry = vi.fn(() => ({ id: MESSAGE, threadId: 'thread-other' } as never));
    expect(isAuthenticatedThreadlineInbound({ listenerManager: { readCanonicalInboxEntry } }, THREAD, MESSAGE)).toBe(false);
  });

  it('fails closed for unconfined thread ids before reading the modern log', () => {
    const threadLog = { isPathConfined: vi.fn(() => false), has: vi.fn(() => true) };
    expect(isAuthenticatedThreadlineInbound({ listenerManager: { readCanonicalInboxEntry: vi.fn(() => null) }, threadLog }, '../../escape', MESSAGE)).toBe(false);
    expect(threadLog.has).not.toHaveBeenCalled();
  });

  it('falls through a broken legacy store to valid modern authority', () => {
    const listenerManager = { readCanonicalInboxEntry: vi.fn(() => { throw new Error('unreadable'); }) };
    const threadLog = { isPathConfined: vi.fn(() => true), has: vi.fn(() => true) };
    expect(isAuthenticatedThreadlineInbound({ listenerManager, threadLog }, THREAD, MESSAGE)).toBe(true);
  });

  it.each([
    [undefined, MESSAGE], [THREAD, undefined], ['', MESSAGE], [THREAD, ''], [123, MESSAGE],
  ])('rejects malformed pointer inputs (%j, %j)', (threadId, messageId) => {
    expect(isAuthenticatedThreadlineInbound({}, threadId, messageId)).toBe(false);
  });
});
