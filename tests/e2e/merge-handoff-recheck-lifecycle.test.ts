// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** Production watcher wiring, real config/state/audit files, and an isolated GitHub command stand-in. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { GreenPrAutoMerger, freshState } from '../../src/monitoring/GreenPrAutoMerger.js';
import { buildGreenPrDeps, buildGuardLatchStore, REFETCH_PR_JSON_FIELDS, type GreenPrWiringOpts } from '../../src/monitoring/greenPrAutomergeWiring.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'merge-handoff-recheck-lifecycle.test.ts' }); });

describe('merge hand-off re-check production lifecycle', () => {
  it('reads the real switch off then on without restarting and writes correlated delayed-read audit rows', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-recheck-')));
    dirs.push(home);
    const configPath = path.join(home, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ monitoring: { greenPrAutoMerge: {} } }));
    const liveConfig = new LiveConfig(home, { checkIntervalMs: 0 });
    let now = 10_000_000;
    let reads = 0;
    let lists = 0;
    const ghExec: NonNullable<GreenPrWiringOpts['ghExec']> = async (args) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        lists++;
        return { code: 0, stderr: '', stdout: JSON.stringify({ data: { viewer: { login: 'echo-bot' }, repository: { pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
            number: 7, title: 'feat: change', labels: { nodes: [] }, isDraft: false, headRefName: 'echo/change', headRefOid: 'head',
            baseRefName: 'main', mergeable: 'UNKNOWN', autoMergeRequest: null, reviewDecision: 'APPROVED',
            author: { __typename: 'User', login: 'echo-bot' }, isCrossRepository: false,
            commits: { nodes: [] },
          }],
        } } } }) };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        expect(args.at(-1)).toBe(REFETCH_PR_JSON_FIELDS.join(','));
        reads++;
        return { code: 0, stderr: '', stdout: JSON.stringify({ title: 'feat: change', labels: [], isDraft: false, headRefOid: 'head', state: 'OPEN', mergeable: reads < 3 ? 'UNKNOWN' : 'MERGEABLE' }) };
      }
      if (args[0] === 'api' && String(args[1]).includes('/contents/.github/CODEOWNERS')) return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'api' && String(args[1]).includes('/files')) return { stdout: 'src/x.ts\n', stderr: '', code: 0 };
      if (args[0] === 'api' && args[1] === 'user') return { stdout: 'echo-bot', stderr: '', code: 0 };
      throw new Error(`Unexpected GitHub command: ${args.join(' ')}`);
    };
    const opts: GreenPrWiringOpts = {
      repoPath: home, safeMergePath: path.join(home, 'safe-merge.mjs'), stateDir: home, machineId: 'm1',
      repo: 'JKHeadley/instar', agentNamespace: 'echo', expectedGhLogin: 'echo-bot',
      mergeTimeoutMs: 1_500_000, mergeKillGraceMs: 60_000,
      holdsLease: () => true, leaseEpoch: () => 1,
      handoffRecheck: () => liveConfig.get<boolean>('monitoring.greenPrAutoMerge.handoffRecheck', false) === true,
      postAttentionAggregate: async () => {}, auditPath: path.join(home, 'logs', 'green-pr-automerge.jsonl'), ghExec, now: () => now,
    };
    const latches = buildGuardLatchStore(opts);
    const deps = buildGreenPrDeps(opts, latches);
    const waits: number[] = [];
    deps.setTimer = (fn, ms) => {
      const timer = setImmediate(() => { waits.push(ms); now += ms; fn(); });
      return () => clearImmediate(timer);
    };
    // Only process execution is faked; eligibility, GH projection, state and audit are production.
    const attempts: unknown[] = [];
    deps.runner = { probeContract: async () => ({ ok: true }), reapOrphan: async () => ({ reaped: false }),
      run: async (attempt) => { attempts.push(attempt); return { outcome: 'merged', confirmedMerged: true }; } };
    deps.saveState({ ...freshState(), lastFloor: 'local', lastActingEpoch: 1 });
    const watcher = new GreenPrAutoMerger(deps, { agentNamespace: 'echo', expectedGhLogin: 'echo-bot', repo: opts.repo, enabled: true });
    watcher.attachLocalVerify({ effectiveFloor: () => 'local', mainHealth: () => 'healthy', hasRecord: () => true, requestVerify: async () => { throw new Error('hand-offs must not request verifies'); } });
    const first = await watcher.tick({ handoff: { pr: 7, head: 'head', startedAt: 1 } });
    expect(first).toMatchObject({ reason: 'handoff-not-eligible:not-mergeable-unknown', firstMergeable: 'UNKNOWN', recheckEntered: false });
    expect(reads).toBe(1);
    expect(waits).toEqual([]);
    fs.writeFileSync(configPath, JSON.stringify({ monitoring: { greenPrAutoMerge: { handoffRecheck: true } } }));
    fs.utimesSync(configPath, new Date(), new Date(Date.now() + 1000));
    const second = await watcher.tick({ handoff: { pr: 7, head: 'head', startedAt: 2 } });
    expect(second).toMatchObject({ acted: true, reason: 'merged', firstMergeable: 'UNKNOWN', recheckEntered: true, recheckReads: 1, recheckSeconds: 5 });
    expect(lists).toBe(2);
    expect(reads).toBe(4); // First nudge, second nudge, delayed read, act-time read.
    expect(waits).toEqual([5000]);
    expect(attempts).toEqual([{ pr: 7, headRefOid: 'head', repo: opts.repo, strategy: 'sync' }]);
    const rows = fs.readFileSync(opts.auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.event === 'handoff-recheck')).toEqual([expect.objectContaining({ pr: 7, head: 'head', read: 1, mergeable: 'MERGEABLE', waitedSeconds: 5, readSeconds: 0, handoffStartedAt: 2 })]);
    expect(rows.every((row) => [1, 2].includes(row.handoffStartedAt))).toBe(true);
    // Keep the server's live dependency wired, not a fixed boot-time config field.
    expect(fs.readFileSync(path.resolve('src/commands/server.ts'), 'utf8')).toContain("handoffRecheck: () => liveConfig.get<boolean>('monitoring.greenPrAutoMerge.handoffRecheck', false) === true");
    watcher.stop();
    liveConfig.stop();
  });
});
