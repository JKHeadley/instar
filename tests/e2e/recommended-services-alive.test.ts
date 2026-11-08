/**
 * Production-path proof (docs/specs/recommended-services.md, Testing): AgentServer serves the
 * ledger it is given, the route answers 200 not 503, a no reaches the ledger through the real PIN
 * check, and it survives a restart. With no ledger the route answers 503.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_e2e', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_e2e', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const AUTH = 'e2e-token';
const PIN = '123456';

function boot(withLedger: boolean, extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'rec-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'rec-e2e', projectDir: dir, stateDir, port: 0, host: '127.0.0.1', version: '0.0.0', authToken: AUTH, dashboardPin: PIN,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, ...extra,
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const makeLedger = () => new RecommendedServicesLedger({ stateDir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
  const server = new AgentServer({
    config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir),
    ...(withLedger ? { recommendedServicesLedger: makeLedger() } : {}),
  } as any);
  servers.push(server);
  return { server, makeLedger };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/recommended-services-alive.test.ts' });
});

describe('recommended services: production wiring', () => {
  it('is alive: 200, a no through the real PIN check, and it survives a restart', async () => {
    const { server, makeLedger } = boot(true);
    const app = server.getApp();
    const list = await request(app).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(list.status).toBe(200);
    expect(list.body.offersLive).toBe(false);
    expect(list.body).toMatchObject({ migrationComplete: false, firstResult: null });
    const jev = list.body.services.find((row: { service: string }) => row.service === 'jev');
    // The six live-proven recipes are available on every agent, with no proving list; the other three are not.
    expect(jev).toMatchObject({ name: 'Jev (TypeSafe)', backupStatus: 'specified', choice: 'unset', available: true });
    expect(list.body.services.filter((row: { available: boolean }) => row.available).map((row: { service: string }) => row.service)).toEqual(['tailscale', 'jev', 'bitwarden', 'github-state-backup', 'second-ai-door', 'voice-transcription']);

    const noPin = await request(app).post('/recommended-services/jev/no').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(noPin.status).toBe(403);

    const no = await request(app).post('/recommended-services/jev/no').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({ pin: PIN, reason: 'cost' });
    expect(no.status).toBe(200);
    expect(no.body).toMatchObject({ choice: 'no', reason: 'cost' });
    expect(makeLedger().effective('jev').choice).toBe('no');

    // No token is needed to reach the confirm route. A service with no proven setup refuses a yes outright.
    const unproven = await request(app).get('/recommended-services/cloudflare-domain/confirm');
    expect(unproven.status).toBe(409);
    expect(unproven.body.error).toBe('not-available');
    // Jev's page is reachable through the real wiring; with no verified owner on this bare server it stops at that, never at "not available".
    const page = await request(app).get('/recommended-services/jev/confirm');
    expect([200, 409]).toContain(page.status);
    if (page.status === 409) expect(page.body.error).toBe('no-owner');
    const yes = await request(app).post('/recommended-services/jev/confirm').set('X-Instar-Request', '1').send({ token: 'forged', pin: PIN, answer: 'yes' });
    expect(yes.status).toBe(409);
    expect(makeLedger().effective('jev').choice).toBe('no');
    // Verifying Jev gets past "no recipe" and stops at the missing yes; an unproven service has no recipe to verify.
    const verify = await request(app).post('/recommended-services/jev/verify').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(verify.status).toBe(409);
    expect(verify.body.error).toBe('not-granted-here');
    const noRecipe = await request(app).post('/recommended-services/cloudflare-domain/verify').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(noRecipe.body.error).toBe('no-recipe');
    const pageFile = await request(app).get('/dashboard/service-yes');
    expect(pageFile.status).toBe(200);
    expect(pageFile.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('answers 503 rather than pretending when this machine has no ledger', async () => {
    const { server } = boot(false);
    const res = await request(server.getApp()).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
  });

  it('the key route stores nothing on a fleet agent without a yes, and nothing at all for an unproven service', async () => {
    const { server } = boot(true);
    const res = await request(server.getApp()).post('/recommended-services/jev/key')
      .set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').type('text/plain').send('a-key');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not-granted-here');
    const unproven = await request(server.getApp()).post('/recommended-services/cloudflare-domain/key')
      .set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').type('text/plain').send('a-key');
    expect(unproven.status).toBe(404);
    expect(unproven.body.error).toBe('no-recipe');
  });

  it('the hold route works for a proven service and refuses an unproven one', async () => {
    const { server } = boot(true);
    const held = await request(server.getApp()).post('/recommended-services/jev/hold')
      .set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(held.status).toBe(200);
    expect(held.body.held).toBe(true);
    const res = await request(server.getApp()).post('/recommended-services/cloudflare-domain/hold')
      .set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no-recipe');
  });

  it('the Bitwarden recipe is live on every agent: the copy route stops at the missing yes, a service without a copy has no such route', async () => {
    const { server } = boot(true);
    const app = server.getApp();
    const list = await request(app).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(list.body.services.find((row: { service: string }) => row.service === 'bitwarden').available).toBe(true);
    const sync = await request(app).post('/recommended-services/bitwarden/sync').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(sync.status).toBe(409);
    expect(sync.body.error).toBe('not-granted-here');
    const noCopy = await request(app).post('/recommended-services/jev/sync').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(noCopy.status).toBe(409);
    expect(noCopy.body.error).toBe('no-copy-for-this-service');
    // The page names what would be copied, as names, through the real vault and config.
    const page = await request(app).get('/recommended-services/bitwarden/confirm');
    if (page.status === 200) expect(Array.isArray(page.body.copies)).toBe(true);
    else expect(page.body.error).toBe('no-owner');
  });

  it('the GitHub backup recipe is available on a fleet agent through the real wiring, and its push stops at the missing yes', async () => {
    const { server } = boot(true);
    const app = server.getApp();
    const list = await request(app).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(list.body.services.find((row: { service: string }) => row.service === 'github-state-backup')).toMatchObject({ available: true, choice: 'unset' });
    // The push route is wired (past "no-recipe") and stops at the missing yes; nothing reaches GitHub without one.
    const sync = await request(app).post('/recommended-services/github-state-backup/sync').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(sync.status).toBe(409);
    expect(sync.body.error).toBe('not-granted-here');
    // The confirm page is the public yes/no surface; with no verified owner on this bare server it stops at that, never at "not available".
    const page = await request(app).get('/recommended-services/github-state-backup/confirm');
    expect([200, 409]).toContain(page.status);
    if (page.status === 409) expect(page.body.error).toBe('no-owner');
    else expect(page.body.copies).toBeUndefined();
  });

  it('the voice transcription recipe is available on a fleet agent through the real wiring, and its key route stops at the missing yes', async () => {
    const { server } = boot(true);
    const app = server.getApp();
    const list = await request(app).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(list.body.services.find((row: { service: string }) => row.service === 'voice-transcription')).toMatchObject({ available: true, choice: 'unset' });
    const key = await request(app).post('/recommended-services/voice-transcription/key')
      .set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').type('text/plain').send('gsk_example');
    expect(key.status).toBe(409);
    expect(key.body.error).toBe('not-granted-here');
  });

  it('the second AI subscription recipe is available through the real wiring, and its server step stops at the missing yes', async () => {
    const { server } = boot(true);
    const app = server.getApp();
    const list = await request(app).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(list.body.services.find((row: { service: string }) => row.service === 'second-ai-door')).toMatchObject({ available: true, choice: 'unset' });
    const sync = await request(app).post('/recommended-services/second-ai-door/sync').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(sync.status).toBe(409);
    expect(sync.body.error).toBe('not-granted-here');
  });

  it('an agent proving a recipe (a throwaway under a temp folder) reaches it through the real wiring, beside the proven ones', async () => {
    const { server } = boot(true, { recommendedServices: { provingRecipes: ['tailscale-v1'] } });
    const app = server.getApp();
    const list = await request(app).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(list.status).toBe(200);
    expect(list.body.offersLive).toBe(false);
    expect(list.body.services.filter((row: { available: boolean }) => row.available).map((row: { service: string }) => row.service)).toEqual(['tailscale', 'jev', 'bitwarden', 'github-state-backup', 'second-ai-door', 'voice-transcription']);
    // The recipe is wired: verify gets past "no-recipe" and stops at the missing yes.
    const verify = await request(app).post('/recommended-services/tailscale/verify').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(verify.status).toBe(409);
    expect(verify.body.error).toBe('not-granted-here');
    const key = await request(app).post('/recommended-services/tailscale/key')
      .set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').type('text/plain').send('tskey-auth-example');
    expect(key.status).toBe(409);
  });

  it('refuses to surface a retired offer', async () => {
    const { server } = boot(true);
    const res = await request(server.getApp()).post('/features/git-backup/surface').set('Authorization', `Bearer ${AUTH}`).send({ trigger: 't' });
    expect(res.status).toBe(409);
  });
});
