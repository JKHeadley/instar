import fs from 'node:fs';
import request from 'supertest';
import { JSDOM } from 'jsdom';
// @ts-expect-error The shipped console is plain browser JavaScript.
import { renderSchedule } from '../../dashboard/console/schedule.js';
// @ts-expect-error The shipped console is plain browser JavaScript.
import { closeSheet } from '../../dashboard/console/ui.js';
// @ts-expect-error The shipped console is plain browser JavaScript.
import { whenWords } from '../../dashboard/console/schedule-model.js';
import { Cron } from 'croner';
import { describe, expect, it, vi } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { continuityGrace, type JobScheduleObserver } from '../../src/scheduler/JobScheduleObserver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager, waitFor } from '../helpers/setup.js';
import { leaseJobHttpFixture } from '../helpers/lease-job-http.js';

describe('Jobs schedule coverage production lifecycle', () => {
  it('wires a real callback registration and retracts the witness on pause and immediate resume', async () => {
    const f = await leaseJobHttpFixture();
    const slug = 'observer-fixture';
    fs.writeFileSync(f.config.scheduler.jobsFile, JSON.stringify([{
      slug, name: 'Observer fixture', description: 'Cron callback witness', schedule: '* * * * * *',
      enabled: true, priority: 'medium', expectedDurationMinutes: 1, execute: { type: 'prompt', value: 'Fixture' },
    }]));
    f.config.scheduler.enabled = true;
    f.config.jobScheduleCoverage = { enabled: true };
    const sessions = createMockSessionManager() as never;
    const scheduler = new JobScheduler(f.config.scheduler, sessions, f.state, f.stateDir);
    scheduler.setMachineIdentity(f.identity.machineId, 'Local fixture');
    const trigger = vi.spyOn(scheduler, 'triggerJob').mockResolvedValue(undefined);
    const history = vi.spyOn(scheduler, 'getRunHistory');
    const server = new AgentServer({ config: f.config, state: f.state, sessionManager: sessions, scheduler, telegram: null });
    let stopped = false;
    try {
      scheduler.start();
      await server.start();
      const read = () => request(server.getApp()).get('/jobs').set('Authorization', `Bearer ${f.config.authToken}`);
      const registration = scheduler.getScheduleRegistration(slug);
      expect(registration).not.toBeNull();
      const first = await read().expect(200);
      expect(['upcoming', 'due-unknown']).toContain(first.body.jobs[0].scheduleCoverage.state);
      await waitFor(() => trigger.mock.calls.some(([jobSlug, source]) => jobSlug === slug && source === 'scheduled'));
      expect(scheduler.getScheduleRegistration(slug)!.entries).toBeGreaterThan(registration!.entries);
      expect((await read().expect(200)).body.jobs[0].scheduleCoverage.callbackEntered).toBeDefined();
      scheduler.pause();
      expect((await read().expect(200)).body.jobs[0].scheduleCoverage.state).toBe('paused');
      scheduler.resume();
      expect((await read().expect(200)).body.jobs[0].scheduleCoverage.state).toBe('unavailable');
      expect(scheduler.getScheduleRegistration(slug)?.generation).not.toBe(registration!.generation);
      // Existing server supervision may read history; the observer tick and Jobs route do not.
      const priorHistoryCalls = history.mock.calls.length;
      await read().expect(200);
      expect(history).toHaveBeenCalledTimes(priorHistoryCalls);

      const internal = server as unknown as {
        jobScheduleObserver: JobScheduleObserver;
        jobScheduleObserverTimer: ReturnType<typeof setInterval> | null;
      };
      const provider = vi.fn(() => { throw new Error('lease reads are not part of the local observation'); });
      scheduler.setPromotionLeaseProvider(provider);
      internal.jobScheduleObserver.tick();
      expect((await read().expect(200)).body.jobs[0].scheduleCoverage.state).toBe('unavailable');
      expect(provider).not.toHaveBeenCalled();
      scheduler.setPromotionLeaseProvider(null);
      expect(internal.jobScheduleObserverTimer).not.toBeNull();
      scheduler.stop();
      await server.stop();
      stopped = true;
      expect(internal.jobScheduleObserverTimer).toBeNull();
      expect(internal.jobScheduleObserver.read(slug).state).toBe('unavailable');
    } finally {
      scheduler.stop();
      if (!stopped) await server.stop();
      f.coordinator.stop();
      SafeFsExecutor.safeRmSync(f.root, { recursive: true, force: true, operation: 'job-schedule-observation-lifecycle-cleanup' });
    }
  }, 20_000);
  it.each([
    ['suppressed before entry', false],
    ['held after entry', true],
  ])('distinguishes a production registration %s from a missed-run assertion', async (_description, enter) => {
    const f = await leaseJobHttpFixture();
    const slug = 'observer-fault-fixture';
    const schedule = '0 0 1 1 *';
    fs.writeFileSync(f.config.scheduler.jobsFile, JSON.stringify([{
      slug, name: 'Fault fixture', description: 'Production callback fault witness', schedule,
      enabled: true, priority: 'medium', expectedDurationMinutes: 1, execute: { type: 'prompt', value: 'Fixture' },
    }]));
    f.config.scheduler.enabled = true;
    f.config.jobScheduleCoverage = { enabled: true };
    const sessions = createMockSessionManager() as never;
    const scheduler = new JobScheduler(f.config.scheduler, sessions, f.state, f.stateDir);
    scheduler.setMachineIdentity(f.identity.machineId, 'Local fixture');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const trigger = vi.spyOn(scheduler, 'triggerJob').mockImplementation(async () => { await held; });
    const probe = new Cron(schedule, { paused: true });
    const [due, following] = probe.nextRuns(2, new Date('2030-09-01T00:00:00Z')).map(instant => instant.getTime());
    probe.stop();
    let wall = due - 30_000;
    let elapsed = 0;
    const wallSpy = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const monoSpy = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const server = new AgentServer({ config: f.config, state: f.state, sessionManager: sessions, scheduler, telegram: null });
    try {
      scheduler.start();
      await server.start();
      const observer = (server as unknown as { jobScheduleObserver: JobScheduleObserver }).jobScheduleObserver;
      const production = (scheduler as unknown as { cronTasks: Map<string, Cron> }).cronTasks.get(slug)!;
      const read = () => request(server.getApp()).get('/jobs').set('Authorization', `Bearer ${f.config.authToken}`);
      expect((await read().expect(200)).body.jobs[0].scheduleCoverage.nextDueAt).toBe(new Date(due).toISOString());
      wall = due;
      elapsed = 30_000;
      const entry = production as unknown as { fn: () => unknown };
      const original = entry.fn;
      if (!enter) entry.fn = () => undefined;
      const operation = production.trigger();
      entry.fn = original;
      if (!enter) await operation;
      const grace = continuityGrace(following - due);
      observer.tick();
      for (let remaining = grace; remaining > 0;) {
        const step = Math.min(remaining, 30_000);
        remaining -= step;
        wall += step;
        elapsed += step;
        observer.tick();
      }
      const coverage = (await read().expect(200)).body.jobs[0].scheduleCoverage;
      expect(coverage).toMatchObject({
        dueAt: new Date(due).toISOString(),
        state: enter ? 'due-unknown' : 'no-callback-observed',
      });
      expect(scheduler.getScheduleRegistration(slug)?.entries).toBe(enter ? 1 : 0);
      expect(trigger).toHaveBeenCalledTimes(enter ? 1 : 0);
      release();
      await operation;
    } finally {
      release();
      wallSpy.mockRestore();
      monoSpy.mockRestore();
      scheduler.stop();
      await server.stop();
      f.coordinator.stop();
      SafeFsExecutor.safeRmSync(f.root, { recursive: true, force: true, operation: 'job-schedule-observation-fault-cleanup' });
    }
  }, 20_000);

  it('shows the current due occurrence, older witness and recorded run separately on the normal Jobs detail', async () => {
    const dom = new JSDOM('<main></main>', { url: 'https://instar.test/#/work/schedule?job=observer-render' });
    const now = Date.parse('2030-11-24T12:10:00.000Z');
    const dueAt = '2030-11-24T12:00:00.000Z';
    const nextDueAt = '2030-11-24T13:00:00.000Z';
    const earlierDue = '2030-11-23T12:00:00.000Z';
    const lastRun = '2030-11-22T12:00:00.000Z';
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('location', dom.window.location);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const jobs = [{
        slug: 'observer-render', name: 'Schedule observer render', enabled: true, schedule: '0 * * * *', origin: 'user',
        state: { lastRun, lastResult: 'success', nextScheduled: '2030-11-24T14:00:00.000Z' },
        scheduleCoverage: {
          state: 'due-unknown', dueAt, observedAt: new Date(now).toISOString(), nextDueAt,
          previousWitness: { state: 'due-unknown', dueAt: earlierDue, observedAt: '2030-11-23T12:30:00.000Z' },
          callbackEntered: { from: '2030-11-23T14:00:00.000Z', through: '2030-11-23T14:01:00.000Z' },
        },
      }];
      await renderSchedule(dom.window.document.querySelector('main'), {
        get: async (url: string) => ({ ok: true, data: url === '/jobs' ? { jobs } : {} }),
      });
      const facts = Object.fromEntries([...dom.window.document.querySelectorAll('.story dt')]
        .map(term => [term.textContent, term.nextElementSibling?.textContent]));
      expect(facts['Schedule coverage']).toBe(
        `The schedule came due ${whenWords(Date.parse(dueAt), now)}. The available records do not establish what happened. Last checked ${whenWords(now, now)}.`,
      );
      expect(facts['Next scheduled time observed']).toBe(whenWords(Date.parse(nextDueAt), now));
      expect(facts['Previous schedule observation']).toContain(`came due ${whenWords(Date.parse(earlierDue), now)}`);
      expect(facts['Callback entry']).toMatch(/entered between.*Its scheduled time is unknown/);
      expect(facts['Last run']).toContain(whenWords(Date.parse(lastRun), now));
      expect(facts['Next run']).toContain(whenWords(Date.parse(jobs[0].state.nextScheduled), now));
    } finally {
      closeSheet();
      wall.mockRestore();
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });

});
