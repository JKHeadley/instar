/**
 * Tier-1 wiring-integrity tests for buildGreenPrDeps (mergerunner-auto-arm-
 * handoff M2 + Blocker 4). Proves the constructed deps are REAL (not no-ops) and
 * the config-threading chain survives end-to-end:
 *   - mergeStrategy + armTimeoutMs reach the CONSTRUCTED MergeRunner (the runner
 *     is no longer hardcoded to --admin).
 *   - listOpenPrs requests the widened projection (autoMergeRequest) and derives
 *     PrSummary.autoMergeArmed.
 *   - refetchPr returns the widened shape (state + mergeCommitOid + autoMergeRequest).
 *   - disarmArmedEpisodes is a real gh --disable-auto seam (confirmed-disabled).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

import { buildGreenPrDeps, buildGuardLatchStore, type GreenPrWiringOpts } from '../../src/monitoring/greenPrAutomergeWiring.js';
import { DefaultMergeRunner } from '../../src/monitoring/MergeRunner.js';

let dir: string;
let safeMergePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr-wiring-'));
  safeMergePath = path.join(dir, 'safe-merge.mjs');
  fs.writeFileSync(safeMergePath, '// fake\n');
});
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ignore */ } });

/** A fake gh exec recording the calls; returns canned JSON per command shape. */
function fakeGh(responses: Record<string, { stdout: string; code?: number; stderr?: string }>) {
  const calls: string[][] = [];
  const ghExec = async (args: string[]) => {
    calls.push(args);
    // Match on a stable key: the first 2 args + any --json field list.
    const jsonIdx = args.indexOf('--json');
    const key = `${args[0]} ${args[1]}${jsonIdx >= 0 ? ' ' + args[jsonIdx + 1] : ''}`;
    for (const k of Object.keys(responses)) {
      if (key.startsWith(k)) return { stdout: responses[k].stdout, stderr: responses[k].stderr ?? '', code: responses[k].code ?? 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { ghExec, calls };
}

function baseOpts(over: Partial<GreenPrWiringOpts> = {}): GreenPrWiringOpts {
  return {
    repoPath: dir,
    safeMergePath,
    stateDir: dir,
    machineId: 'm1',
    repo: 'JKHeadley/instar',
    agentNamespace: 'echo',
    mergeTimeoutMs: 1_500_000,
    mergeKillGraceMs: 60_000,
    holdsLease: () => true,
    leaseEpoch: () => 0,
    postAttentionAggregate: async () => {},
    auditPath: path.join(dir, 'audit.jsonl'),
    ...over,
  };
}

describe('buildGreenPrDeps — config-threading (M2)', () => {
  it('threads mergeStrategy:auto + armTimeoutMs into the CONSTRUCTED MergeRunner', () => {
    const { ghExec } = fakeGh({});
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec, mergeStrategy: 'auto', armTimeoutMs: 45_000 }), latches);
    const runner = deps.runner as DefaultMergeRunner;
    expect(runner.resolvedStrategy).toBe('auto');
    expect(runner.resolvedArmTimeoutMs).toBe(45_000);
  });

  it('threads mergeStrategy:admin when configured', () => {
    const { ghExec } = fakeGh({});
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec, mergeStrategy: 'admin' }), latches);
    expect((deps.runner as DefaultMergeRunner).resolvedStrategy).toBe('admin');
  });

  it('defaults to the auto strategy with a 60s arm deadline when unset', () => {
    const { ghExec } = fakeGh({});
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    const runner = deps.runner as DefaultMergeRunner;
    expect(runner.resolvedStrategy).toBe('auto');
    expect(runner.resolvedArmTimeoutMs).toBe(60_000);
  });
});

describe('buildGreenPrDeps — widened projections (Blocker 4)', () => {
  it('listOpenPrs requests autoMergeRequest in the projection and derives autoMergeArmed', async () => {
    const rows = JSON.stringify([
      { number: 1, title: 'a', labels: [], isDraft: false, headRefName: 'echo/x', headRefOid: 'h1', mergeable: 'MERGEABLE', statusCheckRollup: [], autoMergeRequest: { enabledAt: 't', expectedHeadOid: 'h1' } },
      { number: 2, title: 'b', labels: [], isDraft: false, headRefName: 'echo/y', headRefOid: 'h2', mergeable: 'MERGEABLE', statusCheckRollup: [], autoMergeRequest: null },
    ]);
    const { ghExec, calls } = fakeGh({ 'pr list': { stdout: rows } });
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    const prs = await deps.listOpenPrs();
    // The list projection requested autoMergeRequest.
    const listCall = calls.find((c) => c[0] === 'pr' && c[1] === 'list')!;
    const jsonFields = listCall[listCall.indexOf('--json') + 1];
    expect(jsonFields).toContain('autoMergeRequest');
    expect(prs[0].autoMergeArmed).toBe(true);
    expect(prs[1].autoMergeArmed).toBe(false);
  });

  it('refetchPr returns the widened shape (state + mergeCommitOid + autoMergeRequest)', async () => {
    const view = JSON.stringify({ title: 't', labels: [], isDraft: false, headRefOid: 'h1', state: 'MERGED', mergeCommitOid: 'squashBase', autoMergeRequest: { expectedHeadOid: 'h1' } });
    const { ghExec, calls } = fakeGh({ 'pr view': { stdout: view } });
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    const r = await deps.refetchPr(1);
    expect(r).not.toBeNull();
    expect(r!.state).toBe('MERGED');
    expect(r!.mergeCommitOid).toBe('squashBase');
    expect(r!.autoMergeRequest?.expectedHeadOid).toBe('h1');
    // The view projection requested the widened fields.
    const viewCall = calls.find((c) => c[0] === 'pr' && c[1] === 'view')!;
    const jsonFields = viewCall[viewCall.indexOf('--json') + 1];
    expect(jsonFields).toContain('mergeCommitOid');
    expect(jsonFields).toContain('autoMergeRequest');
  });
});

describe('buildGreenPrDeps — disarm seam (Blocker 3)', () => {
  it('disarmArmedEpisodes runs gh pr merge --disable-auto and confirms via an autoMergeRequest re-read', async () => {
    const { ghExec, calls } = fakeGh({
      'pr merge': { stdout: '' },
      'pr view autoMergeRequest': { stdout: JSON.stringify({ autoMergeRequest: null }) }, // confirmed disabled
    });
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    const ok = await deps.disarmArmedEpisodes(99);
    expect(ok).toBe(true);
    const mergeCall = calls.find((c) => c[0] === 'pr' && c[1] === 'merge')!;
    expect(mergeCall).toContain('--disable-auto');
  });

  it('reports NOT confirmed-disabled when the re-read still shows auto-merge armed', async () => {
    const { ghExec } = fakeGh({
      'pr merge': { stdout: '' },
      'pr view autoMergeRequest': { stdout: JSON.stringify({ autoMergeRequest: { expectedHeadOid: 'h' } }) }, // still armed
    });
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    expect(await deps.disarmArmedEpisodes(99)).toBe(false);
  });
});
