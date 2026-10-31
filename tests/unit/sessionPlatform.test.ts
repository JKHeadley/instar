import { describe, it, expect } from 'vitest';
import { resolveSessionPlatform, sessionDisplayName } from '../../src/server/sessionPlatform.js';

const telegram = (map: Record<string, number>, names: Record<number, string> = {}) => ({
  getTopicForSession: (t: string) => map[t] ?? null,
  getTopicName: (id: number) => names[id] ?? null,
});

describe('sessionDisplayName', () => {
  it('uses a verified title and never a project-prefixed Telegram routing name', () => {
    expect(sessionDisplayName('echo-topic-127504', { platform: 'telegram', platformId: 127504, platformName: 'Instar dashboard makeover' }))
      .toBe('Instar dashboard makeover');
    expect(sessionDisplayName('echo-topic-127504', { platform: 'telegram', platformId: 127504 }))
      .toBe('Conversation name unavailable');
  });

  it('keeps ordinary sessions and masks an unbound topic routing name', () => {
    expect(sessionDisplayName('health-check', { platform: 'headless' })).toBe('health-check');
    expect(sessionDisplayName('echo-topic-127504', { platform: 'headless' })).toBe('Conversation name unavailable');
  });
});
const slack = (map: Record<string, string>, names: Record<string, string> = {}) => ({
  getChannelForSession: (t: string) => map[t] ?? null,
  getChannelRegistry: () => Object.fromEntries(Object.entries(names).map(([k, v]) => [k, { channelName: v }])),
});

describe('resolveSessionPlatform', () => {
  it('reports a topic-bound session as telegram with its topic id and name', () => {
    expect(resolveSessionPlatform('echo-door', telegram({ 'echo-door': 112490 }, { 112490: 'door model selection' }), null))
      .toEqual({ platform: 'telegram', platformId: 112490, platformName: 'door model selection' });
  });

  it('omits a placeholder topic-<n> name', () => {
    expect(resolveSessionPlatform('s', telegram({ s: 128128 }, { 128128: 'topic-128128' }), null))
      .toEqual({ platform: 'telegram', platformId: 128128 });
  });

  it('falls through to slack when telegram has no topic for the session', () => {
    expect(resolveSessionPlatform('s', telegram({}), slack({ s: 'C1' }, { C1: 'general' })))
      .toEqual({ platform: 'slack', platformId: 'C1', platformName: 'general' });
  });

  it('does not advertise a Slack ID as a channel name', () => {
    expect(resolveSessionPlatform('s', null, slack({ s: 'C123' }, { C123: 'C123' })))
      .toEqual({ platform: 'slack', platformId: 'C123' });
  });

  it('reports headless when no adapter binds the session', () => {
    expect(resolveSessionPlatform('train-109', telegram({}), slack({}))).toEqual({ platform: 'headless' });
    expect(resolveSessionPlatform('train-109', null, null)).toEqual({ platform: 'headless' });
  });
});

describe('wiring: both session surfaces share the one derivation', () => {
  const read = (rel: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, '../../', rel), 'utf-8');

  it('AgentServer hands the WebSocket manager a resolver backed by the real adapters', () => {
    const src = read('src/server/AgentServer.ts');
    expect(src).toContain('resolveSessionPlatform(tmuxSession, this.telegramAdapter, this.slackAdapter)');
    expect(src).toContain('this.slackAdapter = options.slack ?? null;');
  });

  it('GET /sessions uses the same helper', () => {
    expect(read('src/server/routes.ts')).toContain('resolveSessionPlatform(s.tmuxSession, ctx.telegram, ctx.slack)');
  });
});
