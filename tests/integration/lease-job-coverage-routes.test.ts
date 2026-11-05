import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { acceptJobCoverage } from '../../src/core/JobCoverage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { leaseJobHttpFixture } from '../helpers/lease-job-http.js';

describe('lease coverage real HTTP routes', () => {
  let fixture: Awaited<ReturnType<typeof leaseJobHttpFixture>>;
  let ctx: RouteContext;
  afterEach(() => {
    ctx?.jobCoverageStop?.();
    fixture?.coordinator.stop();
    if (fixture) SafeFsExecutor.safeRmSync(fixture.root, { recursive: true, force: true, operation: 'lease-job-coverage-routes-cleanup' });
  });

  it('serves a signed nonce-bound catalog on scheduler-less standby and enforces authentication', async () => {
    fixture = await leaseJobHttpFixture();
    ctx = {
      config: fixture.config, state: fixture.state, coordinator: fixture.coordinator,
      meshSelfId: fixture.identity.machineId, scheduler: null, telegram: null,
      startTime: new Date(), currentInboundByTopic: new Map(), resolvePeerUrls: () => [],
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    expect((await request(app).get('/jobs/coverage-snapshot?nonce=' + 'a'.repeat(64))).status).toBe(401);
    expect((await request(app).get('/jobs/coverage-snapshot?nonce=bad')
      .set('Authorization', `Bearer ${fixture.config.authToken}`)).status).toBe(400);
    const response = await request(app).get('/jobs/coverage-snapshot?nonce=' + 'a'.repeat(64))
      .set('Authorization', `Bearer ${fixture.config.authToken}`);
    expect(response.status).toBe(200);
    const key = fixture.identityManager.getSigningPublicKeyPem(fixture.identity.machineId)!;
    expect(acceptJobCoverage(response.body, fixture.identity.machineId, 'a'.repeat(64), key))
      .toMatchObject({ complete: true, machineId: fixture.identity.machineId, jobs: [] });
    expect(acceptJobCoverage(response.body, fixture.identity.machineId, 'b'.repeat(64), key)).toBeNull();
    expect(ctx.jobCoverageStop).toBeTypeOf('function');
  });
});
