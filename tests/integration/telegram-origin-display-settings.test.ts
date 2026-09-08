import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { mountOriginDisplayPreferences } from '../../src/server/originDisplayPreferences.js';
import { DashboardOperatorSessionStore } from '../../src/server/DashboardOperatorSessionStore.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
let dir: string, file: string, app: express.Express, proof: string, context: any;
const original = () => ({ authToken: { secret: true }, unrelated: { preserve: 'yes' }, messaging: [{ type: 'telegram', enabled: true,
  config: { token: { secret: true }, chatId: { secret: true }, messageOrigin: { outageNotice: { enabled: false } } } }] });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-settings-')); file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(original()), { mode: 0o600 });
  const authority = new DashboardOperatorSessionStore(); proof = authority.issue().token;
  app = express(); app.use(express.json());
  app.use((req, res, next) => req.get('Authorization') === 'Bearer fixture' ? next() : res.sendStatus(401));
  context = { config: { stateDir: dir, messaging: original().messaging },
    verifyDashboardOperatorSession: (value: string) => authority.verify(value) };
  mountOriginDisplayPreferences(app as never, context);
});
afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'origin-settings-test' }); });
const get = () => request(app).get('/telegram/origin-display').set('Authorization', 'Bearer fixture').set('X-Instar-Operator-Session', proof);
const save = (body: unknown) => request(app).post('/telegram/origin-display').set('Authorization', 'Bearer fixture').set('X-Instar-Operator-Session', proof).set('X-Instar-Request', '1').send(body);
describe('operator display settings HTTP authority', () => {
  it('requires operator proof in addition to ordinary bearer authentication', async () => {
    await request(app).get('/telegram/origin-display').expect(401);
    await request(app).get('/telegram/origin-display').set('Authorization', 'Bearer fixture').expect(403);
    await request(app).post('/telegram/origin-display').set('Authorization', 'Bearer fixture').send({ display: { enabled: false } }).expect(403);
    const result = await get().expect(200); expect(JSON.stringify(result.body)).not.toContain('secret');
  });
  it('changes only cosmetic bits, preserving permissions, secret placeholders, and siblings', async () => {
    const current = await get();
    await save({ revision: current.body.revision, display: { enabled: false, model: false } }).expect(200);
    const actual = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(actual.authToken).toEqual({ secret: true }); expect(actual.unrelated).toEqual({ preserve: 'yes' });
    expect(actual.messaging[0].config.token).toEqual({ secret: true }); expect(actual.messaging[0].config.messageOrigin.outageNotice.enabled).toBe(false);
    expect(actual.messaging[0].config.messageOrigin.display).toEqual({ enabled: false, model: false, machine: true, harness: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('refuses stale edits and does not overwrite a concurrent config change', async () => {
    const current = await get(), changed = { ...original(), unrelated: { preserve: 'new value' } };
    fs.writeFileSync(file, JSON.stringify(changed));
    await save({ revision: current.body.revision, display: { enabled: false } }).expect(409);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(changed);
  });
  it('detects an external write during staging and cleans its own temporary file', async () => {
    const current = await get(), write = fs.writeFileSync.bind(fs), changed = { ...original(), unrelated: { preserve: 'concurrent' } };
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
      write(target, data, options); if (String(target).endsWith('.tmp')) write(file, JSON.stringify(changed));
    }) as typeof fs.writeFileSync);
    await save({ revision: current.body.revision, display: { enabled: false } }).expect(409);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(changed); expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });
  it('checks the expected display revision inside the real topic lock for queued HTTP writes', async () => {
    const store = new TopicProfileStore({ stateFilePath: path.join(dir, 'profiles.json'), legacyFrameworksPath: path.join(dir, 'frameworks.json'), isDryRun: () => true });
    const resolver = new TopicProfileResolver({ store, defaultFramework: () => 'claude-code', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
      frameworkDefaultModels: () => ({}), tierEscalationConfig: () => undefined, localModelBinding: () => null, frameworkBinaryPath: () => null });
    const surface = new TopicProfileWriteSurface({ store, resolver, regime: () => ({ enabled: false, dryRun: true }), boundOperator: () => ({ platform: 'telegram', uid: '777' }),
      localModelBinding: () => null, legacyFrameworkRespawn: async () => { throw Error('must-not-respawn'); }, disclose: async () => undefined, audit: () => 'fixture' });
    context.topicProfile = { store, resolver, surface }; context.telegram = { getAllTopicMappings: () => [{ topicId: 42, topicName: 'Discussion' }] };
    const current = await get(), revision = current.body.topics[0].revision;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const lock = store.withTopicLock(42, () => held);
    const mutate = vi.spyOn(store, 'mutate');
    const first = save({ topicId: '42', revision, display: { enabled: false } }).then(result => result);
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const second = save({ topicId: '42', revision, display: { enabled: true } }).then(result => result);
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    release(); await lock;
    const results = await Promise.all([first, second]); expect(results.map(result => result.status)).toEqual([200, 409]);
    expect(results[1].body.error).toBe('settings-changed-refresh-required'); expect(store.resolve(42)?.messageOriginDisplay).toEqual({ enabled: false });
  });
  it.each([{ enabled: 'false' }, { enabled: false, token: 'replacement' }, null])('refuses malformed or authority-expanding settings %j', async display => {
    const current = await get(), before = fs.readFileSync(file, 'utf8');
    await save({ revision: current.body.revision, display }).expect(400); expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
