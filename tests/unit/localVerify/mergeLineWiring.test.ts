/**
 * Tier-1 tests for wireMergeLine (the merge line, CMT-980): the hand-off reaches the
 * watcher only through the live kill switch and, with live status posting, only once
 * GitHub holds `success` for the head (posted now and read back); an unknown head is
 * listed first. Both sides of every rule.
 */

import { describe, expect, it } from 'vitest';
import { wireMergeLine, type MergeLineStatusView, type MergeLineWatcher } from '../../../src/localVerify/localVerifyWiring.js';
import type { LocalVerifyService, MergeHandoff } from '../../../src/localVerify/LocalVerifyService.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';

const sha = (c: string) => c.repeat(40);
const rec = (over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord => ({
  repo: 'JKHeadley/instar', pr: 7, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
  lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
  nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-23T10:00:00.000Z', finishedAt: '2026-10-23T10:20:00.000Z',
  outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
  verifierVersion: 'vh2:x', policyHash: 'p', ...over,
});

function fakeService(): { service: LocalVerifyService; handoff: () => MergeHandoff | null } {
  let fn: MergeHandoff | null = null;
  const service = { setMergeHandoff: (f: MergeHandoff | null) => { fn = f; } } as unknown as LocalVerifyService;
  return { service, handoff: () => fn };
}

function watcher() {
  const calls: Array<{ pr: number; head: string }> = [];
  const w: MergeLineWatcher = { tick: async ({ handoff }) => { calls.push(handoff); return { acted: true, reason: 'merged' }; } };
  return { w, calls };
}

function status(over: Partial<{ known: boolean; state: string | null; live: boolean; submitThrows: boolean }> = {}) {
  const log: string[] = [];
  let known = over.known ?? true;
  const st: MergeLineStatusView = {
    knowsHead: () => known,
    awaitPass: async () => { log.push('pass'); known = true; return {}; },
    submit: async (h, trigger) => { log.push(`submit:${trigger}:${h.slice(0, 4)}`); if (over.submitThrows) throw new Error('post failed'); },
    headState: () => (over.state === undefined ? 'success' : over.state),
    postingLive: () => over.live ?? true,
  };
  return { st, log };
}

describe('wireMergeLine', () => {
  it('without a watcher the line is inert (detached, reason named)', () => {
    const f = fakeService();
    expect(wireMergeLine({ service: f.service, watcher: null, status: null, enabled: () => true })).toEqual({ wired: false, reason: 'no-watcher' });
    expect(f.handoff()).toBeNull();
  });

  it('posts the head\'s status now, reads it back, and hands exactly (pr, head) to the watcher', async () => {
    const f = fakeService();
    const w = watcher();
    const s = status();
    expect(wireMergeLine({ service: f.service, watcher: w.w, status: s.st, enabled: () => true })).toEqual({ wired: true, reason: null });
    const r = await f.handoff()!(rec(), { baseIsCurrentMain: true, currentMainHead: sha('b') });
    expect(r).toEqual({ acted: true, reason: 'merged' });
    expect(w.calls).toEqual([{ pr: 7, head: sha('a') }]);
    expect(s.log).toEqual([`submit:merge-line:${sha('a').slice(0, 4)}`]);
  });

  it('a head the loop has not listed is listed first (the running pass, or one now), then posted', async () => {
    const f = fakeService();
    const w = watcher();
    const s = status({ known: false });
    wireMergeLine({ service: f.service, watcher: w.w, status: s.st, enabled: () => true });
    await f.handoff()!(rec(), { baseIsCurrentMain: null, currentMainHead: null });
    expect(s.log).toEqual(['pass', `submit:merge-line:${sha('a').slice(0, 4)}`]);
    expect(w.calls).toHaveLength(1);
  });

  it('with live posting, a head GitHub does not hold `success` for is NOT handed off (no ladder attempt burned); dry-run posting proceeds', async () => {
    for (const state of ['pending', 'failure', null]) {
      const f = fakeService();
      const w = watcher();
      wireMergeLine({ service: f.service, watcher: w.w, status: status({ state }).st, enabled: () => true });
      expect(await f.handoff()!(rec(), { baseIsCurrentMain: null, currentMainHead: null })).toEqual({ acted: false, reason: `status-${state ?? 'absent'}` });
      expect(w.calls).toHaveLength(0);
    }
    const f = fakeService();
    const w = watcher();
    wireMergeLine({ service: f.service, watcher: w.w, status: status({ state: null, live: false }).st, enabled: () => true });
    expect(await f.handoff()!(rec(), { baseIsCurrentMain: null, currentMainHead: null })).toEqual({ acted: true, reason: 'merged' });
  });

  it('a failed post is not fatal: the read-back decides', async () => {
    const f = fakeService();
    const w = watcher();
    wireMergeLine({ service: f.service, watcher: w.w, status: status({ submitThrows: true, state: 'success' }).st, enabled: () => true });
    expect(await f.handoff()!(rec(), { baseIsCurrentMain: null, currentMainHead: null })).toEqual({ acted: true, reason: 'merged' });
  });

  it('the kill switch is read at hand-off time: off ⇒ nothing is posted or merged', async () => {
    const f = fakeService();
    const w = watcher();
    const s = status();
    let on = false;
    wireMergeLine({ service: f.service, watcher: w.w, status: s.st, enabled: () => on });
    expect(await f.handoff()!(rec(), { baseIsCurrentMain: null, currentMainHead: null })).toEqual({ acted: false, reason: 'disabled' });
    expect(s.log).toEqual([]);
    on = true;
    expect(await f.handoff()!(rec(), { baseIsCurrentMain: null, currentMainHead: null })).toEqual({ acted: true, reason: 'merged' });
  });

  it('without a status loop the hand-off goes straight to the watcher', async () => {
    const f = fakeService();
    const w = watcher();
    wireMergeLine({ service: f.service, watcher: w.w, status: null, enabled: () => true });
    expect(await f.handoff()!(rec(), { baseIsCurrentMain: null, currentMainHead: null })).toEqual({ acted: true, reason: 'merged' });
  });
});
