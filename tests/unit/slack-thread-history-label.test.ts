import { describe, it, expect } from 'vitest';
import { slackHistoryLabel } from '../../src/messaging/slack/threadHistoryLabel.js';

const BOT = 'U0BOT';
const ECHO = 'U0ECHO';
const DAWN = 'U0DAWN';

describe('slackHistoryLabel (each history line carries its own sender)', () => {
  it('labels the bot as Agent', () => {
    expect(slackHistoryLabel({ user: BOT }, BOT, { userId: DAWN, name: 'Dawn' })).toBe('Agent');
  });

  it("does NOT give another person's line the current sender's name (the shared-thread bug)", () => {
    // Dawn is replying; Echo wrote the earlier line.
    expect(slackHistoryLabel({ user: ECHO }, BOT, { userId: DAWN, name: 'Dawn' })).toBe(ECHO);
  });

  it("keeps the current sender's display name on their own lines (one-person conversations read as before)", () => {
    expect(slackHistoryLabel({ user: DAWN }, BOT, { userId: DAWN, name: 'Dawn' })).toBe('Dawn');
  });

  it('falls back to the user id when the current sender has no name or id', () => {
    expect(slackHistoryLabel({ user: DAWN }, BOT, { userId: DAWN, name: '' })).toBe(DAWN);
    expect(slackHistoryLabel({ user: ECHO }, BOT, {})).toBe(ECHO);
  });

  it('says unknown for a line with no user (never borrows a name)', () => {
    expect(slackHistoryLabel({}, BOT, { userId: DAWN, name: 'Dawn' })).toBe('unknown');
    expect(slackHistoryLabel({ user: null }, null, { userId: DAWN, name: 'Dawn' })).toBe('unknown');
  });

  it('a three-person thread keeps every line distinct', () => {
    const cur = { userId: DAWN, name: 'Dawn' };
    const lines = [ECHO, BOT, DAWN, 'U0THIRD'].map((u) => slackHistoryLabel({ user: u }, BOT, cur));
    expect(lines).toEqual([ECHO, 'Agent', 'Dawn', 'U0THIRD']);
  });

  it('uses the resolved name of another participant when available', () => {
    expect(slackHistoryLabel({ user: ECHO }, BOT, { userId: DAWN, name: 'Dawn' }, new Map([[ECHO, 'Indra']]))).toBe('Indra');
  });
});
