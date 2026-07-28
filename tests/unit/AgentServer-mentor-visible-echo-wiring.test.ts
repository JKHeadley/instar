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
  it('runs the echo only after canonical inbox acceptance and has no Telegram delivery fallback', () => {
    const src = fs.readFileSync(new URL('../../src/server/AgentServer.ts', import.meta.url), 'utf8');
    const localSuccess = src.indexOf('if (result.agentMessage === true)');
    const echo = src.indexOf('void sendMentorVisibleEcho(opts.body, opts.visibleEcho)');
    const noAuthority = src.indexOf('// Telegram bot-to-bot sends are never a delivery authority');
    expect(localSuccess).toBeGreaterThan(-1);
    expect(echo).toBeGreaterThan(localSuccess);
    expect(echo).toBeLessThan(noAuthority);
    expect(src.slice(noAuthority, noAuthority + 500)).not.toContain('sendMentorVisibleEcho');
    expect(src).not.toContain('Legacy Telegram fallback');
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

  it('counts mesh delivery only after inbox acceptance and mirrors only after acceptance', async () => {
    listAgents.mockReturnValue([]);
    const appendSent = vi.fn();
    const server = Object.create(AgentServer.prototype) as AgentServer & Record<string, unknown>;
    server.config = { projectName: 'echo' } as never;
    server.getOrCreateA2aLedger = () => ({ appendSent }) as never;
    const meshDeliver = vi.fn(async () => ({ ok: true, agentMessage: true }));
    server.deliverA2aToMachine = meshDeliver;
    const visibleSend = vi.fn(async () => ({ messageId: 7 }));

    const delivered = await (server as any).deliverA2aMessage({
      fromAgent: 'echo', toAgent: 'instar-codey', targetMachineId: 'mini',
      role: 'mentor', corr: 'mesh-1', body: 'real prompt', allowedRoles: new Set(['mentor']),
      telegramTopicId: 458, fromBotId: 'mentor-bot',
      visibleEcho: { enabled: true, topicId: 458, roleTag: '[mentor]', bot: { sendToTopic: visibleSend } },
    });

    expect(delivered).toBe(true);
    expect(meshDeliver).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'mini', targetAgent: 'instar-codey', senderBotId: 'mentor-bot' }));
    expect(appendSent).toHaveBeenCalledWith(expect.objectContaining({ result: 'sent', transport: 'a2a-inbox-mesh' }));
    await vi.waitFor(() => expect(visibleSend).toHaveBeenCalledTimes(1));
  });

  it('does not count a Telegram mirror as delivery when the mesh inbox refuses', async () => {
    listAgents.mockReturnValue([]);
    const appendSent = vi.fn();
    const server = Object.create(AgentServer.prototype) as AgentServer & Record<string, unknown>;
    server.config = { projectName: 'echo' } as never;
    server.getOrCreateA2aLedger = () => ({ appendSent }) as never;
    server.deliverA2aToMachine = vi.fn(async () => ({ ok: false, agentMessage: false, reason: 'not-routed' }));
    const mirror = vi.fn(async () => ({ messageId: 8 }));
    const legacyFallback = vi.fn(async () => ({ messageId: 9 }));

    const delivered = await (server as any).deliverA2aMessage({
      fromAgent: 'echo', toAgent: 'instar-codey', targetMachineId: 'mini',
      role: 'mentor', corr: 'mesh-2', body: 'prompt', allowedRoles: new Set(['mentor']),
      telegramTopicId: 458, fromBotId: 'mentor-bot', toBotId: 'mentee-bot', botToken: '1:x',
      telegramBot: { sendToTopic: legacyFallback },
      visibleEcho: { enabled: true, topicId: 458, roleTag: '[mentor]', bot: { sendToTopic: mirror } },
    });

    expect(delivered).toBe(false);
    expect(appendSent).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
    expect(legacyFallback).not.toHaveBeenCalled();
  });
});
