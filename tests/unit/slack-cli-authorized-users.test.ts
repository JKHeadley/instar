import { describe, it, expect } from 'vitest';
import {
  defaultAuthorizedUsers,
  parseMemberIds,
  generateSlackManifest,
  type SlackMemberSummary,
} from '../../src/commands/slack-cli.js';

const BOT = 'U0BOT0001';
const slackbot: SlackMemberSummary = { id: 'USLACKBOT', name: 'slackbot', is_bot: false };
const bot: SlackMemberSummary = { id: BOT, name: 'nimbus', is_bot: true };
const owner: SlackMemberSummary = { id: 'U0OWNER01', name: 'echo', real_name: 'Echo', is_primary_owner: true };
const member: SlackMemberSummary = { id: 'U0MEMBER1', name: 'sam' };
const gone: SlackMemberSummary = { id: 'U0GONE001', name: 'old', deleted: true };

describe('defaultAuthorizedUsers (who a new Slack agent listens to)', () => {
  it('never returns the bot itself, even when it is the only non-system member', () => {
    expect(defaultAuthorizedUsers([slackbot, bot], BOT)).toEqual([]);
  });

  it('picks the only real person in a fresh workspace (the live instar-proof-1 shape)', () => {
    expect(defaultAuthorizedUsers([slackbot, bot, { id: 'U0CER2ZL62Y', name: 'echo' }], BOT).map((m) => m.id))
      .toEqual(['U0CER2ZL62Y']);
  });

  it('picks the primary owner when several people are present', () => {
    expect(defaultAuthorizedUsers([slackbot, bot, member, owner], BOT).map((m) => m.id)).toEqual(['U0OWNER01']);
  });

  it('returns nobody when several people and no owner flag (the person must type an id)', () => {
    expect(defaultAuthorizedUsers([member, { id: 'U0OTHER01', name: 'kim' }], BOT)).toEqual([]);
  });

  it('skips deleted users and app users', () => {
    expect(defaultAuthorizedUsers([gone, { id: 'U0APP0001', is_app_user: true }, member], BOT).map((m) => m.id))
      .toEqual(['U0MEMBER1']);
  });

  it('works when the bot id is unknown', () => {
    expect(defaultAuthorizedUsers([bot, member], undefined).map((m) => m.id)).toEqual(['U0MEMBER1']);
  });
});

describe('parseMemberIds', () => {
  it('accepts comma- and space-separated U/W ids and removes duplicates', () => {
    expect(parseMemberIds('U0ABC123, W0XYZ987  U0ABC123')).toEqual(['U0ABC123', 'W0XYZ987']);
  });

  it('returns an empty list for empty input', () => {
    expect(parseMemberIds('   ')).toEqual([]);
  });

  it('refuses names, emails and lower-case ids', () => {
    expect(parseMemberIds('echo')).toBeNull();
    expect(parseMemberIds('echo@sagemindai.io')).toBeNull();
    expect(parseMemberIds('u0abc123')).toBeNull();
    expect(parseMemberIds('U0ABC123, sam')).toBeNull();
  });
});

describe('generateSlackManifest', () => {
  it('lets people DM the agent (Messages tab on, not read-only)', () => {
    const features = generateSlackManifest('nimbus').features as Record<string, Record<string, unknown>>;
    expect(features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
  });

  it('keeps the bot user and the message.im event', () => {
    const m = generateSlackManifest('nimbus') as Record<string, Record<string, Record<string, unknown>>>;
    expect(m.features.bot_user).toEqual({ display_name: 'nimbus', always_online: true });
    expect((m.settings.event_subscriptions.bot_events as string[])).toContain('message.im');
  });
});

describe('reportBotOnlyAuthorization (existing agents set up before the fix)', async () => {
  const { reportBotOnlyAuthorization } = await import('../../src/messaging/slack/SlackAdapter.js');
  it('fires when the bot is the only authorized user', () => {
    expect(reportBotOnlyAuthorization([BOT], BOT)).toBe(true);
  });
  it('stays quiet when a person is authorized, alone or beside the bot', () => {
    expect(reportBotOnlyAuthorization(['U0OWNER01'], BOT)).toBe(false);
    expect(reportBotOnlyAuthorization([BOT, 'U0OWNER01'], BOT)).toBe(false);
  });
  it('leaves the empty list to its existing fail-closed warning', () => {
    expect(reportBotOnlyAuthorization([], BOT)).toBe(false);
  });
});
