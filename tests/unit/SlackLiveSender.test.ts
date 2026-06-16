import { describe, it, expect, vi } from 'vitest';
import { SlackLiveSender, type SlackCaller } from '../../src/core/SlackLiveSender.js';

const AGENT = 'UECHOBOT';
const noSleep = async () => {};

function caller(handlers: Partial<Record<string, (params: any) => any>>): SlackCaller {
  return {
    call: vi.fn(async (method: string, params: any = {}) => {
      const h = handlers[method];
      if (!h) throw new Error(`unexpected call ${method}`);
      return h(params);
    }),
  };
}

describe('SlackLiveSender', () => {
  it('send posts via chat.postMessage and returns the ts as messageId', async () => {
    const api = caller({ 'chat.postMessage': () => ({ ok: true, ts: '111.222' }) });
    const s = new SlackLiveSender({ api, agentBotUserId: AGENT, sleep: noSleep });
    const res = await s.send('C1', 'hello');
    expect(res.messageId).toBe('111.222');
    expect(api.call).toHaveBeenCalledWith('chat.postMessage', { channel: 'C1', text: 'hello' });
  });

  it('send throws (never fabricates a messageId) when no ts is returned', async () => {
    const api = caller({ 'chat.postMessage': () => ({ ok: false }) });
    const s = new SlackLiveSender({ api, agentBotUserId: AGENT, sleep: noSleep });
    await expect(s.send('C1', 'x')).rejects.toThrow(/no ts/);
  });

  it('awaitReply returns the AGENT reply after the sent ts (ignores the sender own message + earlier msgs)', async () => {
    const api = caller({
      'conversations.history': () => ({
        ok: true,
        messages: [
          { ts: '300.0', user: AGENT, text: 'the agent reply' },   // newest-first ordering from Slack
          { ts: '200.0', user: 'UMIA', text: 'the prompt' },        // the sender's own message
          { ts: '100.0', user: AGENT, text: 'an OLD agent message' },
        ],
      }),
    });
    const s = new SlackLiveSender({ api, agentBotUserId: AGENT, sleep: noSleep });
    const reply = await s.awaitReply('C1', { timeoutMs: 1000, afterMessageId: '200.0' });
    expect(reply).not.toBeNull();
    expect(reply!.text).toBe('the agent reply');
    expect(reply!.messageId).toBe('300.0');
  });

  it('awaitReply ignores a non-agent message even if it is after the prompt', async () => {
    const api = caller({
      'conversations.history': () => ({
        messages: [{ ts: '250.0', user: 'USOMEONE', text: 'not the agent' }],
      }),
    });
    let nowVal = 0;
    const s = new SlackLiveSender({ api, agentBotUserId: AGENT, sleep: noSleep, pollIntervalMs: 1, now: () => (nowVal += 600) });
    const reply = await s.awaitReply('C1', { timeoutMs: 1000, afterMessageId: '200.0' });
    expect(reply).toBeNull();
  });

  it('awaitReply polls until the reply appears, then returns it', async () => {
    let calls = 0;
    const api = caller({
      'conversations.history': () => {
        calls++;
        if (calls < 3) return { messages: [{ ts: '200.0', user: 'UMIA', text: 'prompt' }] };
        return { messages: [{ ts: '400.0', user: AGENT, text: 'finally' }, { ts: '200.0', user: 'UMIA', text: 'prompt' }] };
      },
    });
    let nowVal = 0;
    const s = new SlackLiveSender({ api, agentBotUserId: AGENT, sleep: noSleep, pollIntervalMs: 1, now: () => (nowVal += 100) });
    const reply = await s.awaitReply('C1', { timeoutMs: 100000, afterMessageId: '200.0' });
    expect(reply!.text).toBe('finally');
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('awaitReply returns null on timeout (no agent reply ever)', async () => {
    const api = caller({ 'conversations.history': () => ({ messages: [] }) });
    let nowVal = 0;
    const s = new SlackLiveSender({ api, agentBotUserId: AGENT, sleep: noSleep, pollIntervalMs: 1, now: () => (nowVal += 600) });
    const reply = await s.awaitReply('C1', { timeoutMs: 1000, afterMessageId: '200.0' });
    expect(reply).toBeNull();
  });

  it('awaitReply with no afterMessageId still returns the agent message', async () => {
    const api = caller({ 'conversations.history': () => ({ messages: [{ ts: '10.0', user: AGENT, text: 'hi' }] }) });
    const s = new SlackLiveSender({ api, agentBotUserId: AGENT, sleep: noSleep });
    const reply = await s.awaitReply('C1', { timeoutMs: 1000 });
    expect(reply!.text).toBe('hi');
  });
});
