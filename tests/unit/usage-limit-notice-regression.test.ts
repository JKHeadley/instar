// safe-fs-allow: isolated fixture directory only.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { classifyStuckSignature } from '../../src/monitoring/StuckSignatureClassifier.js';
import { PresenceProxy, detectQuotaExhaustion } from '../../src/monitoring/PresenceProxy.js';

const wall = "You've hit your weekly limit · resets 11am\n❯";
const dirs: string[] = [];
const proxies: PresenceProxy[] = [];
afterEach(() => { proxies.forEach(p => p.stop()); dirs.splice(0).forEach(d => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'usage-limit-test:cleanup' })); });
function setup(extra: Record<string, unknown> = {}, dir?: string) {
  const stateDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'limit-regression-'));
  if (!dir) dirs.push(stateDir);
  const sendMessage = vi.fn(async () => {});
  const proxy = new PresenceProxy({ stateDir, intelligence: null, agentName: 'Echo', getSessionForTopic: () => 'parent',
    isSessionAlive: () => true, captureSessionOutput: () => wall, getProcessTree: () => [],
    getAuthorizedUserIds: () => [], sendMessage, confirmSessionUsageLimit: () => true, ...extra } as any);
  proxy.start(); proxies.push(proxy);
  return { proxy: proxy as any, sendMessage, stateDir };
}
function inbound(proxy: any) { proxy.onMessageLogged({ channelId: '123', fromUser: true, text: 'continue' }); return proxy.states.get(123); }

describe('usage-limit ownership and current state', () => {
  it.each([
    "⏺ Agent(builder)\n  ⎿ Error: You've hit your weekly limit · resets 11am\n⏺ Resuming the builders\n✻ Working (8s)",
    "You've hit your session limit · resets 11am\n⏺ Resuming the builders",
    "⏺ The helper says: You've hit your session limit · resets 11am",
    '⏺ The request limit resets 11am; I am still working.',
    'src/test.ts:42: Usage limit reached · resets 11am',
    'Server is temporarily limiting requests (not your usage limit) · Rate limited',
  ])('does not attribute helper/prose/stale evidence to the parent: %s', snapshot => {
    expect(classifyStuckSignature(snapshot)?.kind).not.toBe('rate-limited');
    expect(detectQuotaExhaustion(snapshot)).toBeNull();
  });
  it('preserves a genuine parent wall and a completed-turn footer', () => {
    expect(classifyStuckSignature("You've hit your session limit · resets 11am\n✻ Cooked for 0s")?.kind).toBe('rate-limited');
    expect(detectQuotaExhaustion(wall)).toContain('usage limit');
  });
  it('requires session-owned corroboration even for a tool printing a naked banner', async () => {
    const { proxy, sendMessage } = setup({ confirmSessionUsageLimit: () => false });
    const state = inbound(proxy);
    await proxy.fireTier1(123, state);
    expect(sendMessage.mock.calls.flat().join(' ')).not.toMatch(/hit.*usage limit|paused until/i);
  });
});

describe('usage-limit episode deduplication', () => {
  it('sends once across tiers, new messages and restart', async () => {
    const { proxy, sendMessage, stateDir } = setup();
    const first = inbound(proxy);
    await proxy.fireTier1(123, first);
    await proxy.fireTier2(123, first);
    await proxy.fireTier3(123, first);
    await proxy.fireTier1(123, inbound(proxy));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    proxy.stop();
    const restarted = setup({}, stateDir);
    await restarted.proxy.fireTier1(123, inbound(restarted.proxy));
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
  it('reserves before asynchronous delivery and retains ambiguous failures', async () => {
    const { proxy, sendMessage } = setup();
    const state = inbound(proxy);
    let release!: () => void;
    sendMessage.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    const one = proxy.fireTier1(123, state);
    const two = proxy.fireTier2(123, state);
    await two;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    release(); await one;
    proxy.handleAgentMessage(123, 'parent');
    sendMessage.mockRejectedValueOnce(new Error('not sent'));
    await proxy.fireTier1(123, inbound(proxy));
    await proxy.fireTier1(123, inbound(proxy));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
  it('cancels superseded state so old async assessments cannot speak', () => {
    const { proxy } = setup();
    const old = inbound(proxy);
    inbound(proxy);
    expect(old.cancelled).toBe(true);
  });
  it('does not let a completed old send delete a newer watch', async () => {
    const { proxy, sendMessage } = setup();
    const old = inbound(proxy);
    // Keep Tier 3 on the quota branch rather than the finished-session branch.
    proxy.config.getProcessTree = () => [{ command: 'background', pid: 123 }];
    let release!: () => void;
    sendMessage.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    const pending = proxy.fireTier3(123, old);
    const newer = inbound(proxy);
    release(); await pending;
    expect(proxy.states.get(123)).toBe(newer);
    expect(newer.cancelled).toBe(false);
  });
  it('does not clear a claim on a helper or stale session reply', async () => {
    const { proxy, sendMessage } = setup();
    await proxy.fireTier1(123, inbound(proxy));
    proxy.onMessageLogged({ channelId: '123', fromUser: false, sessionName: 'helper', text: 'The helper finished its task.' });
    await proxy.fireTier1(123, inbound(proxy));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('releases the proxy mutex when corroboration throws at send time', async () => {
    let releases = 0;
    const { proxy, sendMessage } = setup({ acquireProxyMutex: () => true, releaseProxyMutex: () => { releases++; } });
    proxy.config.confirmSessionUsageLimit = () => { throw new Error('unreadable'); };
    await proxy.sendProxyMessage(123, 'limit', 1, undefined, 'parent');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(releases).toBe(1);
  });

});
