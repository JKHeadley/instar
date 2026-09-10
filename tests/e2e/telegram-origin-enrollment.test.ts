import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { originToolGuardHook } from '../../src/messaging/telegram-origin/OriginToolGuard.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { originCertificationFixture } from '../helpers/originCertification.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
describe('production origin enrollment factory', () => {
  it('makes completion attainable from signed build evidence and real installed inventories, while missing evidence leaves metadata sends alive', async () => {
    const f = await originCertificationFixture();
    cleanups.push(() => SafeFsExecutor.safeRm(f.root, { recursive: true, force: true, operation: 'test:origin-enrollment-e2e:cleanup' }));
    const projectDir = path.join(f.root, 'agent'), stateDir = path.join(projectDir, '.instar');
    for (const directory of ['.instar/state', '.instar/scripts', '.instar/hooks/instar', '.claude/scripts']) await mkdir(path.join(projectDir, directory), { recursive: true });
    const relay = await readFile(path.resolve('src/templates/scripts/telegram-reply.sh'));
    await writeFile(path.join(stateDir, 'scripts/telegram-reply.sh'), relay);
    await writeFile(path.join(projectDir, '.claude/scripts/telegram-reply.sh'), relay);
    await writeFile(path.join(stateDir, 'hooks/instar/telegram-origin-guard.js'), originToolGuardHook());
    await writeFile(path.join(projectDir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ command: 'node .instar/hooks/instar/telegram-origin-guard.js' }] }] } }));
    await writeFile(path.join(stateDir, 'state/playwright-profiles.json'), JSON.stringify({ profiles: [] }));
    await writeFile(path.join(stateDir, 'state/agent-attention-topic.json'), '42');
    const telegramConfig = { token: '123:enrollment-fixture', chatId: '-100123', ownerUserId: 12345, messageOrigin: { display: { enabled: false } } };
    const config = { projectDir, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth', enabledFrameworks: ['claude-code'],
      messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const start = (packageRoot: string) => bootTelegramOrigin({ config: config as never, token: telegramConfig.token,
      workerUrl: worker, enrollmentPackageRoot: packageRoot, noticeOwner: true, holdsLease: () => true,
      listLiveSessions: () => [], diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    let boot = await start(f.root); cleanups.push(() => boot.close());
    const first = await boot.runtime.status();
    expect(first.activation.observations.filter(item => !['ready', 'not-applicable'].includes(item.state))).toEqual([]);
    expect(first.activation.complete).toBe(true);
    await boot.close(); boot = await start(path.join(f.root, 'missing-release'));
    const telegram = new TelegramAdapter(telegramConfig, stateDir, { suppressLifelineAutoCreate: true });
    const app = express(); app.use(express.json()); app.use(createRoutes({ config, telegramOrigin: boot.runtime, telegram,
      verifyDashboardOperatorSession: (proof: string) => proof === 'fixture-operator' } as never));
    const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const status = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/telegram/origins/status`, {
      headers: { Authorization: 'Bearer fixture-auth', 'X-Instar-Operator-Session': 'fixture-operator' } });
    expect(status.status).toBe(200);
    expect((await status.json() as any).activation).toMatchObject({ complete: false, observations: expect.arrayContaining([
      expect.objectContaining({ obligation: 'development-trials', state: 'unknown', reason: 'origin-release-certification-not-installed:release-pipeline-issuance-required' }),
    ]) });
    const wire = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: -100123 }, message_thread_id: 43 } })));
    vi.stubGlobal('fetch', wire);
    await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '43' });
    await telegram.sendToTopic(43, 'Metadata remains recorded while release certification is missing.');
    expect(wire).toHaveBeenCalledTimes(1);
    const sent = (await boot.runtime.store.listOrigins()).records.filter(row => JSON.parse(row.record.envelopeJson).destination.topicId === '43');
    expect(sent).toHaveLength(1); expect(sent[0].operation?.state).toBe('accepted');
  });
  it.each([undefined, ''])('observes the credential owner from real tokenless Boot without interpreting the account sentinel: %s', async token => {
    const f = await originCertificationFixture();
    cleanups.push(() => SafeFsExecutor.safeRm(f.root, { recursive: true, force: true, operation: 'test:origin-tokenless-enrollment:cleanup' }));
    const stateDir = path.join(f.root, 'agent-state'); await mkdir(stateDir);
    const identities = new MachineIdentityManager(stateDir);
    await identities.generateIdentity({ name: 'Source' });
    const peerDirectory = path.join(f.root, 'peer-state'); await mkdir(peerDirectory);
    const peerIdentity = new MachineIdentityManager(peerDirectory);
    await peerIdentity.generateIdentity({ name: 'Holder' });
    identities.registerMachine(peerIdentity.loadIdentity());
    const config = { projectDir: f.root, stateDir, projectName: 'echo', port: 0,
      messaging: [{ type: 'telegram', enabled: true, config: { chatId: '-100123' } }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const boot = await bootTelegramOrigin({ config: config as never, token, workerUrl: worker, enrollmentPackageRoot: f.root,
      noticeOwner: false, holdsLease: () => false, listLiveSessions: () => [], diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    cleanups.push(() => boot.close());
    expect(boot.runtime.options.bot.accountId).toBe(token === undefined ? 'unresolved-tokenless-source' : '');
    const transport = vi.fn(async (machineId: string) => ({ ok: true, result: { ok: true, protocol: 'instar-telegram-origin-v1',
      executionOwnerMachineId: machineId, credentialOwner: true, accountId: '123' } }));
    boot.runtime.enrollmentPeerTransport = transport;
    await vi.waitFor(async () => expect((await boot.runtime.status()).activation.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ obligation: 'peers', subject: peerIdentity.loadIdentity().machineId, state: 'ready' }),
    ])), { timeout: 8000, interval: 100 });
    expect(transport).toHaveBeenCalledWith(peerIdentity.loadIdentity().machineId, expect.objectContaining({ action: 'capabilities' }), 2000);
  });
});
