/**
 * Unit tests for the WS1.1 Slack arm owner-side bridge helpers
 * (SlackForwardBridge). These cover BOTH sides of the decision boundary the
 * owner-side onAccepted bridge keys on: numeric (Telegram) vs non-numeric
 * (Slack) session keys, and the routing-key → Message reconstruction.
 */
import { describe, it, expect } from 'vitest';
import {
  isSlackSessionKey,
  parseSlackRoutingKey,
  reconstructSlackMessage,
} from '../../src/core/SlackForwardBridge.js';

describe('SlackForwardBridge.isSlackSessionKey — Slack vs Telegram key discrimination', () => {
  it('a pure-numeric key (Telegram topic) is NOT a Slack key', () => {
    expect(isSlackSessionKey('13481')).toBe(false);
    expect(isSlackSessionKey('0')).toBe(false);
    expect(isSlackSessionKey('999999999')).toBe(false);
  });

  it('a Slack channel id is a Slack key', () => {
    expect(isSlackSessionKey('C0123ABCD')).toBe(true);
    expect(isSlackSessionKey('D0456EFGH')).toBe(true); // DM
    expect(isSlackSessionKey('G0789IJKL')).toBe(true); // private group
  });

  it('a Slack thread routing key (channel:thread_ts) is a Slack key', () => {
    expect(isSlackSessionKey('C0123ABCD:1716200000.001500')).toBe(true);
  });
});

describe('SlackForwardBridge.parseSlackRoutingKey — split channel + thread', () => {
  it('a bare channel id has no thread_ts', () => {
    expect(parseSlackRoutingKey('C0123ABCD')).toEqual({ channelId: 'C0123ABCD' });
  });

  it('a thread key splits on the first colon (ts contains a dot, never a colon)', () => {
    expect(parseSlackRoutingKey('C0123ABCD:1716200000.001500')).toEqual({
      channelId: 'C0123ABCD',
      threadTs: '1716200000.001500',
    });
  });
});

describe('SlackForwardBridge.reconstructSlackMessage — forwarded → inbound Message', () => {
  it('reconstructs a channel message with sender id carried through', () => {
    const m = reconstructSlackMessage({
      sessionKey: 'C0123ABCD',
      messageId: 'slack-1716200000.001500',
      text: 'hello from the peer',
      senderUserId: 'U999USER',
    });
    expect(m.channel).toEqual({ type: 'slack', identifier: 'C0123ABCD' });
    expect(m.content).toBe('hello from the peer');
    expect(m.id).toBe('slack-1716200000.001500');
    expect(m.userId).toBe('U999USER');
    expect(m.metadata?.channelId).toBe('C0123ABCD');
    expect(m.metadata?.threadTs).toBeUndefined();
    expect(m.metadata?.isDM).toBe(false);
    expect(m.metadata?.slackUserId).toBe('U999USER');
  });

  it('reconstructs a thread message carrying the thread_ts (so the owner resumes the thread session)', () => {
    const m = reconstructSlackMessage({
      sessionKey: 'C0123ABCD:1716200000.001500',
      messageId: 'slack-1716200099.002000',
      text: 'reply in thread',
    });
    expect(m.channel.identifier).toBe('C0123ABCD');
    expect(m.metadata?.threadTs).toBe('1716200000.001500');
  });

  it('marks a DM channel (D-prefixed) so it routes to the lifeline session, and falls back userId→channelId when no sender carried', () => {
    const m = reconstructSlackMessage({
      sessionKey: 'D0456EFGH',
      messageId: 'slack-1',
      text: 'dm',
    });
    expect(m.metadata?.isDM).toBe(true);
    expect(m.userId).toBe('D0456EFGH'); // no senderUserId → channelId fallback
    expect(m.metadata?.slackUserId).toBeUndefined();
  });
});
