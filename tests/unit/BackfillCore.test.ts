/**
 * Unit tests for BackfillCore — pure helpers shared with
 * scripts/threadline-bridge-backfill.mjs.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTopicName,
  chunkBody,
  groupByThread,
  pickCounterparty,
  ledgerKey,
  formatBackfillMessage,
  MAX_BODY_CHARS,
  TOPIC_NAME_MAX,
} from '../../src/threadline/BackfillCore.js';

describe('BackfillCore', () => {
  describe('buildTopicName', () => {
    it('builds the documented "local↔remote — subject" shape', () => {
      expect(buildTopicName('echo', 'Dawn', 'memory rot gates')).toBe('echo↔Dawn — memory rot gates');
    });

    it('truncates long subjects with an ellipsis to <= 96 chars', () => {
      const name = buildTopicName('echo', 'Dawn', 'a'.repeat(200));
      expect(name.length).toBeLessThanOrEqual(TOPIC_NAME_MAX);
      expect(name).toMatch(/echo↔Dawn — a+…$/);
    });

    it('falls back to "thread" subject when none provided', () => {
      expect(buildTopicName('echo', 'Dawn')).toBe('echo↔Dawn — thread');
    });

    it('collapses whitespace in subject', () => {
      expect(buildTopicName('echo', 'Dawn', 'a   b\t\nc')).toBe('echo↔Dawn — a b c');
    });
  });

  describe('chunkBody', () => {
    it('returns the body unchanged when within the cap', () => {
      expect(chunkBody('hello')).toEqual(['hello']);
    });

    it('splits long bodies into sub-MAX pieces', () => {
      const body = 'x'.repeat(MAX_BODY_CHARS * 2 + 10);
      const chunks = chunkBody(body);
      expect(chunks.length).toBe(3);
      expect(chunks[0]!.length).toBe(MAX_BODY_CHARS);
      expect(chunks[1]!.length).toBe(MAX_BODY_CHARS);
      expect(chunks[2]!.length).toBe(10);
      expect(chunks.every(c => c.length <= MAX_BODY_CHARS)).toBe(true);
    });
  });

  describe('groupByThread', () => {
    it('returns an empty map when no rows are provided', () => {
      expect(groupByThread([], [])).toEqual(new Map());
    });

    it('groups inbox + outbox + seed under the same threadId', () => {
      const map = groupByThread(
        [{ id: 'i1', threadId: 't1', timestamp: '2026-04-28T12:00:00Z', from: 'fp-d', senderName: 'Dawn', text: 'in1' }],
        [{ id: 'o1', threadId: 't1', timestamp: '2026-04-28T12:01:00Z', to: 'fp-d', recipientName: 'Dawn', text: 'out1' }],
        [{ id: 's1', threadId: 't1', timestamp: '2026-04-28T11:59:00Z', direction: 'in', remoteAgent: 'fp-d', remoteAgentName: 'Dawn', text: 'seed-pre' }],
      );
      expect(map.size).toBe(1);
      const msgs = map.get('t1')!;
      expect(msgs).toHaveLength(3);
      // Sorted chronologically
      expect(msgs.map(m => m.id)).toEqual(['s1', 'i1', 'o1']);
      expect(msgs.map(m => m.direction)).toEqual(['in', 'in', 'out']);
    });

    it('drops rows with no threadId', () => {
      const map = groupByThread(
        [{ id: 'i', timestamp: 't', from: 'x', text: 'no-thread' }],
        [],
      );
      expect(map.size).toBe(0);
    });
  });

  describe('pickCounterparty', () => {
    it('prefers the first inbound sender', () => {
      const cp = pickCounterparty([
        { direction: 'in', text: '', remoteAgent: 'fp-d', remoteAgentName: 'Dawn' },
        { direction: 'out', text: '', remoteAgent: 'fp-d', remoteAgentName: 'Dawn-out' },
      ]);
      expect(cp).toEqual({ id: 'fp-d', name: 'Dawn' });
    });

    it('falls back to the first outbound recipient when no inbound', () => {
      const cp = pickCounterparty([
        { direction: 'out', text: '', remoteAgent: 'fp-d', remoteAgentName: 'Dawn' },
      ]);
      expect(cp).toEqual({ id: 'fp-d', name: 'Dawn' });
    });

    it('returns "(unknown)" for an empty thread', () => {
      expect(pickCounterparty([])).toEqual({ id: '(unknown)', name: '(unknown)' });
    });
  });

  describe('ledgerKey', () => {
    it('uses the message id when present', () => {
      expect(ledgerKey({ id: 'msg-1', direction: 'in', text: 'x' })).toBe('msg-1');
    });

    it('falls back to direction + timestamp + text-prefix when id is missing', () => {
      const k = ledgerKey({ direction: 'in', timestamp: '2026-04-28T12:00:00Z', text: 'hello world' });
      expect(k).toBe('in:2026-04-28T12:00:00Z:hello world');
    });
  });

  describe('formatBackfillMessage', () => {
    it('renders the inbound shape', () => {
      const out = formatBackfillMessage(
        { direction: 'in', remoteAgentName: 'Dawn', timestamp: '2026-04-28T12:00:00Z', text: 'hi' },
        'echo',
      );
      expect(out).toBe('📥 Dawn → echo\n2026-04-28T12:00:00Z\nhi');
    });

    it('renders the outbound shape', () => {
      const out = formatBackfillMessage(
        { direction: 'out', remoteAgentName: 'Dawn', timestamp: '2026-04-28T12:01:00Z', text: 'reply' },
        'echo',
      );
      expect(out).toBe('📤 echo → Dawn\n2026-04-28T12:01:00Z\nreply');
    });
  });
});
