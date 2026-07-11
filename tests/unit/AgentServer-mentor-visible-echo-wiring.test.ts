import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { AgentServer } from '../../src/server/AgentServer.js';

const { listAgents, getAgentToken } = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getAgentToken: vi.fn(),
}));
vi.mock('../../src/core/AgentRegistry.js', () => ({ listAgents }));
vi.mock('../../src/messaging/AgentTokenManager.js', () => ({ getAgentToken }));

describe('AgentServer mentor visible-echo wiring', () => {
  it('runs the echo only inside successful inbox-local delivery, before fallback', () => {
    const src = fs.readFileSync(new URL('../../src/server/AgentServer.ts', import.meta.url), 'utf8');
    const localSuccess = src.indexOf('if (result.agentMessage === true)');
    const echo = src.indexOf('void sendMentorVisibleEcho(opts.body, opts.visibleEcho)');
    const fallback = src.indexOf('// ── Cross-machine Telegram fallback');
    expect(localSuccess).toBeGreaterThan(-1);
    expect(echo).toBeGreaterThan(localSuccess);
    expect(echo).toBeLessThan(fallback);
    expect(src.slice(fallback, fallback + 2000)).not.toContain('sendMentorVisibleEcho');
  });

  it('wires mentor prompts with default-on config, existing bot, and resolved topic', () => {
    const src = fs.readFileSync(new URL('../../src/server/AgentServer.ts', import.meta.url), 'utf8');
    expect(src).toContain('enabled: cfg.visibleEcho !== false');
    expect(src).toContain("roleTag: '[mentor]'");
    expect(src).toContain('topicId: resolveMentorDeliveryTopic(cfg)');
    expect(src).toContain("feature: 'mentor.visible-echo'");
  });

  it('returns canonical local success immediately when the visible bot never resolves, with no fallback post', async () => {
    listAgents.mockReturnValue([{ name: 'instar-codey', port: 4045 }]);
    getAgentToken.mockReturnValue('peer-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ agentMessage: true }),
    } as Response);
    const appendSent = vi.fn();
    const server = Object.create(AgentServer.prototype) as AgentServer & Record<string, unknown>;
    server.config = { projectName: 'echo' } as never;
    server.getOrCreateA2aLedger = () => ({ appendSent }) as never;
    const visibleSend = vi.fn(() => new Promise<never>(() => undefined));
    const fallbackSend = vi.fn(async () => ({ messageId: 99 }));

    const delivered = await Promise.race([
      (server as any).deliverA2aMessage({
        fromAgent: 'echo', toAgent: 'instar-codey', role: 'mentor', corr: 'c1', body: 'prompt',
        allowedRoles: new Set(['mentor']), telegramTopicId: 458, toBotId: '2', botToken: '1:x',
        telegramBot: { sendToTopic: fallbackSend },
        visibleEcho: { enabled: true, topicId: 458, roleTag: '[mentor]', bot: { sendToTopic: visibleSend } },
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(delivered).toBe(true);
    expect(appendSent).toHaveBeenCalledTimes(1);
    expect(appendSent.mock.calls[0][0]).toMatchObject({ result: 'sent', transport: 'a2a-inbox-local' });
    expect(visibleSend).toHaveBeenCalledTimes(1);
    expect(fallbackSend).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
