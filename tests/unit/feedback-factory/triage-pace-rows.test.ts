/**
 * Queue pace tick rows from the triage service (docs/specs/queue-pace.md §2): one server-written
 * row per tick attempt — `tick` rows with decided/calls/stopReason/queueDepthAfter, `refused`
 * rows for acceptTick's rate-limited / tick-in-flight / not-canonical-owner — plus the live
 * quotaStatus() and callsUsedToday() accessors the tuner reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../../fixtures/feedbackTriageHarness.js';

let h: Harness;
afterEach(() => h?.cleanup());

type Row = Record<string, unknown>;

describe('triage → queue pace tick rows', () => {
  it('a tick that ran writes one tick row; a quota pause is a tick row with stopReason quota-pause', async () => {
    const rows: Row[] = [];
    h = await createHarness({ paceTicks: { append: (r) => { rows.push(r); } } });
    await h.addItem('a');
    await h.addItem('b');
    const result = await h.service.tick();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'triage', kind: 'tick', runId: result.runId, decided: result.decided, calls: result.calls, stopReason: result.reason ?? null });
    expect(rows[0].queueDepthAfter).toBe(Math.max(0, 2 - result.decided));
    h.quota.value = 90;
    h.now.value += 31_000;
    await h.service.tick();
    expect(rows[1]).toMatchObject({ kind: 'tick', stopReason: 'quota-pause', decided: 0 });
  });

  it('acceptTick refusals are refused rows (rate-limited)', async () => {
    const rows: Row[] = [];
    h = await createHarness({ paceTicks: { append: (r) => { rows.push(r); } } });
    const first = h.service.acceptTick();
    expect(first.status).toBe(202);
    const busy = h.service.acceptTick();
    expect(busy.body.error).toBe('tick-in-flight');
    expect(rows.find((r) => r.kind === 'refused')).toMatchObject({ source: 'triage', reason: 'tick-in-flight' });
    await new Promise((r) => setTimeout(r, 50));
    const limited = h.service.acceptTick();
    expect(limited.body.error).toBe('rate-limited');
    expect(rows.filter((r) => r.kind === 'refused').map((r) => r.reason)).toEqual(['tick-in-flight', 'rate-limited']);
  });

  it('no sink → no rows and no behaviour change', async () => {
    h = await createHarness();
    await h.addItem('a');
    const result = await h.service.tick();
    expect(result.runId).toMatch(/^triage-run:/);
  });

  it('quotaStatus reads the live percentage; callsUsedToday reads the authority accounting', async () => {
    h = await createHarness();
    h.quota.value = 42;
    expect(await h.service.quotaStatus()).toEqual({ usedPercent: 42, pauseThreshold: 75 });
    expect(h.service.callsUsedToday()).toBe(0);
    await h.addItem('a');
    const result = await h.service.tick();
    expect(h.service.callsUsedToday()).toBe(result.calls);
    expect(h.service.maxCallsPerDay()).toBe(150);
  });

  it('no authority → quota unreadable and calls unknown', async () => {
    h = await createHarness({ approve: false });
    expect(await h.service.quotaStatus()).toEqual({ usedPercent: null, pauseThreshold: 75 });
    expect(h.service.callsUsedToday()).toBeNull();
  });
});
