import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { isOwnersOwnWords, learningOwnerId } from '../../src/core/ownerWords.js';

// SEC-069: a team member's words, and forwarded text, never become the owner's learned preferences.
describe('isOwnersOwnWords', () => {
  const OWNER = 111;
  it('the owner\'s own message counts', () => {
    expect(isOwnersOwnWords({ fromUser: true, telegramUserId: OWNER, forwarded: false }, OWNER)).toBe(true);
    expect(isOwnersOwnWords({ fromUser: true, senderRole: 'owner', via: 'mobile-device' }, OWNER)).toBe(true);
    expect(isOwnersOwnWords({ fromUser: true, via: 'mobile-device' }, OWNER)).toBe(true); // owner phone paired before roles
  });
  it('SEC-105: with no owner known, nobody\'s Telegram words count', () => {
    expect(isOwnersOwnWords({ fromUser: true, telegramUserId: 5 })).toBe(false);
    expect(isOwnersOwnWords({ fromUser: true, telegramUserId: 222 }, undefined)).toBe(false);
  });
  it('SEC-105: learningOwnerId is the verified owner, else the one allowed sender, else nobody', () => {
    expect(learningOwnerId(111, [111, 222])).toBe(111);
    expect(learningOwnerId(undefined, [5])).toBe(5);
    expect(learningOwnerId(undefined, ['5'])).toBe(5);
    expect(learningOwnerId(undefined, [5, 6])).toBeUndefined();
    expect(learningOwnerId(undefined, [])).toBeUndefined();
    expect(learningOwnerId(undefined, undefined)).toBeUndefined();
    expect(learningOwnerId(undefined, ['abc'])).toBeUndefined();
    expect(learningOwnerId(undefined, [0])).toBeUndefined();
    expect(learningOwnerId(undefined, [-1001234])).toBeUndefined();
    expect(learningOwnerId(undefined, [' 5 '])).toBeUndefined(); // isAuthorized would not accept user 5 either
    expect(learningOwnerId(undefined, ['05'])).toBeUndefined();
    expect(learningOwnerId(undefined, [5, 5])).toBe(5);
    expect(learningOwnerId(undefined, [5, '5'])).toBe(5);
    // the single-person agent keeps learning from its one sender
    expect(isOwnersOwnWords({ fromUser: true, telegramUserId: 5 }, learningOwnerId(undefined, [5]))).toBe(true);
    expect(isOwnersOwnWords({ fromUser: true, telegramUserId: 222 }, learningOwnerId(undefined, [5, 222]))).toBe(false);
  });
  it('a team member, another person\'s phone, forwarded text and the agent\'s own messages do not', () => {
    expect(isOwnersOwnWords({ fromUser: true, teamPhone: true, telegramUserId: OWNER }, OWNER)).toBe(false);
    expect(isOwnersOwnWords({ fromUser: true, senderRole: 'team', via: 'mobile-device' }, OWNER)).toBe(false);
    expect(isOwnersOwnWords({ fromUser: true, senderRole: 'msp', via: 'mobile-device' }, OWNER)).toBe(false);
    expect(isOwnersOwnWords({ fromUser: true, forwarded: true, telegramUserId: OWNER }, OWNER)).toBe(false);
    expect(isOwnersOwnWords({ fromUser: false, telegramUserId: OWNER }, OWNER)).toBe(false);
    expect(isOwnersOwnWords({}, OWNER)).toBe(false);
  });
  it('another Telegram user in a shared topic, and an unverified sender, do not', () => {
    expect(isOwnersOwnWords({ fromUser: true, telegramUserId: 222 }, OWNER)).toBe(false);
    expect(isOwnersOwnWords({ fromUser: true }, OWNER)).toBe(false); // sender id cleared: unverified
    expect(isOwnersOwnWords({ fromUser: true })).toBe(false);
  });
});

describe('TelegramAdapter.getLearningOwner (SEC-105)', () => {
  const dirs: string[] = [];
  const make = (cfg: Record<string, unknown>) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-learning-owner-')); dirs.push(d);
    return new TelegramAdapter({ token: 'test-token', chatId: '-100123', pollIntervalMs: 100, ...cfg } as never, d);
  };
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test-cleanup' }); });
  it('the configured owner, else the one allowed sender, else nobody', () => {
    expect(make({ ownerUserId: 111, authorizedUserIds: [111, 222] }).getLearningOwner()).toBe(111);
    expect(make({ authorizedUserIds: [5] }).getLearningOwner()).toBe(5);
    expect(make({ authorizedUserIds: [5, 6] }).getLearningOwner()).toBeUndefined();
    expect(make({}).getLearningOwner()).toBeUndefined();
  });
  it('a second allowed sender added at runtime ends the single-sender fallback', () => {
    const ids = [5];
    const adapter = make({ authorizedUserIds: ids });
    expect(adapter.getLearningOwner()).toBe(5);
    ids.push(6);
    expect(adapter.getLearningOwner()).toBeUndefined();
  });
});

describe('TelegramAdapter.logInboundMessage keeps the team mark', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-team-words-'));
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100123', pollIntervalMs: 100 }, tmpDir);
  });
  afterEach(async () => {
    await adapter.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/team-words-not-learned.test.ts' });
  });
  const base = { topicId: 9, timestamp: new Date().toISOString(), text: 'No, always use the staging server' };

  it('a team member\'s forwarded Telegram message is logged with teamPhone and seen as not the owner\'s words', () => {
    const seen: Array<Record<string, unknown>> = [];
    adapter.onMessageLogged = (e) => { seen.push(e as never); };
    adapter.logInboundMessage({ ...base, messageId: 1, teamPhone: true, telegramUserId: 111 });
    expect(adapter.getTopicHistory(9, 10)[0].teamPhone).toBe(true);
    expect(isOwnersOwnWords(seen[0], 111)).toBe(false);
  });

  it('a team member\'s app message (sender role team) is logged with teamPhone too', () => {
    adapter.logInboundMessage({ ...base, messageId: 2, via: 'mobile-device', deviceId: 'd1', eventId: 'e1', senderRole: 'team' });
    expect(adapter.getTopicHistory(9, 10)[0].teamPhone).toBe(true);
  });

  it('the owner\'s message is unchanged (no team mark) and counts as the owner\'s words', () => {
    const seen: Array<Record<string, unknown>> = [];
    adapter.onMessageLogged = (e) => { seen.push(e as never); };
    adapter.logInboundMessage({ ...base, messageId: 3, telegramUserId: 111, forwarded: false });
    expect(adapter.getTopicHistory(9, 10)[0].teamPhone).toBeUndefined();
    expect(isOwnersOwnWords(seen[0], 111)).toBe(true);
  });

  it('wiring: the correction capture uses the shared rule', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf-8');
    expect(src).toContain('const ownersWords = isOwnersOwnWords(entry, telegram?.getLearningOwner());');
    expect(src).toContain('fromUser: ownersWords,');
    expect(src).toContain('correctionShadow.observe(entry, telegram.getLearningOwner());');
  });
});
