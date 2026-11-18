import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { isOwnersOwnWords } from '../../src/core/ownerWords.js';

// SEC-069: a team member's words, and forwarded text, never become the owner's learned preferences.
describe('isOwnersOwnWords', () => {
  const OWNER = 111;
  it('the owner\'s own message counts', () => {
    expect(isOwnersOwnWords({ fromUser: true, telegramUserId: OWNER, forwarded: false }, OWNER)).toBe(true);
    expect(isOwnersOwnWords({ fromUser: true, senderRole: 'owner', via: 'mobile-device' }, OWNER)).toBe(true);
    expect(isOwnersOwnWords({ fromUser: true, via: 'mobile-device' }, OWNER)).toBe(true); // owner phone paired before roles
    expect(isOwnersOwnWords({ fromUser: true, telegramUserId: 5 })).toBe(true); // no owner configured: a verified sender is enough
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
    expect(src).toContain('const ownersWords = isOwnersOwnWords(entry, telegram?.getVerifiedOwner());');
    expect(src).toContain('fromUser: ownersWords,');
    expect(src).toContain('correctionShadow.observe(entry, telegram.getVerifiedOwner());');
  });
});
