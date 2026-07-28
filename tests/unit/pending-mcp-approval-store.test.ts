/**
 * PendingMcpApprovalStore — the registry behind the operator-approval tap surface.
 * Verifies opaque ids, peek-never-exposes-nonce, single-use consume, TTL.
 */
import { describe, it, expect } from 'vitest';
import { PendingMcpApprovalStore } from '../../src/core/PendingMcpApprovalStore.js';

describe('PendingMcpApprovalStore', () => {
  it('register returns an opaque id; peek exposes details but NEVER the nonce', () => {
    const s = new PendingMcpApprovalStore();
    const id = s.register({ topicId: 5, kind: 'load', server: 'playwright', nonce: 'SECRET' });
    expect(typeof id).toBe('string');
    const view = s.peek(id);
    expect(view).toMatchObject({ requestId: id, topicId: 5, kind: 'load', server: 'playwright' });
    expect(JSON.stringify(view)).not.toContain('SECRET'); // the nonce never leaks to the page
    expect((view as Record<string, unknown>).nonce).toBeUndefined();
  });

  it('consume returns the full entry (incl. nonce) ONCE, then it is gone (single-use)', () => {
    const s = new PendingMcpApprovalStore();
    const id = s.register({ topicId: 5, kind: 'load', server: 'playwright', nonce: 'SECRET' });
    const first = s.consume(id);
    expect(first).toMatchObject({ topicId: 5, kind: 'load', server: 'playwright', nonce: 'SECRET' });
    expect(s.consume(id)).toBeNull(); // single-use
    expect(s.peek(id)).toBeNull();
  });

  it('peek does NOT consume (the page can render repeatedly before approval)', () => {
    const s = new PendingMcpApprovalStore();
    const id = s.register({ topicId: 5, kind: 'load', server: 'playwright', nonce: 'n' });
    expect(s.peek(id)).not.toBeNull();
    expect(s.peek(id)).not.toBeNull(); // still there
    expect(s.consume(id)).not.toBeNull();
  });

  it('an unknown id ⇒ peek/consume null', () => {
    const s = new PendingMcpApprovalStore();
    expect(s.peek('nope')).toBeNull();
    expect(s.consume('nope')).toBeNull();
  });

  it('expires after the TTL (peek and consume both null)', () => {
    let t = 1000;
    const s = new PendingMcpApprovalStore(5000, () => t);
    const id = s.register({ topicId: 5, kind: 'load', server: 'playwright', nonce: 'n' });
    t = 6001;
    expect(s.peek(id)).toBeNull();
    // a fresh entry to test consume-expiry independently
    t = 0; const s2 = new PendingMcpApprovalStore(5000, () => t);
    const id2 = s2.register({ topicId: 1, kind: 'offload', server: 'x', nonce: 'n' });
    t = 6000;
    expect(s2.consume(id2)).toBeNull();
  });

  it('size reflects outstanding entries and prunes expired', () => {
    let t = 0;
    const s = new PendingMcpApprovalStore(1000, () => t);
    s.register({ topicId: 1, kind: 'load', server: 'a', nonce: 'n' });
    s.register({ topicId: 2, kind: 'load', server: 'b', nonce: 'n' });
    expect(s.size()).toBe(2);
    t = 2000;
    expect(s.size()).toBe(0);
  });
});
