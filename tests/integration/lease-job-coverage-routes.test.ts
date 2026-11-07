import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
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

  it('uses the on-disk catalog when scheduler settings are absent', async () => {
    fixture = await leaseJobHttpFixture();
    fixture.config.scheduler = undefined as never;
    ctx = { config: fixture.config, state: fixture.state, coordinator: fixture.coordinator,
      meshSelfId: fixture.identity.machineId, scheduler: null, telegram: null,
      startTime: new Date(), currentInboundByTopic: new Map(), resolvePeerUrls: () => [],
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(fixture.config.authToken!));
    app.use(createRoutes(ctx));
    const response = await request(app).get('/jobs/coverage-snapshot?nonce=' + 'd'.repeat(64))
      .set('Authorization', `Bearer ${fixture.config.authToken}`);
    expect(response.status).toBe(200);
    expect(response.body.complete).toBe(true);
  });

  it('keeps other routes alive when the coordinator has no identity manager', async () => {
    fixture = await leaseJobHttpFixture();
    ctx = { config: fixture.config, state: fixture.state,
      coordinator: { enabled: false, getSyncStatus: () => ({ holdsLease: false }) },
      meshSelfId: fixture.identity.machineId, scheduler: null, telegram: null,
      startTime: new Date(), currentInboundByTopic: new Map(), resolvePeerUrls: () => [],
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(fixture.config.authToken!));
    app.use(createRoutes(ctx));
    const response = await request(app).get('/jobs/coverage-snapshot?nonce=' + 'd'.repeat(64))
      .set('Authorization', `Bearer ${fixture.config.authToken}`);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('job-coverage-unavailable');
  });

  it('serves coverage and shuts down when a coordinator adapter has identity but no role-event methods', async () => {
    fixture = await leaseJobHttpFixture();
    ctx = { config: fixture.config, state: fixture.state,
      coordinator: { managers: fixture.coordinator.managers, isAwake: false },
      meshSelfId: fixture.identity.machineId, scheduler: null, telegram: null,
      startTime: new Date(), currentInboundByTopic: new Map(), resolvePeerUrls: () => [],
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(fixture.config.authToken!));
    app.use(createRoutes(ctx));
    const response = await request(app).get('/jobs/coverage-snapshot?nonce=' + 'e'.repeat(64))
      .set('Authorization', `Bearer ${fixture.config.authToken}`);
    expect(response.status).toBe(200);
    expect(() => ctx.jobCoverageStop?.()).not.toThrow();
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
    app.use(authMiddleware(fixture.config.authToken!));
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
