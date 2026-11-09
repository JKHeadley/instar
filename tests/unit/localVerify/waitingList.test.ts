// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 tests for the WaitingList module (fb-7fde7f49-8ee): order, liveness, the clock
 * stopping while `main` is unhealthy, the bounded size, and the heartbeat-based restore.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { WaitingList, WAITING_LIST_LIMITS } from '../../../src/localVerify/waitingList.js';

const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'waitingList.test.ts' }); });

function make(file?: string, start = 1_000_000_000_000) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvwl-')));
  dirs.push(dir);
  let t = start;
  const audits: Array<Record<string, unknown>> = [];
  const f = file ?? path.join(dir, 'waiting.json');
  const list = new WaitingList(f, () => t, (e) => audits.push(e));
  return { list, file: f, audits, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe('WaitingList', () => {
  it('orders by first refusal and keeps it across repeat refusals', () => {
    const w = make();
    w.list.refused(7);
    w.advance(MIN);
    w.list.refused(3);
    w.advance(MIN);
    w.list.refused(7);
    expect(w.list.list().map((x) => [x.pr, x.refusals])).toEqual([[7, 2], [3, 1]]);
    expect(w.list.liveAhead(3).map((x) => x.pr)).toEqual([7]);
    expect(w.list.liveAhead(7)).toEqual([]);
    expect(w.list.liveAhead(99).map((x) => x.pr)).toEqual([7, 3]);
  });

  it('a waiter not offered within the stale window is never ahead of anyone', () => {
    const w = make();
    w.list.refused(1);
    w.advance(WAITING_LIST_LIMITS.staleAfterMs + 1);
    expect(w.list.liveAhead(2)).toEqual([]);
    w.list.refused(1); // offered again: live again, same place
    expect(w.list.liveAhead(2).map((x) => x.pr)).toEqual([1]);
  });

  it('the clock stops while main is unhealthy', () => {
    const w = make();
    w.list.refused(1);
    w.advance(10 * MIN);
    w.list.setHealthy(false);
    w.advance(5 * 60 * MIN);
    expect(w.list.list()[0].live).toBe(true);
    w.list.setHealthy(true);
    expect(w.list.list()[0].live).toBe(true);
    w.advance(WAITING_LIST_LIMITS.staleAfterMs - 10 * MIN + 1);
    expect(w.list.list()[0].live).toBe(false);
  });

  it('a waiter refused during the pause is never stamped in the future when main recovers', () => {
    const w = make();
    w.list.setHealthy(false);
    w.advance(4 * 60 * MIN);
    w.list.refused(9); // an explicit POST while main is red
    w.advance(MIN);
    w.list.setHealthy(true);
    expect(w.list.get(9)!.lastOfferedAt).toBeLessThanOrEqual(w.now());
    w.advance(WAITING_LIST_LIMITS.staleAfterMs + 1);
    expect(w.list.list()[0].live).toBe(false);
  });

  it('stays bounded: past maxWaiters the longest-idle waiters are removed', () => {
    const w = make();
    for (let pr = 1; pr <= WAITING_LIST_LIMITS.maxWaiters + 3; pr++) { w.list.refused(pr); w.advance(1); }
    expect(w.list.size()).toBe(WAITING_LIST_LIMITS.maxWaiters);
    expect(w.list.get(1)).toBeNull();
    expect(w.audits.filter((a) => a.reason === 'over-cap')).toHaveLength(3);
  });

  it('restores with downtime added back; a stale waiter stays stale after a restart', () => {
    const w = make();
    w.list.refused(1);
    w.advance(WAITING_LIST_LIMITS.staleAfterMs + MIN); // 1 is stale before the stop
    w.list.refused(2);
    w.advance(WAITING_LIST_LIMITS.heartbeatMs);
    w.list.tick(); // heartbeat write
    const w2 = make(w.file, w.now() + 3 * 60 * MIN);
    w2.list.load();
    expect(w2.list.list().map((x) => [x.pr, x.live])).toEqual([[1, false], [2, true]]);
  });
});
