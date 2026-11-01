import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';
import { enrollOriginBrowser, enrollReviewedOriginBrowser } from '../../src/messaging/telegram-origin/OriginBrowserEnrollment.js';
import { REVIEWED_WEB_K_BUILDS } from '../../src/messaging/telegram-origin/ReviewedWebKBuilds.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';

// Production path: bootTelegramOrigin builds the broker from the registry and
// drives the real TelegramWebKDriver over a private CDP pipe. The "browser" is
// a node script that speaks CDP and serves whichever Web K build the test
// names, so a Telegram update is simulated without the network or a login.
const b679 = REVIEWED_WEB_K_BUILDS.find(build => build.buildId === 'web-k-2.2-679')!;
const b676 = REVIEWED_WEB_K_BUILDS.find(build => build.buildId === 'web-k-2.2-676')!;
const FAKE_BROWSER = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const served = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'served-build.json'), 'utf8'));
const out = fs.createWriteStream(null, { fd: 4 });
let buffer = Buffer.alloc(0);
fs.createReadStream(null, { fd: 3 }).on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]); let end;
  while ((end = buffer.indexOf(0)) >= 0) {
    const message = JSON.parse(buffer.subarray(0, end).toString()); buffer = buffer.subarray(end + 1);
    let result = {};
    if (message.method === 'Target.createTarget') result = { targetId: 't1' };
    else if (message.method === 'Target.attachToTarget') result = { sessionId: 's1' };
    else if (message.method === 'Runtime.evaluate') {
      const e = message.params.expression; let value = true;
      if (e.includes('getAccountNumber')) { const b = served(); value = { accountNumber: 1, accountId: '7812716706', assets: [...b.criticalAssets].sort(), assetDigests: b.assetDigests }; }
      else if (e.includes('getInputPeerById')) { const m = /"(user|chat|channel)_id":"(\d+)"/.exec(e); value = { _: 'inputPeer' + m[1][0].toUpperCase() + m[1].slice(1), [m[1] + '_id']: m[2], access_hash: '1' }; }
      else if (e.includes('innerText')) value = 'page';
      result = { result: { value } };
    }
    out.write(JSON.stringify({ id: message.id, result }) + '\0');
  }
});
setInterval(() => {}, 1 << 30);
`;

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 30_000);

async function fixture(browserSendAllowance?: unknown) {
  const root = await mkdtemp('/tmp/origin-webk-drift-');
  cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-webk-drift:cleanup' }); });
  const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify({ mcpServers: {} }));
  const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
    messaging: [{ type: 'telegram', enabled: true, config: { token: '123:drift-fixture', chatId: '-100123', lifelineTopicId: 7848,
      messageOrigin: browserSendAllowance === undefined ? {} : { browserSendAllowance } } }] };
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
  const browserDir = path.join(root, 'bin'); await mkdir(browserDir);
  const executablePath = path.join(browserDir, 'fake-chromium');
  await writeFile(executablePath, FAKE_BROWSER); await chmod(executablePath, 0o755);
  const serve = (build: { criticalAssets: string[]; assetDigests: Record<string, string> }) =>
    writeFile(path.join(browserDir, 'served-build.json'), JSON.stringify(build));
  const registry = new PlaywrightProfileRegistry({ projectDir: root, stateDir, listVaultNames: () => [] });
  registry.createProfile({ id: 'operator-telegram' });
  registry.assignAccount('operator-telegram', { service: 'telegram', identity: 'operator', owner: 'operator', vaultRefs: [] });
  registry.materializeProfileDirectory('operator-telegram');
  await enrollOriginBrowser({ registry, profileId: 'operator-telegram', inspectProcesses: async () => [],
    enrollment: { accountId: '7812716706', accountNumber: 1, executablePath,
      supportedBuilds: [{ buildId: b676.buildId, criticalAssets: [...b676.criticalAssets], assetDigests: { ...b676.assetDigests } }] } });
  const attention = vi.fn(async (_input: { id: string; profileId: string; publicTransportAlternative: boolean }) => undefined);
  const boot = await bootTelegramOrigin({ config: config as never, token: '123:drift-fixture', noticeOwner: true, workerUrl: worker,
    holdsLease: () => true, isSessionLive: () => true, attachSessionLifecycle: () => undefined,
    diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn(), onBrowserRecoveryAttention: attention });
  cleanup.push(async () => { for (const b of boot.runtime.browsers.values()) await b.executor.close(); await boot.close(); });
  return { boot, registry, serve, attention, stateDir };
}

describe('Telegram Web K drift through the production boot', () => {
  it('the production browser callback admits only the configured profile and exact external destination', { timeout: 60_000 }, async () => {
    const f = await fixture({ profileId: 'operator-telegram', accountId: '7812716706',
      chatId: 'channel:4290919884', topicId: null, decisionRef: 'telegram:102965:2026-10-30:07:17' });
    const authorize = f.boot.runtime.browsers.get('operator-telegram')!.executor.options.authorize;
    const destination = { version: 1 as const, transport: 'telegram-web' as const, accountId: '7812716706',
      chatId: 'channel:4290919884', topicId: null, messageId: null, inlineMessageId: null, scheduledMessageId: null };
    expect(await authorize(destination)).toBe(true);
    // channel:123 is this agent's existing Bot API chat and remains allowed.
    expect(await authorize({ ...destination, chatId: 'channel:123' })).toBe(true);
    expect(await authorize({ ...destination, chatId: 'channel:456' })).toBe(false);
    expect(await authorize({ ...destination, topicId: '1' })).toBe(false);
    expect(await authorize({ ...destination, messageId: '42' })).toBe(false);
    expect(await authorize({ ...destination, accountId: '1' })).toBe(false);
    const absent = await fixture();
    expect(await absent.boot.runtime.browsers.get('operator-telegram')!.executor.options.authorize(destination)).toBe(false);
  });

  it('an unreviewed live build raises exactly one attention item and records the failed build', { timeout: 60_000 }, async () => {
    const f = await fixture();
    await f.serve({ criticalAssets: ['apiManagerProxy-NEW.js', 'app-NEW.js', 'index-NEW.js'],
      assetDigests: { 'apiManagerProxy-NEW.js': 'a'.repeat(64), 'app-NEW.js': 'b'.repeat(64), 'index-NEW.js': 'c'.repeat(64) } });
    const browser = f.boot.runtime.browsers.get('operator-telegram');
    expect(browser).toBeDefined();
    await expect(browser!.resolvePeer({ kind: 'channel', id: '123' })).rejects.toThrow('browser-peer-canary-unavailable');
    expect(f.attention).toHaveBeenCalledOnce();
    expect(f.attention.mock.calls[0][0]).toMatchObject({ profileId: 'operator-telegram', publicTransportAlternative: false });
    const [state] = await f.boot.runtime.store.getBrowserRecoveryStates();
    expect(state).toMatchObject({ profileId: 'operator-telegram', failedBuilds: [expect.stringMatching(/^unrecognized:[0-9a-f]{64}$/)], attentionPending: false });
    await expect(browser!.resolvePeer({ kind: 'channel', id: '123' })).rejects.toThrow('browser-recovery-cooldown');
    expect(f.attention).toHaveBeenCalledOnce();
  });

  it('the reviewed entrypoint re-enrolls a new build and the running server uses it without a restart', { timeout: 60_000 }, async () => {
    const f = await fixture();
    await f.serve(b676);
    const browser = f.boot.runtime.browsers.get('operator-telegram')!;
    await expect(browser.resolvePeer({ kind: 'channel', id: '123' })).resolves.toMatchObject({ _: 'inputPeerChannel', channel_id: '123' });
    // Telegram ships 679; the trusted entrypoint retires the broker's browser, runs the
    // read-only canary on the real driver, and enrolls [679, 676].
    await f.serve(b679);
    const result = await enrollReviewedOriginBrowser({ registry: f.registry, profileId: 'operator-telegram' });
    expect(result.build.buildId).toBe('web-k-2.2-679');
    expect(f.registry.requireTelegramBrokerProfile('operator-telegram').telegramBroker!.supportedBuilds.map(b => b.buildId))
      .toEqual(['web-k-2.2-679', 'web-k-2.2-676']);
    // The broker's old process was bound to the old proof: one call retires it,
    // the next starts under the new enrollment. No server restart.
    await browser.resolvePeer({ kind: 'channel', id: '123' }).catch(() => undefined);
    await expect(browser.resolvePeer({ kind: 'channel', id: '123' })).resolves.toMatchObject({ _: 'inputPeerChannel', channel_id: '123' });
    expect(f.attention).not.toHaveBeenCalled();
  });
});
