import { describe, expect, it } from 'vitest';
import { JobScheduleObserver } from '../../src/scheduler/JobScheduleObserver.js';
import { scheduleCoverageWords } from '../../dashboard/console/schedule-model.js';

const MINUTE = 60_000;

function fixture(total = 1, start = Date.parse('2026-11-24T00:19:30Z')) {
  let elapsed = 0;
  const jobs = Array.from({ length: total }, (_, index) => ({ slug: String(index) }));
  const registration = { schedule: '0,20,40 * * * *', generation: '1:local', entries: 0 };
  const observer = new JobScheduleObserver({
    list: () => jobs, registration: () => ({ ...registration }),
    wall: () => start + elapsed, monotonic: () => elapsed,
  });
  return {
    observer, registration,
    tick() { observer.tick(); },
    travel(ms: number) {
      for (let remaining = ms; remaining > 0;) {
        const step = Math.min(30_000, remaining);
        elapsed += step;
        remaining -= step;
        observer.tick();
      }
    },
    pass(ms: number) { elapsed += ms; },
  };
}

describe('independent schedule observation', () => {
  it('shows timed absence only after a real Croner due window and withdraws it on late entry', () => {
    const f = fixture();
    f.tick();
    expect(f.observer.read('0')).toMatchObject({ state: 'upcoming', nextDueAt: '2026-11-24T00:20:00.000Z' });
    f.travel(10 * MINUTE + 30_000);
    const observed = f.observer.read('0');
    expect(observed).toMatchObject({ state: 'no-callback-observed', dueAt: '2026-11-24T00:20:00.000Z' });
    expect(scheduleCoverageWords(observed)).toContain('No scheduled callback observed by');
    expect(scheduleCoverageWords(observed)).not.toMatch(/failed|missed run/i);
    f.registration.entries++;
    const lateEntry = f.observer.read('0');
    expect(lateEntry).toMatchObject({ state: 'due-unknown', callbackEntered: expect.any(Object) });
    expect(scheduleCoverageWords(lateEntry)).toMatch(/came due.*available records.*Last checked/);
  });

  it('does not let a delayed callback from one opportunity establish the next', () => {
    const f = fixture();
    f.tick();
    f.travel(10 * MINUTE + 30_000);
    f.travel(11 * MINUTE);
    f.registration.entries++;
    f.travel(9 * MINUTE);
    expect(f.observer.read('0')).toMatchObject({
      state: 'due-unknown', dueAt: '2026-11-24T00:40:00.000Z', callbackEntered: expect.any(Object),
    });
  });

  it('invalidates an old witness immediately on a registration generation change', () => {
    const f = fixture();
    f.tick();
    f.travel(10 * MINUTE + 30_000);
    f.registration.generation = '2:local';
    expect(f.observer.read('0')).toEqual({ state: 'unavailable', reason: 'unverified-registration' });
  });

  it('distinguishes row aging in a progressing sweep from a stopped watcher', () => {
    const f = fixture(320);
    f.tick();
    const original = f.observer.read('0').observedAt;
    f.travel(4 * MINUTE);
    expect(f.observer.read('0')).toEqual({ state: 'stale', reason: 'row-stale', observedAt: original });
    f.pass(61_000);
    expect(f.observer.read('0')).toEqual({ state: 'stale', reason: 'observer-stale', observedAt: original });
  });
  it('withdraws the old witness across the local daylight-saving fold', () => {
    const priorTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const before = Date.parse('2026-11-01T05:59:30Z');
      const f = fixture(1, before);
      f.tick();
      expect(f.observer.read('0').state).toBe('upcoming');
      expect(new Date(before).getTimezoneOffset()).not.toBe(new Date(before + 30_000).getTimezoneOffset());
      f.pass(30_000);
      expect(f.observer.read('0')).toMatchObject({ state: 'stale', reason: 'observer-stale' });
    } finally {
      if (priorTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimezone;
    }
  });

  it('reports a witnessed due time as unknown before grace when no earlier witness exists', () => {
    const f = fixture();
    f.tick();
    f.pass(30_000);
    expect(f.observer.read('0')).toMatchObject({
      state: 'due-unknown', dueAt: '2026-11-24T00:20:00.000Z',
      observedAt: '2026-11-24T00:20:00.000Z', nextDueAt: '2026-11-24T00:40:00.000Z',
    });
  });

  it('dates an unexhausted newer observation independently of the preceding witness', () => {
    const f = fixture();
    f.tick();
    f.travel(30 * MINUTE);
    f.pass(30_000);
    expect(f.observer.read('0')).toMatchObject({
      state: 'due-unknown', dueAt: '2026-11-24T00:40:00.000Z', observedAt: '2026-11-24T00:50:00.000Z',
      previousWitness: { dueAt: '2026-11-24T00:20:00.000Z', observedAt: '2026-11-24T00:30:00.000Z' },
    });
  });

});
