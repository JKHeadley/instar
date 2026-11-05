import { describe, expect, it } from 'vitest';
import { answeredSince, buildKeyRecoveryPrompt, deliverOperatorNotice, heldMessages, operatorSlackIds, type ConversationLine, type OperatorNoticeRoutes } from '../../src/core/claudeKeyRecovery.js';
import { KEY_NOTICE_TEXTS, PERSON_TEXT, PERSON_TOLD_SUFFIX } from '../../src/core/ClaudeKeyHealth.js';

const person = (at: number, text: string, who = 'U_DAWN'): ConversationLine => ({ at, fromAgent: false, who, text });
const agent = (at: number, text: string): ConversationLine => ({ at, fromAgent: true, who: 'bot', text });

describe('held messages', () => {
  it('are the messages after the agent last really replied', () => {
    const lines = [person(1, 'old question'), agent(2, 'old answer'), person(3, 'ECHO-ONE'), person(4, 'ECHO-TWO')];
    expect(heldMessages(lines, KEY_NOTICE_TEXTS).map((m) => m.text)).toEqual(['ECHO-ONE', 'ECHO-TWO']);
  });

  it("the server's key notice is not a reply, so what came before it is still held", () => {
    const lines = [agent(1, 'old answer'), person(2, 'ECHO-ONE'), agent(3, `${PERSON_TEXT}${PERSON_TOLD_SUFFIX}`), person(4, 'ECHO-TWO')];
    expect(heldMessages(lines, KEY_NOTICE_TEXTS).map((m) => m.text)).toEqual(['ECHO-ONE', 'ECHO-TWO']);
  });

  it('a bare channel id from the agent is not a reply (the drill fault)', () => {
    const lines = [person(1, 'ECHO-ONE'), agent(2, 'C0AQ9NS0E9W')];
    expect(heldMessages(lines, KEY_NOTICE_TEXTS).map((m) => m.text)).toEqual(['ECHO-ONE']);
  });

  it('nothing is held once the agent answered', () => {
    expect(heldMessages([person(1, 'q'), agent(2, 'a')], KEY_NOTICE_TEXTS)).toEqual([]);
  });
});

describe('answered since', () => {
  it('true only for a real reply at or after the restart', () => {
    expect(answeredSince([agent(5, 'Here is ECHO-ONE answered')], 5, KEY_NOTICE_TEXTS)).toBe(true);
    expect(answeredSince([agent(4, 'earlier reply')], 5, KEY_NOTICE_TEXTS)).toBe(false);
  });

  it('a notice, a channel id or a person does not count', () => {
    expect(answeredSince([agent(6, PERSON_TEXT), agent(7, ' C0AQ9NS0E9W '), person(8, 'hello?')], 5, KEY_NOTICE_TEXTS)).toBe(false);
  });

  it('a back-notice passed in as fixed text does not count', () => {
    const back = "I've restarted my session for this conversation and I'm ready.";
    expect(answeredSince([agent(6, back)], 5, [...KEY_NOTICE_TEXTS, back])).toBe(false);
  });
});

describe('the recovery prompt', () => {
  const held = [{ who: 'U_DAWN', text: 'ECHO-ONE', at: 0 }, { who: 'U_DAWN', text: 'ECHO-TWO', at: 1000 }];

  it('Slack: tagged, quotes every held message, and gives the bound reply command with no channel id', () => {
    const p = buildKeyRecoveryPrompt({ platform: 'slack', channelId: 'C0AQ9NS0E9W' }, held);
    expect(p.startsWith('[slack:C0AQ9NS0E9W] ')).toBe(true);
    expect(p).toContain('ECHO-ONE');
    expect(p).toContain('ECHO-TWO');
    expect(p).toContain("cat <<'EOF' | .instar/scripts/slack-reply.sh\n");
    expect(p).not.toMatch(/slack-reply\.sh C/);
  });

  it('Telegram: no tag (the respawn adds it), reply command names the topic', () => {
    const p = buildKeyRecoveryPrompt({ platform: 'telegram', topicId: 137 }, held);
    expect(p.startsWith('[telegram')).toBe(false);
    expect(p).toContain('.instar/scripts/telegram-reply.sh 137');
    expect(p).toContain('ECHO-TWO');
  });

  it('with nothing held it says to send nothing, still with the reply command', () => {
    const p = buildKeyRecoveryPrompt({ platform: 'slack', channelId: 'C1234567' }, []);
    expect(p).toContain('send nothing');
    expect(p).toContain('slack-reply.sh');
  });

  it('caps a long backlog and says so', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ who: 'U', text: `m${i}`, at: i }));
    const p = buildKeyRecoveryPrompt({ platform: 'slack', channelId: 'C1234567' }, many);
    expect(p).toContain('20 of 30');
    expect(p).toContain('m29');
    expect(p).not.toContain('- 1970-01-01T00:00:00.000Z U: m0\n');
  });
});

