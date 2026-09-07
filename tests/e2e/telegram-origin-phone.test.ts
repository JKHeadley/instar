// @ts-nocheck — real browser module exercised through DOM events and production HTTP.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { compileOriginWorker, compileOriginConfigWorker } from '../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { mountOriginPanel } from '../../dashboard/origin.js';
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
describe('phone origin operator lifecycle', () => {
  it('unlocks with a real PIN, reads durable origins and saves cosmetic preferences through rendered controls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-phone-')), stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    cleanup.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'origin-phone-e2e' }));
    const telegramConfig = { token: '123:phone-fixture', chatId: '-100123', messageOrigin: { display: { enabled: true } } };
    const config = { projectName: 'phone-fixture', projectDir: root, stateDir, port: 0, authToken: 'phone-fixture-auth', dashboardPin: '654321',
      messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const boot = await bootTelegramOrigin({ config, token: telegramConfig.token, workerUrl: await compileOriginWorker(), configWorkerUrl: await compileOriginConfigWorker(),
      noticeOwner: true, holdsLease: () => true, isSessionLive: () => false, attachSessionLifecycle: () => undefined,
      diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    cleanup.push(() => boot.close());
    const telegram = new TelegramAdapter(telegramConfig, stateDir, { suppressLifelineAutoCreate: true }); cleanup.push(() => telegram.stop());
    telegram.registerTopicSession(42, 'fixture-session', 'Project discussion');
    const store = new TopicProfileStore({ stateFilePath: path.join(stateDir, 'state/topic-profiles.json'), legacyFrameworksPath: path.join(stateDir, 'topic-frameworks.json'), isDryRun: () => true });
    const resolver = new TopicProfileResolver({ store, defaultFramework: () => 'claude-code', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
      frameworkDefaultModels: () => ({}), tierEscalationConfig: () => undefined, localModelBinding: () => null, frameworkBinaryPath: () => null });
    let server;
    const surface = new TopicProfileWriteSurface({ store, resolver, regime: () => ({ enabled: false, dryRun: true }),
      boundOperator: key => server?.getTopicOperatorStore()?.getOperator(key) ?? null, localModelBinding: () => null,
      legacyFrameworkRespawn: async () => { throw Error('cosmetic-must-not-respawn'); }, disclose: async () => undefined, audit: () => 'fixture-audit' });
    server = new AgentServer({ config, state: new StateManager(stateDir), sessionManager: createMockSessionManager(), telegram, telegramOrigin: boot.runtime,
      topicProfile: { store, resolver, surface, confirmSlots: new ProfileConfirmSlots({ ttlMs: () => 300000 }) } });
    cleanup.push(() => server.stop());
    server.getTopicOperatorStore().setAuthenticatedOperator(42, { platform: 'telegram', uid: '777', displayName: 'Operator' },
      { kind: 'authenticated-inbound', ingress: 'telegram-polling', authorization: 'telegram-is-authorized-sender', senderUid: '777', messageId: 'fixture' });
    const http = server.getApp().listen(0, '127.0.0.1'); cleanup.push(() => new Promise(resolve => http.close(resolve)));
    await new Promise(resolve => http.listening ? resolve() : http.once('listening', resolve));
    const base = `http://127.0.0.1:${http.address().port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { if (boot.runtime.options.display({ chatId: '-100123', topicId: '42' }).agent.enabled === true) break; } catch { /* fixture waits for real config observer */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    boot.runtime.service.registerAutomationProducer('phone-fixture');
    const operation = boot.runtime.service.runAsAutomation('phone-fixture', () => boot.runtime.service.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Private test content must not appear in the audit panel.' } }));
    await boot.runtime.service.admit(operation);
    const auth = { Authorization: 'Bearer phone-fixture-auth' };
    expect((await fetch(base + '/telegram/origins', { headers: auth })).status).toBe(403);
    expect((await fetch(base + '/telegram/origin-display', { headers: auth })).status).toBe(403);
    const unlock = await fetch(base + '/dashboard/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '654321' }) });
    expect(unlock.status).toBe(200); const issued = await unlock.json(); expect(issued.operatorSessionToken).toBeTruthy();
    const proof = { ...auth, 'X-Instar-Operator-Session': issued.operatorSessionToken };
    const dom = new JSDOM('<main style="width:375px"></main>'), panel = dom.window.document.querySelector('main');
    const controller = mountOriginPanel(panel, { request: (url, options = {}) => fetch(base + url, { ...options, headers: { ...proof, ...options.headers } }), unlock: () => undefined });
    cleanup.push(() => controller.stop()); await controller.refresh();
    expect(panel.querySelectorAll('[data-glance-tile]')).toHaveLength(3);
    expect(panel.querySelector('[aria-label="Show origin details"]')).toBeNull();
    panel.querySelector('[data-glance-tile="messages"]').click();
    expect(panel.querySelector('[aria-label="Message audit"] details')).not.toBeNull(); expect(panel.textContent).toContain('Pool coverage complete');
    expect(panel.textContent).not.toContain('Private test content');
    panel.querySelector('[data-glance-tile="recording"]').click();
    expect(panel.querySelector('[aria-label="Recording status"]')).not.toBeNull();
    panel.querySelector('[data-glance-tile="display"]').click();
    const save = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Save display settings');
    panel.querySelector('[aria-label="Show origin details"]').checked = false; await save.onclick();
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')).messaging[0].config.messageOrigin.display.enabled).toBe(false);
    const refreshDeadline = Date.now() + 10000;
    while (Date.now() < refreshDeadline) {
      try { if (boot.runtime.options.display({ chatId: '-100123', topicId: '42' }).agent.enabled === false) break; } catch { /* waits for independent observer */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const hidden = boot.runtime.service.runAsAutomation('phone-fixture', () => boot.runtime.service.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Later private content.' } }));
    expect(hidden.record.display.enabled).toBe(false);
    const select = panel.querySelector('select'); select.value = '42'; select.onchange();
    const inherit = panel.querySelector('input[type=checkbox]'); inherit.checked = false; inherit.onchange();
    panel.querySelector('[aria-label="Model name"]').checked = false; await save.onclick();
    expect(store.resolve('42').messageOriginDisplay.model).toBe(false);
    inherit.checked = true; inherit.onchange(); await save.onclick(); expect(store.resolve('42').messageOriginDisplay).toBeNull();
    const originalRow = await boot.runtime.store.getOrigin(operation.record.originId);
    expect(JSON.parse(originalRow.record.envelopeJson).display.enabled).toBe(true);
    const modelWrite = await surface.applyWrite({ topicKey: '42', patch: { model: 'sonnet' }, principal: { kind: 'token' }, origin: 'http' });
    expect(modelWrite.refusedFields).toContain('model');
  }, 30000);
});
