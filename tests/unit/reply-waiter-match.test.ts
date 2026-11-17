import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { replyWaiterAccepts } from '../../src/threadline/replyWaiterMatch.js';

const PEER = 'aa11'.repeat(16);
const OTHER = 'bb22'.repeat(16);
const single = { multiPerson: false, linkedPeerReplies: 'deliver' };
const multi = { multiPerson: true, linkedPeerReplies: 'deliver' };

describe('replyWaiterAccepts — only the routed peer resolves a waiting send', () => {
  describe('relay path (sender always proven)', () => {
    const relay = { ...single, allowUnprovenSender: false };
    it('the routed peer resolves the wait (single-person agent)', () => {
      expect(replyWaiterAccepts({ routedFp: PEER }, { ...relay, senderFp: PEER })).toBe(true);
    });
    it('another peer on the same thread does NOT resolve it (single-person agent)', () => {
      expect(replyWaiterAccepts({ routedFp: PEER }, { ...relay, senderFp: OTHER })).toBe(false);
    });
    it('fingerprint case does not matter', () => {
      expect(replyWaiterAccepts({ routedFp: PEER.toUpperCase() }, { ...relay, senderFp: PEER })).toBe(true);
    });
    it('an unproven sender never resolves a routed wait on the relay path', () => {
      expect(replyWaiterAccepts({ routedFp: PEER }, { ...relay, senderFp: null })).toBe(false);
    });
    it('a waiter with no routed fingerprint keeps the old single-person behaviour', () => {
      expect(replyWaiterAccepts({}, { ...relay, senderFp: OTHER })).toBe(true);
    });
  });

  describe('multi-person agents keep the memory-privacy rule on top', () => {
    const relay = { ...multi, allowUnprovenSender: false };
    it('addressed and routed peer resolves it', () => {
      expect(replyWaiterAccepts({ routedFp: PEER, recipientFp: PEER }, { ...relay, senderFp: PEER })).toBe(true);
    });
    it('routed but not addressed (sent by a directory-name lookup) does not', () => {
      expect(replyWaiterAccepts({ routedFp: PEER, recipientFp: null }, { ...relay, senderFp: PEER })).toBe(false);
    });
    it('never under post-only', () => {
      expect(replyWaiterAccepts({ routedFp: PEER, recipientFp: PEER }, { ...relay, linkedPeerReplies: 'post-only', senderFp: PEER })).toBe(false);
    });
    it('another peer does not, even when it is the addressed one but not the routed one', () => {
      expect(replyWaiterAccepts({ routedFp: PEER, recipientFp: OTHER }, { ...relay, senderFp: OTHER })).toBe(false);
    });
  });

  describe('local route (every same-machine agent holds its token, so the token proves nothing)', () => {
    const local = { ...single, allowUnprovenSender: false };
    it('a sender identified as another peer is refused', () => {
      expect(replyWaiterAccepts({ routedFp: PEER }, { ...local, senderFp: OTHER })).toBe(false);
    });
    it('the routed peer is accepted', () => {
      expect(replyWaiterAccepts({ routedFp: PEER }, { ...local, senderFp: PEER })).toBe(true);
    });
    it('a sender that cannot be identified at all is refused for a routed wait', () => {
      expect(replyWaiterAccepts({ routedFp: PEER }, { ...local, senderFp: null })).toBe(false);
    });
  });

  describe('old rules preserved when the send has no routed fingerprint', () => {
    it('multi-person: addressed + proven sender resolves, anything else does not', () => {
      const ctx = { ...multi, allowUnprovenSender: false };
      expect(replyWaiterAccepts({ recipientFp: PEER }, { ...ctx, senderFp: PEER })).toBe(true);
      expect(replyWaiterAccepts({ recipientFp: PEER }, { ...ctx, senderFp: OTHER })).toBe(false);
      expect(replyWaiterAccepts({ recipientFp: PEER }, { ...ctx, senderFp: null })).toBe(false);
      expect(replyWaiterAccepts({ recipientFp: null }, { ...ctx, senderFp: PEER })).toBe(false);
    });
  });

  describe('wiring: both inbound paths use the shared rule', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf-8');
    it('relay socket path (server.ts) calls it with allowUnprovenSender:false and the relay-authenticated sender', () => {
      const src = read('src/commands/server.ts');
      expect(src).toMatch(/replyWaiterAccepts\(waiter, \{\s*senderFp: senderFingerprint,[\s\S]{0,200}allowUnprovenSender: false/);
    });
    it('local route (routes.ts) calls it with the identified sender and never allows an unidentified one', () => {
      const src = read('src/server/routes.ts');
      expect(src).toMatch(/replyWaiterAccepts\(waiter, \{\s*senderFp: waiterSenderFp,[\s\S]{0,200}allowUnprovenSender: false/);
      // any verified signature counts (not only enforcing mode), and multi-person never uses the name lookup
      expect(src).toContain('if (sigVerdict.ok && sigVerdict.fingerprint) signedSenderFp = sigVerdict.fingerprint;');
      expect(src).toMatch(/waiterMultiPerson\s*\?\s*signedSenderFp\s*:/);
    });
    it('both waiting sends record the routed fingerprint', () => {
      const src = read('src/server/routes.ts');
      expect(src).toContain('addressedFpNow(), resolvedId)');
      expect(src).toContain('addressedFpNow(), resolvePeerFingerprint(localTarget) || null)');
      expect(src).toContain('routedFp: routedFp ? routedFp.toLowerCase() : null');
    });
  });
});
