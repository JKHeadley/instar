/**
 * merge-line-author-eligibility-and-handoff-resume (D1): the merge line accepts
 * the agent's own PRs by AUTHOR on a same-repo head, not only by an `echo/`
 * branch prefix; a fork is never eligible; a remaining skip is visible.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentOwnership, classifyCandidate, type PrSummary } from '../../src/monitoring/greenPrLogic.js';
import { mapPr, buildGreenPrDeps, buildGuardLatchStore, type GreenPrWiringOpts } from '../../src/monitoring/greenPrAutomergeWiring.js';
import { GreenPrAutoMerger, freshState, type GreenPrAutoMergerDeps, type MergeAttempt, type GreenPrState } from '../../src/monitoring/GreenPrAutoMerger.js';

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 100, title: 'fix: a thing', labels: [], isDraft: false,
  headRefName: 'fix/a-thing', headRefOid: 'sha100', mergeable: 'MERGEABLE', statusRollup: 'SUCCESS',
  authorLogin: 'EchoOfDawn', isCrossRepository: false, ...over,
});

describe('agentOwnership', () => {
  it('namespace arm (the original rule) still admits', () => {
    expect(agentOwnership(pr({ headRefName: 'echo/x', authorLogin: undefined, isCrossRepository: undefined }), 'echo', 'EchoOfDawn'))
      .toEqual({ owned: true, reason: 'namespace' });
  });
  it('a same-repo PR by the configured login is owned whatever its prefix (case-insensitive)', () => {
    for (const b of ['fix/x', 'chore/x', 'feat/x', 'docs/x', 'bare-name']) {
      expect(agentOwnership(pr({ headRefName: b }), 'echo', 'EchoOfDawn').owned).toBe(true);
    }
    expect(agentOwnership(pr({ authorLogin: 'echoofdawn' }), 'echo', 'EchoOfDawn')).toEqual({ owned: true, reason: 'author' });
  });
  it('a fork is never owned, even with an echo/ branch (checked before both arms)', () => {
    expect(agentOwnership(pr({ isCrossRepository: true }), 'echo', 'EchoOfDawn')).toEqual({ owned: false, reason: 'fork' });
    expect(agentOwnership(pr({ headRefName: 'echo/x', isCrossRepository: true }), 'echo', 'EchoOfDawn')).toEqual({ owned: false, reason: 'fork' });
  });
  it('another author is not owned', () => {
    expect(agentOwnership(pr({ authorLogin: 'JKHeadley' }), 'echo', 'EchoOfDawn')).toEqual({ owned: false, reason: 'author-mismatch' });
  });
  it('legacy projection / unconfigured login: only the namespace arm can admit', () => {
    expect(agentOwnership(pr({ authorLogin: undefined, isCrossRepository: undefined }), 'echo', 'EchoOfDawn'))
      .toEqual({ owned: false, reason: 'ownership-unknown' });
    expect(agentOwnership(pr({ isCrossRepository: undefined }), 'echo', 'EchoOfDawn').owned).toBe(false);
    expect(agentOwnership(pr(), 'echo', '').owned).toBe(false);
    expect(agentOwnership(pr(), 'echo', undefined).owned).toBe(false);
  });
});

describe('classifyCandidate with expectedGhLogin', () => {
  it('admits an own fix/ PR that the namespace rule alone refused', () => {
    expect(classifyCandidate(pr(), 'echo').skip).toBe('not-agent-namespace'); // the old behavior
    expect(classifyCandidate(pr(), 'echo', { expectedGhLogin: 'EchoOfDawn' })).toEqual({ eligible: true });
    expect(classifyCandidate(pr(), 'echo', { floor: 'local', hasRecord: true, expectedGhLogin: 'EchoOfDawn' })).toEqual({ eligible: true });
  });
  it('every later gate still runs', () => {
    const o = { expectedGhLogin: 'EchoOfDawn' };
    expect(classifyCandidate(pr({ isDraft: true }), 'echo', o).skip).toBe('held');
    expect(classifyCandidate(pr({ labels: ['hold'] }), 'echo', o).skip).toBe('held');
    expect(classifyCandidate(pr({ mergeable: 'CONFLICTING' }), 'echo', o).skip).toBe('not-mergeable');
    expect(classifyCandidate(pr({ statusRollup: 'PENDING' }), 'echo', o).skip).toBe('not-settled-green');
    expect(classifyCandidate(pr(), 'echo', { ...o, floor: 'local', hasRecord: false }).skip).toBe('no-verify-record');
    expect(classifyCandidate(pr({ isCrossRepository: true }), 'echo', o).skip).toBe('not-agent-namespace');
  });
});

describe('mapPr carries author + fork flag', () => {
  it('maps present fields and leaves absent ones absent', () => {
    const m = mapPr({ number: 1, headRefName: 'fix/x', author: { login: 'EchoOfDawn' }, isCrossRepository: false });
    expect(m.authorLogin).toBe('EchoOfDawn');
    expect(m.isCrossRepository).toBe(false);
    const legacy = mapPr({ number: 2, headRefName: 'fix/x' });
    expect('authorLogin' in legacy).toBe(false);
    expect('isCrossRepository' in legacy).toBe(false);
  });
});

describe('holdEligible covers every PR the watcher can merge', () => {
  const opts = (view: object): GreenPrWiringOpts => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr-own-'));
    return {
      repoPath: dir, safeMergePath: path.join(dir, 's.mjs'), stateDir: dir, machineId: 'm1',
      repo: 'JKHeadley/instar', agentNamespace: 'echo', expectedGhLogin: 'EchoOfDawn',
      mergeTimeoutMs: 1_500_000, mergeKillGraceMs: 60_000,
      holdsLease: () => true, leaseEpoch: () => 0, postAttentionAggregate: async () => {},
      auditPath: path.join(dir, 'a.jsonl'),
      ghExec: async () => ({ stdout: JSON.stringify(view), stderr: '', code: 0 }),
    } as GreenPrWiringOpts;
  };
  const eligible = async (view: object) => {
    const o = opts(view);
    return buildGreenPrDeps(o, buildGuardLatchStore(o)).holdEligible(7);
  };
  it('accepts a same-repo fix/ PR by author, refuses a fork and another author', async () => {
    expect(await eligible({ state: 'OPEN', headRefName: 'fix/x', author: { login: 'EchoOfDawn' }, isCrossRepository: false })).toEqual({ ok: true });
    expect((await eligible({ state: 'OPEN', headRefName: 'echo/x', author: { login: 'EchoOfDawn' }, isCrossRepository: true })).status).toBe(403);
    expect((await eligible({ state: 'OPEN', headRefName: 'fix/x', author: { login: 'JKHeadley' }, isCrossRepository: false })).status).toBe(403);
    expect(await eligible({ state: 'OPEN', headRefName: 'echo/x' })).toEqual({ ok: true }); // legacy namespace arm
  });
});

describe('GreenPrAutoMerger — own out-of-namespace PRs merge; refused ones are visible', () => {
  function harness(prs: PrSummary[]) {
    const state: GreenPrState = freshState();
    state.lastActingEpoch = 1; // past warm-up
    const audits: Record<string, unknown>[] = [];
    const runCalls: MergeAttempt[] = [];
    let t = 1_000_000;
    const deps: GreenPrAutoMergerDeps = {
      holdsLease: () => true, leaseEpoch: () => 1, listOpenPrs: async () => prs,
      codeOwnedPaths: async () => ({ touches: false, files: [], unverifiable: false }),
      refetchPr: async (n) => ({ title: 'fix', labels: [], isDraft: false, headRefOid: prs.find((p) => p.number === n)!.headRefOid, state: 'OPEN' }),
      disarmArmedEpisodes: async () => true,
      resolveGhLogin: async () => 'EchoOfDawn',
      holdEligible: async () => ({ ok: true }), applyHoldMarker: async () => true,
      runner: { probeContract: async () => ({ ok: true, version: 2 }), run: async (a) => { runCalls.push(a); return { outcome: 'merged', confirmedMerged: true }; }, reapOrphan: async () => ({ reaped: false }) },
      latches: { isMergeAllowed: () => ({ allowed: true, reason: 'allowed', activeLatchIds: {} }) },
      postAttentionAggregate: async () => {}, audit: (e) => audits.push(e),
      loadState: () => state, saveState: () => {}, now: () => (t += 1000),
    };
    const w = new GreenPrAutoMerger(deps, { agentNamespace: 'echo', repo: 'JKHeadley/instar', enabled: true, expectedGhLogin: 'EchoOfDawn' });
    return { w, state, audits, runCalls };
  }

  it('merges the agent\'s own fix/ PR (it was skipped as not-agent-namespace before)', async () => {
    const h = harness([pr({ number: 2360, headRefName: 'chore/model-registry-review' })]);
    const r = await h.w.tick();
    expect(r.acted).toBe(true);
    expect(h.runCalls.map((c) => c.pr)).toEqual([2360]);
    expect(h.state.notAgentOwned).toEqual([]);
  });

  it('a fork lands in notAgentOwned with ONE audit line across ticks, and is never merged', async () => {
    const fork = pr({ number: 9, headRefName: 'echo/fork', isCrossRepository: true });
    const h = harness([fork]);
    await h.w.tick();
    await h.w.tick();
    expect(h.runCalls).toEqual([]);
    expect(h.state.notAgentOwned).toHaveLength(1);
    expect(h.state.notAgentOwned![0]).toMatchObject({ pr: 9, reason: 'fork', hasVerifyRecord: false });
    expect(h.audits.filter((a) => a.event === 'skipped:not-agent-owned')).toHaveLength(1);
  });

  it('a new head on a refused PR is audited again; a PR that leaves the list drops out', async () => {
    const prs = [pr({ number: 9, authorLogin: 'JKHeadley' })];
    const h = harness(prs);
    await h.w.tick();
    prs[0] = { ...prs[0], headRefOid: 'sha-new' };
    await h.w.tick();
    expect(h.audits.filter((a) => a.event === 'skipped:not-agent-owned')).toHaveLength(2);
    prs.length = 0;
    await h.w.tick();
    expect(h.state.notAgentOwned).toEqual([]);
  });
});
