import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authMiddleware } from '../../src/server/middleware.js';
import { browserOutboxSupport } from '../../src/server/mobileBrowserDevices.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator } from '../../src/server/mobilePairingRoutes.js';
import { exactStopPhrases, isExactStopMessage } from '../../src/core/MessageSentinel.js';
import { getInitDefaults, getMigrationDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { emptyRegistry } from '../../src/awareness/registry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterEach(() => {
  for (const svc of services.splice(0)) svc.stop();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/web-chat-outbox-server.test.ts' });
});
function home() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-server-'));
  dirs.push(projectDir);
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { projectDir, stateDir };
}
function pairing(browser: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const { stateDir } = home();
  const config = { projectName: 'fixture', developmentAgent: true, mobilePairing: { browser, ...extra }, stateDir } as unknown as InstarConfig;
  const svc = new MobilePairingService({ config, stateDir, holdsLease: () => true });
  svc.nativeOn = true;
  services.push(svc);
  return svc;
}

describe('browser durable outbox support and upgrade defaults', () => {
  it('requires initialized wiring and keeps feature-off support explicit', () => {
    const svc = pairing();
    expect(browserOutboxSupport(svc)).toMatchObject({ version: 1, enabled: false, text: false, media: false, recoveryGeneration: '1' });
    expect(browserOutboxSupport(svc, { text: true, media: false })).toMatchObject({ enabled: true, text: true, media: false });
    svc.nativeOn = false;
    expect(browserOutboxSupport(svc, { text: true, media: true }).enabled).toBe(false);
    expect(browserOutboxSupport(pairing({ outboxEnabled: false }), { text: true, media: true })).toMatchObject({ enabled: false, text: false, media: false });
  });
  it('the actual status router reports an absent native route service as unsupported', async () => {
    const svc = pairing();
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(() => 'fixture-token', 'fixture', undefined, deviceAuthenticator(svc)));
    app.use(createMobilePairingRouter(svc, svc.deps));
    const status = await request(app).get('/mobile/browser-devices/status').set('Authorization', 'Bearer fixture-token');
    expect(status.status).toBe(200);
    expect(status.body.outbox).toMatchObject({ version: 1, enabled: false, text: false, media: false });
  });
  it('preserves a restoration generation and refuses malformed generation rather than reverting it', () => {
    expect(browserOutboxSupport(pairing({ outboxRecoveryGeneration: 'restore-unique' }), { text: true, media: true }).recoveryGeneration).toBe('restore-unique');
    for (const generation of ['', ' ', null, 7]) {
      expect(browserOutboxSupport(pairing({ outboxRecoveryGeneration: generation }), { text: true, media: true }))
        .toMatchObject({ enabled: false, recoveryGeneration: null });
    }
  });
  it('does not turn disabled chat/media into live delivery support', () => {
    const svc = pairing({}, { chat: { enabled: false }, native: { media: { enabled: false } } });
    expect(browserOutboxSupport(svc, { text: true, media: true })).toMatchObject({ enabled: true, text: false, media: false });
  });
  it('advertises the canonical exact classifier without expanding or mutating its authority', () => {
    const phrases = exactStopPhrases();
    expect(phrases).toContain('stop everything');
    expect(phrases).toContain('/stop');
    for (const phrase of phrases) expect(isExactStopMessage(phrase)).toBe(true);
    expect(phrases).not.toContain('stop the build please');
    expect(isExactStopMessage('please do not cancel the review')).toBe(false);
    (phrases as string[]).push('fixture-only-mutation');
    expect(exactStopPhrases()).not.toContain('fixture-only-mutation');
  });
  it('uses one missing-only default for new and existing agents without activating browser enrollment', () => {
    for (const defaults of [getInitDefaults('managed-project'), getMigrationDefaults('managed-project')]) {
      const config: Record<string, unknown> = {};
      applyDefaults(config, defaults);
      expect(config.mobilePairing).toMatchObject({ browser: { outboxEnabled: true, outboxRecoveryGeneration: '1' } });
      expect((config.mobilePairing as any).enabled).toBeUndefined();
      expect((config.mobilePairing as any).browser.enabled).toBeUndefined();
      const chosen = { mobilePairing: { browser: { outboxEnabled: false, outboxRecoveryGeneration: 'restore-kept' } } };
      applyDefaults(chosen, defaults);
      expect(chosen.mobilePairing.browser).toEqual({ outboxEnabled: false, outboxRecoveryGeneration: 'restore-kept' });
      expect(applyDefaults(chosen, defaults).patched).toBe(false);
    }
  });
  it('the actual existing-agent config migration preserves a disabled restoration gate across repeated updates', () => {
    const h = home();
    const configPath = path.join(h.stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'fixture', mobilePairing: { browser: { outboxEnabled: false, outboxRecoveryGeneration: 'restore-kept' } } }));
    const migrator = new PostUpdateMigrator({ ...h, version: '1.0.0' });
    const run = () => (migrator as any).migrateConfig({ upgraded: [], skipped: [], errors: [] });
    run();
    const first = fs.readFileSync(configPath, 'utf8');
    expect(JSON.parse(first).mobilePairing.browser).toMatchObject({ outboxEnabled: false, outboxRecoveryGeneration: 'restore-kept' });
    run();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(first);
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'fixture' }));
    run();
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).mobilePairing.browser).toMatchObject({ outboxEnabled: true, outboxRecoveryGeneration: '1' });
  });
  it('new and existing agent instruction rendering includes the truthful pending-send note once', () => {
    const h = home();
    const fresh = generateClaudeMd('fixture', 'fixture', 4042, false);
    const migrator = new PostUpdateMigrator({ ...h, port: 4042, hasTelegram: false, projectName: 'fixture' });
    const legacy = generateClaudeMd('fixture', 'fixture', 4042, false, false, false, emptyRegistry());
    const result = { upgraded: [], skipped: [], errors: [] };
    const migrated = (migrator as any).patchClaudeMdContent(legacy, result).content as string;
    for (const content of [fresh, migrated, migrator.buildCanonicalClaudeMd()]) {
      expect(content).toContain('Pending web chat sends survive closing the tab');
      expect(content).toContain('Queued means saved locally, not delivered.');
      expect(content).toContain('does not cache received conversation history');
      expect(content.split('Pending web chat sends survive closing the tab')).toHaveLength(2);
    }
    expect((migrator as any).patchClaudeMdContent(migrated, result).content).toBe(migrated);
  });
});
