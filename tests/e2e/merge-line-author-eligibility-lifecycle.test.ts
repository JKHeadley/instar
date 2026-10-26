// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 lifecycle test (merge-line-author-eligibility-and-handoff-resume, D1):
 * the watcher is built through the production wiring (buildGreenPrDeps +
 * GreenPrAutoMerger, as server.ts does) over a gh stand-in that returns the REAL
 * `gh pr list --json` shape (author object, isCrossRepository), then served
 * through the real routes. Proves the feature is alive end to end: an own
 * `chore/` PR becomes a merge candidate, a fork is listed in notAgentOwned, and
 * GET /green-pr-automerge returns 200 with the count.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildGreenPrDeps, buildGuardLatchStore, LIST_PR_JSON_FIELDS, type GreenPrWiringOpts } from '../../src/monitoring/greenPrAutomergeWiring.js';
import { GreenPrAutoMerger } from '../../src/monitoring/GreenPrAutoMerger.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'merge-line-author-eligibility-lifecycle.test.ts' }); });

const green = [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-25T00:00:00Z', workflowName: 'ci' }];
const row = (number: number, headRefName: string, login: string, isCrossRepository: boolean) => ({
  number, title: `chore: ${number}`, labels: [], isDraft: false, headRefName, headRefOid: `sha${number}`,
  baseRefName: 'main', mergeable: 'MERGEABLE', statusCheckRollup: green, autoMergeRequest: null,
  reviewDecision: '', createdAt: '2026-10-25T00:00:00Z', author: { login, is_bot: false }, isCrossRepository,
});

describe('merge line accepts own PRs by author (production wiring)', () => {
  it('own chore/ PR is a candidate, a fork is surfaced, route answers 200', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mlae-')));
    dirs.push(home);
    const stateDir = path.join(home, '.instar');
    fs.mkdirSync(stateDir);
    const listArgs: string[][] = [];
    const ghExec = async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        listArgs.push(args);
        return { stdout: JSON.stringify([row(2360, 'chore/model-registry-review', 'EchoOfDawn', false), row(9, 'echo/from-fork', 'EchoOfDawn', true)]), stderr: '', code: 0 };
      }
      if (args[0] === 'api' && String(args[1]).includes('/contents/.github/CODEOWNERS')) return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'api' && String(args[1]).includes('/files')) return { stdout: 'src/x.ts\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const opts: GreenPrWiringOpts = {
      repoPath: home, safeMergePath: path.join(home, 'safe-merge.mjs'), stateDir, machineId: 'm1',
      repo: 'JKHeadley/instar', agentNamespace: 'echo', expectedGhLogin: 'EchoOfDawn',
      mergeTimeoutMs: 1_500_000, mergeKillGraceMs: 60_000,
      holdsLease: () => true, leaseEpoch: () => 1, postAttentionAggregate: async () => {},
      auditPath: path.join(home, 'logs', 'green-pr-automerge.jsonl'), ghExec,
    } as GreenPrWiringOpts;
    const latches = buildGuardLatchStore(opts);
    const watcher = new GreenPrAutoMerger(buildGreenPrDeps(opts, latches), {
      agentNamespace: 'echo', repo: 'JKHeadley/instar', enabled: true, expectedGhLogin: 'EchoOfDawn', dryRun: true,
    } as never);
    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { projectName: 'echo', projectDir: home, stateDir, port: 0 } as never,
      sessionManager: { listRunningSessions: () => [] } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      greenPrAutoMerger: watcher, guardLatchStore: latches, startTime: new Date(),
    } as unknown as RouteContext));

    expect((await request(app).post('/green-pr-automerge/tick')).status).toBe(200); // warm-up tick: observe
    // The production list projection asks GitHub for the two ownership fields.
    const fields = listArgs[0][listArgs[0].indexOf('--json') + 1].split(',');
    expect(fields).toEqual([...LIST_PR_JSON_FIELDS]);
    expect(fields).toEqual(expect.arrayContaining(['author', 'isCrossRepository']));

    const res = await request(app).get('/green-pr-automerge');
    expect(res.status).toBe(200);
    expect(res.body.snapshot.entries).toEqual(expect.arrayContaining([expect.objectContaining({ pr: 2360, kind: 'mergeable' })]));
    expect(res.body.snapshot.entries.some((e: { pr: number }) => e.pr === 9)).toBe(false);
    expect(res.body.notAgentOwnedCount).toBe(1);
    expect(res.body.notAgentOwned[0]).toMatchObject({ pr: 9, reason: 'fork' });
    expect(res.body.namespaceMismatch).toBeNull();
  });
});
