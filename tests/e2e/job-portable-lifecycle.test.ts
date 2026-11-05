import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makePortableBundleRequest, acceptPortableBundleWire } from '../../src/core/JobPortableBundle.js';
import { leaseJobHttpFixture } from '../helpers/lease-job-http.js';
import { installPortableHttpJob } from '../helpers/portable-job-http.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
import { verifyImportedPortableJob } from '../../src/core/JobPortableIntegrity.js';

describe('private job transfer production initialization', () => {
  const fixtures: Awaited<ReturnType<typeof leaseJobHttpFixture>>[] = [];
  let server: AgentServer;
  let destinationServer: AgentServer;
  afterEach(async () => {
    await destinationServer?.stop();
    await server?.stop();
    for (const fixture of fixtures.splice(0)) {
      fixture.coordinator.stop();
      SafeFsExecutor.safeRmSync(fixture.root, { recursive: true, force: true, operation: 'job-portable-lifecycle-cleanup' });
    }
  });
  it('wires a live source that delivers only approved, signed and recipient-encrypted bytes and refuses replay', async () => {
    const source = await leaseJobHttpFixture();
    fixtures.push(source);
    const recipient = await leaseJobHttpFixture();
    fixtures.push(recipient);
    installPortableHttpJob(source);
    source.identityManager.registerMachine(recipient.identity, 'standby');
    source.identityManager.storeRemoteIdentity(recipient.identity);
    server = new AgentServer({ config: source.config, state: source.state,
      coordinator: source.coordinator, meshSelfId: source.identity.machineId,
      sessionManager: createMockSessionManager() as never, telegram: null,
      resolvePeerUrls: () => [],
    });
    const app = server.getApp();
    const auth = { Authorization: `Bearer ${source.config.authToken}` };
    const preview = await request(app).get('/jobs/portable/export/portable-http').set(auth);
    expect(preview.status).toBe(200);
    const signedRequest = makePortableBundleRequest(source.identity.machineId, recipient.identity.machineId,
      'portable-http', 'e'.repeat(64), recipient.identityManager.loadSigningKey());
    const approval = await request(app).post('/jobs/portable/export/portable-http/approve').set(auth)
      .send({ root: preview.body.root, pin: source.config.dashboardPin });
    expect(approval.status).toBe(200);
    const response = await request(app).post('/jobs/portable-bundle').set(auth).send(signedRequest);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('Portable private body');
    const sourceKey = source.identityManager.getSigningPublicKeyPem(source.identity.machineId)!;
    const opened = acceptPortableBundleWire(response.body, signedRequest, sourceKey, recipient.identityManager.loadEncryptionKey());
    expect(opened.root).toBe(preview.body.root);
    expect(opened.files.map(file => file.path)).toContain('.instar/jobs/user/portable-http.md');
    expect(() => acceptPortableBundleWire(response.body, signedRequest, sourceKey, source.identityManager.loadEncryptionKey())).toThrow();
    const replay = await request(app).post('/jobs/portable-bundle').set(auth).send(signedRequest);
    expect(replay.status).toBe(403);
    expect(replay.body.error).toBe('portable-bundle-refused');
  });
  it('stages through the live peer monitor at a hexadecimal counter and activates only after destination approval', async () => {
    const source = await leaseJobHttpFixture();
    fixtures.push(source);
    const destination = await leaseJobHttpFixture();
    fixtures.push(destination);
    installPortableHttpJob(source);
    destination.config.multiMachine = { jobDefinitionSync: { enabled: true, dryRun: false } };
    source.identityManager.registerMachine(destination.identity, 'standby');
    source.identityManager.storeRemoteIdentity(destination.identity);
    destination.identityManager.registerMachine(source.identity, 'awake');
    destination.identityManager.storeRemoteIdentity(source.identity);
    // The next real snapshot starts at a hex-letter counter; no synthetic peer response.
    fs.writeFileSync(path.join(source.stateDir, 'state', 'job-coverage-generation.json'),
      JSON.stringify({ counter: 9, digest: '0'.repeat(64) }));
    server = new AgentServer({ config: source.config, state: source.state,
      coordinator: source.coordinator, meshSelfId: source.identity.machineId,
      sessionManager: createMockSessionManager() as never, telegram: null, resolvePeerUrls: () => [],
    });
    await server.start();
    const auth = { Authorization: `Bearer ${source.config.authToken}` };
    const preview = await request(server.getApp()).get('/jobs/portable/export/portable-http').set(auth);
    expect(preview.status).toBe(200);
    expect((await request(server.getApp()).post('/jobs/portable/export/portable-http/approve').set(auth)
      .send({ root: preview.body.root, pin: source.config.dashboardPin })).status).toBe(200);
    destinationServer = new AgentServer({ config: destination.config, state: destination.state,
      coordinator: destination.coordinator, meshSelfId: destination.identity.machineId,
      sessionManager: createMockSessionManager() as never, telegram: null,
      resolvePeerUrls: () => [{ machineId: source.identity.machineId, url: boundAgentServerBase(server), kind: 'lan' }],
    });
    await destinationServer.start();
    const importUrl = `/jobs/portable/import/${source.identity.machineId}/portable-http`;
    const deadline = Date.now() + 20_000;
    let staged = await request(destinationServer.getApp()).get(importUrl).set(auth);
    while (staged.status === 404 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      staged = await request(destinationServer.getApp()).get(importUrl).set(auth);
    }
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    expect(staged.body.root).toBe(preview.body.root);
    const manifest = path.join(destination.stateDir, 'jobs', 'schedule', 'portable-http.json');
    expect(fs.existsSync(manifest)).toBe(false);
    expect((await request(destinationServer.getApp()).post(importUrl + '/approve').set(auth)
      .send({ root: staged.body.root })).status).toBe(403);
    const approved = await request(destinationServer.getApp()).post(importUrl + '/approve').set(auth)
      .send({ root: staged.body.root, pin: destination.config.dashboardPin });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(fs.existsSync(manifest)).toBe(true);
    expect(verifyImportedPortableJob(destination.stateDir, destination.root, 'portable-http')).toBe(true);
    fs.writeFileSync(path.join(destination.stateDir, 'jobs', 'user', 'portable-http.md'), 'local drift');
    expect(verifyImportedPortableJob(destination.stateDir, destination.root, 'portable-http')).toBe(false);
  });
});
