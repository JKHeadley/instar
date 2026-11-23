import { describe, expect, it } from 'vitest';
import { conversationPreferenceIdentity } from '../../src/server/conversationPreferenceIdentity.js';
import { ISSUES_TOPIC_OFFSET } from '../../src/messaging/telegramTopicSpace.js';

describe('preference Telegram wire identity', () => {
  const view = () => conversationPreferenceIdentity({ machineId: 'local', registryVersion: '1', telegram: { mainChatId: '-1001', issuesChatId: '-1002' }, topicIds: new Set([42, ISSUES_TOPIC_OFFSET + 42]), slackIds: new Set(), appExists: () => false });
  it('keeps equal physical topic numbers in different forums distinct', () => {
    expect(view().resolve('telegram:-1001:42')).toEqual({ ref: 'telegram:-1001:42', accessRef: 'telegram:42' });
    expect(view().resolve('telegram:-1002:42')).toEqual({ ref: 'telegram:-1002:42', accessRef: `telegram:${ISSUES_TOPIC_OFFSET + 42}` });
  });
  it('rejects internal offsets masquerading as physical wire topics', () => {
    expect(view().resolve(`telegram:-1001:${ISSUES_TOPIC_OFFSET + 42}`)).toBeNull();
    expect(view().resolve(`telegram:-1002:${ISSUES_TOPIC_OFFSET + 42}`)).toBeNull();
  });
  it('resolves local display aliases but never guesses a foreign bare alias', () => {
    expect(view().resolve(`telegram:${ISSUES_TOPIC_OFFSET + 42}`)).toEqual({ ref: 'telegram:-1002:42', accessRef: `telegram:${ISSUES_TOPIC_OFFSET + 42}` });
    expect(view().resolve('telegram:42', { machine: 'foreign' } as never)).toBeNull();
    expect(view().resolve('telegram:-999:42')).toBeNull();
    expect(view().resolve('telegram:-1001:43')).toBeNull();
  });
});
