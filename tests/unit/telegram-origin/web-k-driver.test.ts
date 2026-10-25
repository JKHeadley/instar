import { describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import type { PreparedBrowserChild } from '../../../src/messaging/telegram-origin/BrowserTypes.js';

const fixture = vi.hoisted(() => ({ evaluate: (_expression: string): Promise<unknown> => Promise.resolve(null), closed: false, contextFailures: 0 }));
vi.mock('../../../src/messaging/telegram-origin/PrivateCdpPipe.js', async importOriginal => ({ ...await importOriginal<object>(), PrivateCdpPipe: class {
  async request(method: string, params: { expression?: string }) {
    if (method === 'Target.createTarget') return { targetId: 'target' };
    if (method === 'Target.attachToTarget') return { sessionId: 'session' };
    if (method === 'Runtime.evaluate' && fixture.contextFailures-- > 0) {
      const { BrowserProtocolError } = await importOriginal<typeof import('../../../src/messaging/telegram-origin/PrivateCdpPipe.js')>();
      throw new BrowserProtocolError(method, { message: 'Execution context was destroyed.' });
    }
    try { return { result: { value: await fixture.evaluate(params.expression!) } }; }
    catch { return { exceptionDetails: {} }; }
  }
  async close() { fixture.closed = true; }
} }));
import { TelegramWebKDriver, validWebKBuildEnrollment } from '../../../src/messaging/telegram-origin/TelegramWebKDriver.js';

function harness() {
  const assets = ['app-fixture.js', 'apiManagerProxy-fixture.js', 'index-fixture.js'].sort();
  const bytes = new Map(assets.map(asset => [asset, `public bundle ${asset}`]));
  const assetDigests = Object.fromEntries([...bytes].map(([asset, content]) => [asset, createHash('sha256').update(content).digest('hex')]));
  const state = { accountId: '123', sent: 0 };
  const context = { location: { origin: 'https://web.telegram.org', pathname: '/k/' },
    document: { scripts: assets.map(asset => ({ src: `https://web.telegram.org/k/${asset}` })) },
    performance: { getEntriesByType: () => [] }, crypto: webcrypto, AbortSignal, TextEncoder, Uint8Array,
    window: { createProxiedManagersForAccount: () => ({ apiManager: { getAccountNumber: async () => 1,
      invokeApi: async (method: string) => {
        if (method === 'users.getUsers') return [{ _: 'user', id: state.accountId }];
        if (method === 'messages.sendMessage') { state.sent++; return { _: 'updateShortSentMessage', id: 55 }; }
        throw new Error('unexpected method');
      } } }) },
    fetch: async (url: string) => new Response(bytes.get(url.split('/').pop()!) ?? '', { status: 200 }),
    setTimeout, Date };
  fixture.closed = false; fixture.contextFailures = 0;
  fixture.evaluate = async expression => vm.runInNewContext(expression, context, { timeout: 1000 });
  const build = { buildId: 'fixture-build', criticalAssets: assets, assetDigests };
  const driver = new TelegramWebKDriver({ executablePath: '/fixture/chrome', userDataDir: '/fixture/profile',
    accountNumber: 1, expectedAccountId: '123', supportedBuilds: [build] });
  const child = { accountId: '123', method: 'messages.sendMessage', args: { message: 'Recorded message', random_id: '77' },
    deadlineMs: Date.now() + 30_000 } as PreparedBrowserChild;
  return { driver, build, state, bytes, child };
}
describe('Web K concrete page-script canary and dispatch boundary', () => {
  it('checks the authenticated principal and exact asset bytes before invoking the fixed send method', async () => {
    const h = harness();
    try {
      expect(await h.driver.inspectEnrollment()).toMatchObject({ accountId: '123', assetDigests: h.build.assetDigests });
      expect(await h.driver.canary()).toMatchObject({ supported: true, buildId: 'fixture-build' });
      expect(h.state.sent).toBe(0);
      expect(await h.driver.invoke(h.child)).toEqual({ _: 'updateShortSentMessage', id: 55 });
      expect(h.state.sent).toBe(1);
    } finally { await h.driver.close(); }
  });
  it.each(['asset-bytes', 'account', 'deadline'])('refuses changed %s at the immediate pre-invocation canary', async failure => {
    const h = harness();
    try {
      expect((await h.driver.canary()).supported).toBe(true);
      if (failure === 'asset-bytes') h.bytes.set('app-fixture.js', 'different bytes under the same filename');
      if (failure === 'account') h.state.accountId = '456';
      if (failure === 'deadline') h.child.deadlineMs = Date.now() - 1;
      await expect(h.driver.invoke(h.child)).rejects.toMatchObject({ code: 403 });
      expect(h.state.sent).toBe(0);
    } finally { await h.driver.close(); }
  });
  it('retries only the read-only startup check after navigation destroys its execution context', async () => {
    const h = harness(); fixture.contextFailures = 1;
    try {
      expect((await h.driver.canary()).supported).toBe(true);
      expect(h.state.sent).toBe(0);
      await h.driver.invoke(h.child);
      expect(h.state.sent).toBe(1);
    } finally { await h.driver.close(); }
  });
  it('does not treat filenames alone as an enrolled build', async () => {
    const h = harness();
    try {
      expect(validWebKBuildEnrollment(h.build)).toBe(true);
      expect(validWebKBuildEnrollment({ ...h.build, assetDigests: {} })).toBe(false);
      expect(validWebKBuildEnrollment({ ...h.build, criticalAssets: [...h.build.criticalAssets, h.build.criticalAssets[0]] })).toBe(false);
    } finally { await h.driver.close(); }
  });
});
