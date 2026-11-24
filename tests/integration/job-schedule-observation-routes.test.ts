import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobScheduleObserver } from '../../src/scheduler/JobScheduleObserver.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { leaseJobHttpFixture } from '../helpers/lease-job-http.js';

describe('Jobs HTTP schedule coverage', () => {
  let fixture: Awaited<ReturnType<typeof leaseJobHttpFixture>>;
  beforeEach(async () => { fixture = await leaseJobHttpFixture(); });
  afterEach(() => {
    fixture.coordinator.stop();
    SafeFsExecutor.safeRmSync(fixture.root, { recursive: true, force: true, operation: 'job-schedule-observation-routes-cleanup' });
  });
  it('keeps cached pool observation local and discards a peer claim without machine proof', async () => {
    const job = { slug: 'hourly', enabled: true, schedule: '0,20,40 * * * *' };
    const jobs = [job];
    const registration = { schedule: job.schedule, generation: '1', entries: 0 };
    const clock = Date.parse('2026-11-24T00:19:30Z');
    let elapsed = 0;
    let unavailable = false;
    const observer = new JobScheduleObserver({
      list: () => jobs, registration: () => {
        if (unavailable) throw new Error('fixture registration temporarily unavailable');
        return { ...registration };
      },
      wall: () => clock + elapsed, monotonic: () => elapsed,
    });
    for (let tick = 0; tick <= 21; tick++) {
      elapsed = 30_000 * tick;
      observer.tick();
    }
    const ctx = {
      config: { ...fixture.config, authToken: 'fixture' },
      state: fixture.state,
      scheduler: { getNextRunTimes: () => ({}), getJobs: () => jobs, isJobLocal: () => true, isScheduleObservationPaused: () => false },
      sessionManager: { listRunningSessions: () => [] }, startTime: new Date(),
      meshSelfId: 'local', resolvePeerUrls: () => [{ machineId: 'peer' }],
      poolPollCache: {
        fetchPeer: async () => ({ body: { jobs: [{ ...job, machineId: 'local', scheduleCoverage: observer.read(job.slug) }] } }),
      },
      jobScheduleObserver: observer,
    } as unknown as RouteContext;
    const app = express();
    app.use(authMiddleware('fixture'));
    app.use(createRoutes(ctx));
    await request(app).get('/jobs').expect(401);
    const query = () => request(app).get('/jobs?scope=pool').set('Authorization', 'Bearer fixture');
    const first = await query().expect(200);
    expect(first.body.jobs).toMatchObject([
      { machineId: 'local', scheduleCoverage: { state: 'no-callback-observed' } },
      { machineId: 'peer', remote: true, scheduleCoverage: { state: 'unavailable', reason: 'peer-unverified' } },
    ]);
    registration.entries++;
    const afterEntry = await query().expect(200);
    expect(afterEntry.body.jobs[0].scheduleCoverage.state).toBe('due-unknown');
    unavailable = true;
    const afterThrow = await query().expect(200);
    expect(afterThrow.body.jobs[0]).toMatchObject({ slug: job.slug, enabled: true, scheduleCoverage: { state: 'unavailable' } });
    unavailable = false;
    expect((await query().expect(200)).body.jobs[0].scheduleCoverage.state).toBe('unavailable');
    observer.tick();
    expect((await query().expect(200)).body.jobs[0].scheduleCoverage.state).toBe('upcoming');
    registration.generation = '2';
    const afterReload = await query().expect(200);
    expect(afterReload.body.jobs[0].scheduleCoverage.state).toBe('unavailable');
  });
});
