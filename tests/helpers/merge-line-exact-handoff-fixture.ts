// safe-fs-allow: caller owns temporary home cleanup via SafeFsExecutor.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { buildGreenPrDeps, buildGuardLatchStore, type GreenPrWiringOpts } from '../../src/monitoring/greenPrAutomergeWiring.js';
import { GreenPrAutoMerger } from '../../src/monitoring/GreenPrAutoMerger.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

/** Real production watcher/deps/routes; only GitHub and merge-process boundaries are replaced. */
export function exactHandoffFixture(home: string) {
  const stateDir = path.join(home, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  const calls: string[][] = [], attempts: Array<{ pr: number; headRefOid: string }> = [];
  let held = false, head = 'a'.repeat(40), lookupCount = 0;
  const node = () => ({ number: 3714, state: 'OPEN', title: 'fix: owner delivery', labels: { nodes: held ? [{ name: 'hold' }] : [] },
    isDraft: false, headRefName: 'fix/owner-delivery', headRefOid: head, baseRefName: 'main', mergeable: 'MERGEABLE',
    author: { __typename: 'User', login: 'EchoOfDawn' }, isCrossRepository: false, autoMergeRequest: null,
    reviewDecision: null, createdAt: '2026-11-23T21:00:00Z', commits: { nodes: [] } });
  const ghExec = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'user') return { code: 0, stdout: 'EchoOfDawn\n', stderr: '' };
    if (args[0] === 'api' && args[1] === 'graphql') {
      const direct = args.some((a) => a === 'number=3714');
      if (direct) lookupCount++;
      return { code: 0, stderr: '', stdout: JSON.stringify({ data: { viewer: { login: 'EchoOfDawn' }, repository: direct
        ? { pullRequest: node() } : { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } } }) };
    }
    if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stderr: '', stdout: JSON.stringify({ ...node(), labels: held ? [{ name: 'hold' }] : [] }) };
    if (args[0] === 'api' && String(args[1]).includes('/contents/.github/CODEOWNERS')) return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'api' && String(args[1]).includes('/files')) return { code: 0, stdout: 'src/x.ts\n', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const opts: GreenPrWiringOpts = { repoPath: home, safeMergePath: path.join(home, 'safe-merge.mjs'), stateDir, machineId: 'm_handoff',
    repo: 'JKHeadley/instar', agentNamespace: 'echo', expectedGhLogin: 'EchoOfDawn', mergeTimeoutMs: 1_500_000,
    mergeKillGraceMs: 60_000, holdsLease: () => true, leaseEpoch: () => 1, postAttentionAggregate: async () => {},
    auditPath: path.join(home, 'logs/green-pr-automerge.jsonl'), ghExec };
  const latches = buildGuardLatchStore(opts), deps = buildGreenPrDeps(opts, latches);
  deps.runner = { probeContract: async () => ({ ok: true, version: 2 }), reapOrphan: async () => ({ reaped: false }),
    run: async (a) => { attempts.push(a); return { outcome: 'merged', confirmedMerged: true }; } };
  const watcher = new GreenPrAutoMerger(deps, { agentNamespace: 'echo', repo: opts.repo, enabled: true, expectedGhLogin: 'EchoOfDawn' });
  watcher.attachLocalVerify({ effectiveFloor: () => 'local', mainHealth: () => 'healthy',
    hasRecord: (pr, candidate, base) => pr === 3714 && candidate === 'a'.repeat(40) && base === 'main', requestVerify: async () => ({ ok: true, status: 'queued' }) });
  const app = express(); app.use(express.json()); app.use(createRoutes({
    config: { projectName: 'handoff', projectDir: home, stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never, state: { getJobState: () => null, getSession: () => null } as never,
    greenPrAutoMerger: watcher, guardLatchStore: latches, startTime: new Date(),
  } as unknown as RouteContext));
  return { watcher, app, deps, attempts, calls, lookupCount: () => lookupCount, hold: () => { held = true; }, move: () => { head = 'b'.repeat(40); } };
}
