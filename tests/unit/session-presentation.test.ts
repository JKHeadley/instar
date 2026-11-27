import { describe, it, expect } from 'vitest';
import { createSessionPresentationResolver } from '../../src/server/sessionPresentation.js';

describe('durable session presentation', () => {
  it('reads a Telegram title by retained topic id even after its reverse binding changed', () => {
    const resolve = createSessionPresentationResolver({
      telegramRegistry: { topicToSession: { 42: 'replacement' }, topicToName: { 42: 'Fix session names' } },
    });
    expect(resolve({ name: 'echo-topic-42', tmuxSession: 'old', telegramTopicId: 42 }))
      .toEqual({ name: 'Fix session names', platform: 'telegram', platformId: 42, platformName: 'Fix session names' });
  });
  it('retains the session conversation identity when an adapter reverse cache points elsewhere', () => {
    const resolve = createSessionPresentationResolver({
      telegram: { getTopicForSession: () => 43, getTopicName: id => id === 43 ? 'Wrong conversation' : null },
      telegramRegistry: { topicToName: { 42: 'Right conversation' } },
    });
    expect(resolve({ name: 'echo-topic-42', tmuxSession: 'reused', telegramTopicId: 42 }))
      .toMatchObject({ name: 'Right conversation', platformId: 42 });
  });
  it('uses durable bindings registered after the adapter booted', () => {
    const resolve = createSessionPresentationResolver({
      telegramRegistry: { topicToSession: { 42: 'new' }, topicToName: { 42: 'New conversation' } },
    });
    expect(resolve({ name: 'echo-topic-42', tmuxSession: 'new' }).name).toBe('New conversation');
  });
  it('uses topic metadata when the adapter and topic-name map are unavailable', () => {
    const resolve = createSessionPresentationResolver({ topicMemory: { getTopicMeta: () => ({ topicName: 'Remembered title' }) } });
    expect(resolve({ name: 'echo-topic-42', tmuxSession: 'old', telegramTopicId: 42 }).name).toBe('Remembered title');
  });
  it('resolves an app alias to the app store, including a rename', () => {
    let title = 'Build the app';
    const resolve = createSessionPresentationResolver({
      conversationRegistry: { resolve: () => ({ platform: 'app', conversationKey: 'app:key' }) },
      appConversations: { store: { getConversation: () => ({ title }) } },
    });
    const s = { name: 'echo-topic--42', tmuxSession: 's', telegramTopicId: -42 };
    expect(resolve(s)).toMatchObject({ platform: 'app', name: title });
    title = 'Renamed app conversation';
    expect(resolve(s).name).toBe(title);
  });
  it('resolves the numeric app channel binding when the legacy session has no retained alias', () => {
    const resolve = createSessionPresentationResolver({
      conversationRegistry: { resolve: id => id === -42 ? { platform: 'app', conversationKey: 'app:key' } : null },
      appConversations: { channels: { getChannelForSession: () => '-42' }, store: { getConversation: key => key === 'app:key' ? { title: 'Known app title' } : null } },
    });
    expect(resolve({ name: 'topic--42', tmuxSession: 's' })).toMatchObject({ platform: 'app', name: 'Known app title', platformId: 'app:key' });
  });
  it('keeps the list readable when an adapter throws and another durable source has the title', () => {
    const resolve = createSessionPresentationResolver({
      telegram: { getTopicForSession: () => { throw new Error('cache unavailable'); } },
      telegramRegistry: { topicToName: { 42: 'Durable title' } },
    });
    expect(resolve({ name: 'echo-topic-42', tmuxSession: 's', telegramTopicId: 42 }).name).toBe('Durable title');
  });
  it('resolves a Slack alias from its durable conversation label without a live reverse binding', () => {
    const resolve = createSessionPresentationResolver({
      conversationRegistry: { resolve: () => ({ platform: 'slack', channelId: 'C123456789', threadTs: '123.456', label: 'Release discussion' }) },
    });
    expect(resolve({ name: 'topic--99', tmuxSession: 's', telegramTopicId: -99 }))
      .toMatchObject({ platform: 'slack', name: 'Release discussion', platformId: 'C123456789:123.456' });
  });
  it('uses the parent Slack channel title for a thread registry with no thread title', () => {
    const resolve = createSessionPresentationResolver({ slack: {
      getChannelForSession: () => 'C123456789:123.456',
      getChannelRegistry: () => ({ C123456789: { channelName: 'Engineering' } }),
    } });
    expect(resolve({ name: 'slack-thread', tmuxSession: 's' }).name).toBe('Engineering');
  });
  it('uses the job definition name rather than the generated run name', () => {
    const resolve = createSessionPresentationResolver({ scheduler: { getJobs: () => [{ slug: 'health', name: 'Health check' }] } });
    expect(resolve({ name: 'job-health-123', tmuxSession: 's', jobSlug: 'health' }).name).toBe('Health check');
  });
  it('preserves a known session title when only the adapter cache is absent', () => {
    const resolve = createSessionPresentationResolver({});
    expect(resolve({ name: 'Instar App', tmuxSession: 's', telegramTopicId: 134088 }).name).toBe('Instar App');
  });
  it('does not invent a title or expose a routing key for a genuinely unknown conversation', () => {
    const resolve = createSessionPresentationResolver({});
    expect(resolve({ name: 'echo-topic-42', tmuxSession: 's', telegramTopicId: 42 }).name).toBe('Conversation name unavailable');
    expect(resolve({ name: 'echo-topic--42', tmuxSession: 's', telegramTopicId: -42 }).platform).toBe('headless');
  });
});
