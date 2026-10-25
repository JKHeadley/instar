import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectOriginInstallation } from '../../../src/messaging/telegram-origin/OriginInstallation.js';
import { originToolGuardHook } from '../../../src/messaging/telegram-origin/OriginToolGuard.js';
import { installCodexHooks } from '../../../src/core/installCodexHooks.js';
import { writeLease } from '../../../src/lifeline/TelegramPollOwnerLease.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { TelegramOriginRuntime } from '../../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-installation:cleanup' }); });
async function fixture() {
  const projectDir = temporaryState(); roots.push(projectDir);
  const stateDir = path.join(projectDir, '.instar');
  await Promise.all(['scripts', 'hooks/instar', 'state'].map(dir => mkdir(path.join(stateDir, dir), { recursive: true })));
  await mkdir(path.join(projectDir, '.claude/scripts'), { recursive: true });
  const relay = await readFile(new URL('../../../src/templates/scripts/telegram-reply.sh', import.meta.url), 'utf8');
  await Promise.all([
    writeFile(path.join(stateDir, 'scripts/telegram-reply.sh'), relay),
    writeFile(path.join(projectDir, '.claude/scripts/telegram-reply.sh'), relay),
    writeFile(path.join(stateDir, 'hooks/instar/telegram-origin-guard.js'), originToolGuardHook()),
    writeFile(path.join(stateDir, 'state/playwright-profiles.json'), JSON.stringify({ profiles: [] })),
    writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ enabledFrameworks: ['codex-cli'] })),
  ]);
  installCodexHooks(projectDir);
  const runtime = { sessions: { listBindings: () => [{ sessionId: 'session', harnessId: 'codex-cli' }] },
    service: { options: { sendPolicy: { review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) } } },
    options: { isSessionLive: () => true, bot: { token: '123:fixture', accountId: '123' }, alertDestinations: () => [], getAlertPolicy: () => null }, browsers: new Map() } as unknown as TelegramOriginRuntime;
  const inspect = () => inspectOriginInstallation({ runtime, projectDir, stateDir, automationOnly: false,
    sessions: [{ sessionId: 'session', harnessId: 'codex-cli' }], storageHealthy: true });
  return { inspect, stateDir, projectDir, runtime };
}
describe('origin production installed-artifact census', () => {
  it('recognizes current installed artifacts but does not infer a complete sender inventory', async () => {
    const h = await fixture(), observed = await h.inspect();
    expect(observed.inventoryComplete).toBe(false);
    expect(observed.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ obligation: 'sessions', state: 'ready' }),
      expect.objectContaining({ obligation: 'send-policy', state: 'ready' }),
      expect.objectContaining({ obligation: 'installed-scripts', subject: 'neutral-relay', state: 'ready' }),
      expect.objectContaining({ obligation: 'tool-guards', state: 'ready' }),
      expect.objectContaining({ obligation: 'browser-profiles', state: 'not-applicable' }),
    ]));
  });
  it('requires the actual policy callbacks despite valid live session and installed hooks', async () => {
    const h = await fixture();
    const authority = h.runtime.service.options.sendPolicy;
    const state = async () => (await h.inspect()).observations.find(item => item.obligation === 'send-policy')?.state;
    expect(await state()).toBe('ready');
    h.runtime.service.options.sendPolicy = undefined;
    expect(await state()).toBe('held');
    h.runtime.service.options.sendPolicy = { review: async () => ({ ok: true }) } as never;
    expect(await state()).toBe('held');
    h.runtime.service.options.sendPolicy = authority;
    expect(await state()).toBe('ready');
  });
  it('includes idle enabled frameworks and never treats installed hooks as native enforcement proof', async () => {
    const h = await fixture();
    await writeFile(path.join(h.stateDir, 'config.json'), JSON.stringify({ enabledFrameworks: ['codex-cli', 'gemini-cli', 'pi-cli', 'grok-build'] }));
    const observed = await h.inspect();
    for (const framework of ['gemini-cli', 'pi-cli', 'grok-build']) {
      expect(observed.observations).toContainEqual(expect.objectContaining({ obligation: 'tool-guards', subject: framework, state: 'held' }));
    }
    expect(observed.observations).toContainEqual(expect.objectContaining({ obligation: 'tool-guards', subject: 'codex-cli', state: 'ready' }));
    expect(observed.observations).toContainEqual(expect.objectContaining({ obligation: 'tool-guards', subject: 'codex-cli:native-enforcement', state: 'unknown' }));
    expect(observed.observations.filter(item => item.obligation === 'sessions')).toHaveLength(1);
  });
  it('requires an independent current notice projection and preserves its observation time', async () => {
    const h = await fixture(), observedAt = Date.now() - 1000;
    h.runtime.options.alertDestinations = () => [{ id: 'hub', chatId: '-100123', topicId: '7848' }];
    const row = async () => (await h.inspect()).observations.find(item => item.obligation === 'notice-policy' && item.subject === 'hub');
    expect(await row()).toMatchObject({ state: 'unknown' });
    const projection = { alertDestinationId: 'hub', destination: { accountId: '123', chatId: '-100123', topicId: '7848' },
      authorized: true, ownershipValid: true, clientPreferences: 'telegram-managed', optedOut: false, observerHealthy: true,
      observedAt, validUntil: observedAt + 30_000, version: 'fixture', display: { enabled: true, machine: true, harness: true, model: true } };
    h.runtime.options.getAlertPolicy = () => projection;
    expect(await row()).toMatchObject({ state: 'ready', observedAt, validUntil: observedAt + 30_000 });
    projection.validUntil = observedAt + 30_001;
    expect(await row()).toMatchObject({ state: 'unknown' });
    projection.validUntil = observedAt + 30_000;
    projection.observedAt = Date.now() - 31_000;
    expect(await row()).toMatchObject({ state: 'unknown' });
  });
  it.each(['stale-script', 'stale-hook', 'wrong-codex-matcher', 'hooks-disabled'])('refuses %s despite a valid session credential', async failure => {
    const h = await fixture();
    if (failure === 'stale-script') await writeFile(path.join(h.stateDir, 'scripts/telegram-reply.sh'), '#!/bin/sh\nexit 0\n');
    else if (failure === 'stale-hook') await writeFile(path.join(h.stateDir, 'hooks/instar/telegram-origin-guard.js'), '// old guard');
    else {
      const file = path.join(h.projectDir, '.codex/hooks.json'), settings = JSON.parse(await readFile(file, 'utf8'));
      if (failure === 'wrong-codex-matcher') settings.hooks.PreToolUse[0].matcher = '*';
      else settings.disableAllHooks = true;
      await writeFile(file, JSON.stringify(settings));
    }
    const observed = await h.inspect();
    expect(observed.observations.find(item => item.obligation === (failure === 'stale-script' ? 'installed-scripts' : 'tool-guards'))?.state).toBe('held');
  });
  it('detects an old live lifeline, accepts its fresh compatible lease, and refuses expiry', async () => {
    const h = await fixture(); await writeFile(path.join(h.stateDir, 'lifeline.lock'), JSON.stringify({ pid: process.pid }));
    writeLease(h.stateDir, '123:fixture', process.pid);
    const state = async () => (await h.inspect()).observations.find(item => item.obligation === 'lifeline')!.state;
    expect(await state()).toBe('held');
    writeLease(h.stateDir, '123:fixture', process.pid, Date.now(), 'instar-telegram-origin-v1');
    expect(await state()).toBe('ready');
    writeLease(h.stateDir, '123:fixture', process.pid, Date.now() - 31_000, 'instar-telegram-origin-v1');
    expect(await state()).toBe('held');
  });
  it('preserves the real browser observation time and refuses an expired cached canary', async () => {
    const h = await fixture(), observedAt = Date.now() - 1000;
    await writeFile(path.join(h.stateDir, 'state/playwright-profiles.json'), JSON.stringify({ profiles: [{
      id: 'managed', accounts: [{ service: 'telegram' }], executionOwner: 'telegram-origin-broker',
      telegramBroker: { accountId: '123', exclusiveEnrollment: { version: 1, checkedAt: observedAt, retiredPids: [], proofDigest: 'a'.repeat(64) } },
    }] }));
    const status = { canary: { supported: true, accountId: '123' }, canaryObservedAt: observedAt, held: null, closed: false };
    h.runtime.browsers.set('managed', { executor: { broker: { readStatus: () => status } } } as any);
    const row = async () => (await h.inspect()).observations.find(item => item.obligation === 'browser-profiles');
    expect(await row()).toMatchObject({ state: 'ready', observedAt, validUntil: observedAt + 30_000 });
    status.canaryObservedAt = Date.now() - 31_000;
    expect(await row()).toMatchObject({ state: 'held' });
  });
  it('refuses a generic writable Telegram profile and an unproved broker claim', async () => {
    const h = await fixture(), file = path.join(h.stateDir, 'state/playwright-profiles.json');
    const profile: Record<string, unknown> = { id: 'operator-telegram', accounts: [{ service: 'telegram' }] };
    for (const claimed of [false, true]) {
      if (claimed) profile.executionOwner = 'telegram-origin-broker';
      await writeFile(file, JSON.stringify({ profiles: [profile] }));
      expect((await h.inspect()).observations.find(item => item.obligation === 'browser-profiles')?.state).toBe('held');
    }
  });
});
