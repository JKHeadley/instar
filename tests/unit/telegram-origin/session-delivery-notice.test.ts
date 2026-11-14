import { describe, expect, it } from 'vitest';
import {
  definiteSessionLine, failureCausePhrase, lateDeliverySessionBatch, lateDeliverySessionLine, lateLineForParseMode,
  lateRecoveredReplyNotice, ownerUnstatedSessionLine, replyAge, sessionDeliveryNotice, uncertainSessionLine,
} from '../../../src/messaging/telegram-origin/SessionDeliveryNotice.js';

const MIN = 60_000;

describe('session delivery notices', () => {
  it('distinguishes delayed, lost, and uncertain replies in plain words', () => {
    expect(sessionDeliveryNotice('held').topicText).toContain('delayed');
    expect(sessionDeliveryNotice('known-failed').topicText).toBe('An earlier reply did not reach you after a delivery interruption.');
    expect(sessionDeliveryNotice('expired', true).topicText).toBe('An earlier reply may not have reached you. I cannot confirm either way, so I have not sent it twice. If it is missing, tell me and I will send it again.');
  });
  it('no uncertain text ever says the reply "did not reach you" (FD-13)', () => {
    for (const text of [sessionDeliveryNotice('outcome-unknown').topicText, sessionDeliveryNotice('expired', true).topicText,
      sessionDeliveryNotice('outcome-unknown').summary, uncertainSessionLine({ operationId: 'op-12345678', ageMs: 20 * MIN })]) {
      expect(text).not.toContain('did not reach you');
      expect(text).not.toMatch(/send it again if it is still needed/i);
    }
  });
});

describe('the late first line (native-conversation-base §3a item 2)', () => {
  it('is null at or under 300 s and present above it', () => {
    expect(lateRecoveredReplyNotice(0, 299_999)).toBeNull();
    expect(lateRecoveredReplyNotice(0, 300_000)).toBeNull();
    expect(lateRecoveredReplyNotice(0, 300_001)).toBe('Late reply, written more than 5 minutes ago and held up in delivery. It answers an earlier message:');
  });
  it('counts hours above 90 minutes and floors so "more than" stays true', () => {
    expect(lateRecoveredReplyNotice(0, 90 * MIN)).toContain('more than 90 minutes ago');
    expect(lateRecoveredReplyNotice(0, 91 * MIN)).toContain('more than 1 hour ago');
    expect(lateRecoveredReplyNotice(0, 179 * MIN)).toContain('more than 2 hours ago');
  });
  it('marked at 6 minutes and accepted at 3 hours, the sealed line is still true', () => {
    const sealed = lateRecoveredReplyNotice(0, 6 * MIN)!;
    expect(sealed).toContain('more than 6 minutes ago');
    // Accepted three hours after drafting: "more than 6 minutes" remains a true statement.
    expect(3 * 60 * MIN).toBeGreaterThan(6 * MIN);
  });
  it('escapes MarkdownV2 reserved characters and leaves other modes as written', () => {
    const line = lateRecoveredReplyNotice(0, 6 * MIN)!;
    expect(lateLineForParseMode(line, 'MarkdownV2')).toContain('delivery\\. It answers an earlier message:');
    expect(lateLineForParseMode(line, 'HTML')).toBe(line);
    expect(lateLineForParseMode(line, undefined)).toBe(line);
  });
});

describe('session lines (native-conversation-base §3a items 5, 7, 8)', () => {
  it('the late line says whether the first line was added', () => {
    expect(lateDeliverySessionLine({ operationId: 'op-1', deliveredAfterMs: 12 * MIN, marked: true }))
      .toBe('Your reply `op-1` was delivered 12 minutes after you wrote it. It carries a first line telling the user it is late. Follow up here if it is no longer right.');
    expect(lateDeliverySessionLine({ operationId: 'op-1', deliveredAfterMs: 12 * MIN, marked: false }))
      .toBe('Your reply `op-1` was delivered 12 minutes after you wrote it. No late notice could be added, so the user has no sign that it is late. Follow up here if it is no longer right.');
  });
  it('one line per pass lists every id, marked first', () => {
    const batch = lateDeliverySessionBatch([
      { operationId: 'unmarked-1', deliveredAfterMs: 7 * MIN, marked: false },
      { operationId: 'marked-1', deliveredAfterMs: 9 * MIN, marked: true },
    ])!;
    expect(batch.indexOf('marked-1')).toBeLessThan(batch.indexOf('unmarked-1'));
    expect(batch).toContain('No late notice could be added');
    expect(lateDeliverySessionBatch([])).toBeNull();
  });
  it('the definite line names one of three fixed causes and points at the text route', () => {
    expect(failureCausePhrase('refused')).toBe('Telegram refused it');
    expect(failureCausePhrase('never-left')).toBe('it could not be sent before its attempts ran out');
    expect(failureCausePhrase('deadline')).toBe('it passed its delivery deadline');
    expect(definiteSessionLine({ operationId: 'op-abcdefgh', ageMs: 2 * 60 * MIN, cause: 'deadline' }))
      .toBe('Your reply `op-abcdefgh`, written 2 hours ago, was not delivered (it passed its delivery deadline) and will not be retried. Its text is at `GET /telegram/origins/operations/op-abcdefgh/text`. Send it again if it is still needed.');
  });
  it('the uncertain line never invites a resend', () => {
    expect(uncertainSessionLine({ operationId: 'op-abcdefgh', ageMs: 4 * 60 * MIN }))
      .toBe('Delivery of your reply `op-abcdefgh`, written 4 hours ago, could not be confirmed. It may have arrived. Do not send it again unless the user says it is missing.');
  });
  it('the reasonless-ending line asks the session to check before repeating', () => {
    expect(ownerUnstatedSessionLine('op-abcdefgh')).toBe('Reply `op-abcdefgh` was ended by the machine that sends to Telegram, which runs an older version and gave no reason. The user may already have this text. Check the conversation before repeating it.');
  });
  it('ages read in minutes up to 90 and hours above', () => {
    expect(replyAge(1 * MIN)).toBe('1 minute');
    expect(replyAge(90 * MIN)).toBe('90 minutes');
    expect(replyAge(2 * 60 * MIN + 59 * MIN)).toBe('2 hours');
  });
});
