import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { leaseJobHttpFixture } from '../helpers/lease-job-http.js';
import { installPortableHttpJob } from '../helpers/portable-job-http.js';

describe('private job transfer HTTP authorization', () => {
  let fixture: Awaited<ReturnType<typeof leaseJobHttpFixture>>;
  let ctx: RouteContext;
  afterEach(() => {
    ctx?.jobCoverageStop?.();
    fixture?.coordinator.stop();
    if (fixture) SafeFsExecutor.safeRmSync(fixture.root, { recursive: true, force: true, operation: 'job-portable-routes-cleanup' });
  });
  async function mount(enabled: boolean) {
    fixture = await leaseJobHttpFixture();
    if (enabled) installPortableHttpJob(fixture);
    ctx = { config: fixture.config, state: fixture.state, coordinator: fixture.coordinator,
      meshSelfId: fixture.identity.machineId, scheduler: null, telegram: null,
      startTime: new Date(), currentInboundByTopic: new Map(), resolvePeerUrls: () => [],
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(fixture.config.authToken!));
    app.use(createRoutes(ctx));
    return app;
  }
  it('stays unavailable until opted in', async () => {
    const app = await mount(false);
    const response = await request(app).get('/jobs/portable/export/portable-http')
      .set('Authorization', `Bearer ${fixture.config.authToken}`);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('portable-sync-unavailable');
  });
  it('requires auth, a local PIN and the exact previewed root for export consent', async () => {
    const app = await mount(true);
    const url = '/jobs/portable/export/portable-http';
    const auth = { Authorization: `Bearer ${fixture.config.authToken}` };
    expect((await request(app).get(url)).status).toBe(401);
    const preview = await request(app).get(url).set(auth);
    expect(preview.status).toBe(200);
    expect(preview.body.root).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.body.files).toHaveLength(2);
    expect(JSON.stringify(preview.body)).not.toContain('Portable private body');
    expect((await request(app).post(url + '/approve').set(auth).send({ root: preview.body.root })).status).toBe(403);
    expect((await request(app).post(url + '/approve').set(auth)
      .send({ root: '0'.repeat(64), pin: fixture.config.dashboardPin })).status).toBe(409);
    expect((await request(app).post(url + '/approve').set(auth)
      .send({ root: preview.body.root, pin: fixture.config.dashboardPin })).status).toBe(200);
    expect((await request(app).post('/jobs/portable-bundle').set(auth).send({})).status).toBe(403);
  });
  it('refuses activation in preview mode before any files can be installed', async () => {
    const app = await mount(true);
    fixture.config.multiMachine!.jobDefinitionSync!.dryRun = true;
    const response = await request(app).post('/jobs/portable/import/m_source/portable-http/approve')
      .set('Authorization', `Bearer ${fixture.config.authToken}`)
      .send({ root: 'a'.repeat(64), pin: fixture.config.dashboardPin });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('portable-sync-preview-only');
  });
});