function slackRoutes(readers: string[] | Error, opts: { dmFails?: string[]; postFails?: boolean } = {}) {
  const log = { posts: [] as string[], dms: [] as string[] };
  const routes: NonNullable<OperatorNoticeRoutes['slack']> = {
    attentionChannel: 'C_ALERTS',
    readersOf: async () => { if (readers instanceof Error) throw readers; return readers; },
    post: async (c) => { if (opts.postFails) throw new Error('post failed'); log.posts.push(c); },
    people: () => ['U_JUSTIN', 'U_DAWN'],
    directMessage: async (u) => { if (opts.dmFails?.includes(u)) throw new Error('dm failed'); log.dms.push(u); },
  };
  return { routes, log };
}

describe('the operator notice reaches a person', () => {
  it('an alert channel with one of the agent\'s people in it counts, and nobody is messaged directly', async () => {
    const { routes, log } = slackRoutes(['U_DAWN']);
    expect(await deliverOperatorNotice({ slack: routes }, 'x')).toBe(true);
    expect(log.posts).toEqual(['C_ALERTS']);
    expect(log.dms).toEqual([]);
  });

  it('an alert channel nobody is in is not "told": each operator gets a direct message instead (the drill fault)', async () => {
    const { routes, log } = slackRoutes([]);
    expect(await deliverOperatorNotice({ slack: routes }, 'x')).toBe(true);
    expect(log.posts).toEqual([]); // a post there reaches nobody, and retries would repeat it
    expect(log.dms).toEqual(['U_JUSTIN', 'U_DAWN']);
  });

  it('retries after every message failed do not pile posts into the empty channel', async () => {
    const { routes, log } = slackRoutes([], { dmFails: ['U_JUSTIN', 'U_DAWN'] });
    for (let i = 0; i < 5; i++) expect(await deliverOperatorNotice({ slack: routes }, 'x')).toBe(false);
    expect(log.posts).toEqual([]);
  });

  it('members unreadable: the channel still gets it and direct messages go', async () => {
    const { routes, log } = slackRoutes(new Error('missing_scope'));
    expect(await deliverOperatorNotice({ slack: routes }, 'x')).toBe(true);
    expect(log.posts).toEqual(['C_ALERTS']);
    expect(log.dms).toEqual(['U_JUSTIN', 'U_DAWN']);
  });

  it('nobody reachable is false, so the retry and its report run', async () => {
    const { routes } = slackRoutes([], { dmFails: ['U_JUSTIN', 'U_DAWN'] });
    expect(await deliverOperatorNotice({ slack: routes }, 'x')).toBe(false);
  });

  it('one person reached is enough', async () => {
    const { routes, log } = slackRoutes([], { dmFails: ['U_JUSTIN'] });
    expect(await deliverOperatorNotice({ slack: routes }, 'x')).toBe(true);
    expect(log.dms).toEqual(['U_DAWN']);
  });

  it('Telegram delivered: no direct messages on Slack', async () => {
    const { routes, log } = slackRoutes([]);
    const sent: string[] = [];
    expect(await deliverOperatorNotice({ telegram: async (t) => { sent.push(t); }, slack: routes }, 'x')).toBe(true);
    expect(sent).toEqual(['x']);
    expect(log.dms).toEqual([]);
  });

  it('Telegram failing and no Slack is false', async () => {
    expect(await deliverOperatorNotice({ telegram: async () => { throw new Error('down'); } }, 'x')).toBe(false);
  });
});

describe('who the operator is on Slack', () => {
  it('the owners and admins among the authorized people', () => {
    expect(operatorSlackIds(['U_J', 'U_D', 'U_X'], [{ slackUserId: 'U_J', role: 'owner' }, { slackUserId: 'U_D', role: 'member' }])).toEqual(['U_J']);
  });

  it('no ranked profile: a small authorized list stands in', () => {
    expect(operatorSlackIds(['U_J', 'U_D'], [])).toEqual(['U_J', 'U_D']);
  });

  it('no ranked profile and a team-sized list: nobody, rather than a mass message', () => {
    expect(operatorSlackIds(['A1', 'A2', 'A3', 'A4'], [])).toEqual([]);
  });

  it('an owner profile that is not authorized on Slack does not count', () => {
    expect(operatorSlackIds(['U_D'], [{ slackUserId: 'U_J', role: 'owner' }])).toEqual(['U_D']);
  });
});

describe('what counts as a bare channel id', () => {
  it('real ids are caught, ordinary capitalised words are not', () => {
    expect(answeredSince([agent(6, 'C0AQ9NS0E9W')], 5, KEY_NOTICE_TEXTS)).toBe(false);
    expect(answeredSince([agent(6, 'CONFIRMED')], 5, KEY_NOTICE_TEXTS)).toBe(true);
    expect(answeredSince([agent(6, 'DEPLOYED')], 5, KEY_NOTICE_TEXTS)).toBe(true);
  });
});
