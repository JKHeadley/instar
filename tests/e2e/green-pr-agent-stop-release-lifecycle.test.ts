/**
 * Tier-3: agent stop release on the production path (green-pr-agent-stop-release).
 * buildGuardLatchStore + buildAgentStopFacts as server.ts wires them, a fake gh at
 * the exec seam, and the real route stack. The feature is alive (200, not 503), and
 * the incident's shape runs end to end: stop, fix merges, fix reaches the running
 * release, release, gate open. A rebuild from disk keeps the class.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildAgentStopFacts, buildGreenPrDeps, buildGuardLatchStore, AGENT_STOP_PR_JSON_FIELDS, type GreenPrWiringOpts } from '../../src/monitoring/greenPrAutomergeWiring.js';
import { AgentStopSurfacer } from '../../src/monitoring/agentStopRelease.js';
import { GreenPrAutoMerger } from '../../src/monitoring/GreenPrAutoMerger.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'green-pr-agent-stop-release-lifecycle.test.ts' }); });

describe('agent stop release (production wiring)', () => {
  it('stop, fix lands, fix reaches the running release, release, gate open; an operator stop never releases', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stop-e2e-')));
    dirs.push(home);
    const stateDir = path.join(home, '.instar');
    fs.mkdirSync(stateDir);

    let merged: Array<Record<string, unknown>> = [];
    let compare = 'behind';
    const calls: string[][] = [];
    const ghExec = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) return { stdout: JSON.stringify(merged), stderr: '', code: 0 };
      if (args[0] === 'api' && String(args[1]).includes('/compare/')) return { stdout: `${compare}\n`, stderr: '', code: 0 };
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const opts = {
      repoPath: home, safeMergePath: path.join(home, 'safe-merge.mjs'), stateDir, machineId: 'm1',
      repo: 'JKHeadley/instar', agentNamespace: 'echo', expectedGhLogin: 'EchoOfDawn',
      mergeTimeoutMs: 1_500_000, mergeKillGraceMs: 60_000,
      holdsLease: () => true, leaseEpoch: () => 1, postAttentionAggregate: async () => {},
      auditPath: path.join(home, 'logs', 'green-pr-automerge.jsonl'), ghExec,
    } as GreenPrWiringOpts;

    const build = () => {
      const latches = buildGuardLatchStore(opts);
      const attention: string[] = [];
      const surfacer = new AgentStopSurfacer({
        stateDir,
        listRollbackStops: () => latches.rollbackStops(),
        facts: buildAgentStopFacts(opts),
        runningVersion: () => '1.3.1640',
        raiseAttention: async (item) => { attention.push(item.id); },
      });
      const watcher = new GreenPrAutoMerger(buildGreenPrDeps(opts, latches), { agentNamespace: 'echo', repo: 'JKHeadley/instar', enabled: true, expectedGhLogin: 'EchoOfDawn', dryRun: true } as never);
      const app = express();
      app.use(express.json());
      app.use(createRoutes({
        config: { projectName: 'echo', projectDir: home, stateDir, port: 0, dashboardPin: '424242' } as never,
        sessionManager: { listRunningSessions: () => [] } as never,
        state: { getJobState: () => null, getSession: () => null } as never,
        greenPrAutoMerger: watcher, guardLatchStore: latches, agentStopSurfacer: surfacer, startTime: new Date(),
      } as unknown as RouteContext));
      return { app, latches, surfacer, attention };
    };

    const { app, latches, surfacer, attention } = build();
    const by = { releasedBy: { topicId: 136706 }, note: 'the fix is in the running release' };

    // Feature alive, and the status carries the stops list even when empty.
    const alive = await request(app).get('/green-pr-automerge');
    expect(alive.status).toBe(200);
    expect(alive.body.gate.rollbackStops).toEqual([]);

    const stopRes = await request(app).post('/green-pr-automerge/rollback').send({
      reason: 'merged early',
      agentStop: { topicId: 18330, cause: 'The old watcher merged a PR before hosted CI finished.', release: { kind: 'fix-pr-released' } },
    });
    expect(stopRes.body.originClass).toBe('agent');
    const { latchId, marker } = stopRes.body;
    expect(latches.isMergeAllowed().allowed).toBe(false);

    // Nothing has landed: refused.
    expect((await request(app).post('/green-pr-automerge/release').send({ latchId, ...by })).status).toBe(409);

    // The fix merged but this server is not running it yet: still refused. A merged fix is not a running fix.
    const fix = { number: 2700, body: `Resolves ${marker}.`, state: 'MERGED', mergedAt: new Date(Date.now() + 60_000).toISOString(), baseRefName: 'main', mergeCommit: { oid: 'abc1234' } };
    merged = [fix];
    expect((await request(app).post('/green-pr-automerge/release').send({ latchId, ...by })).status).toBe(409);

    // The real reads ran through the production adapter, with the projection and search it pins.
    const search = calls.find((a) => a.includes('--search'))!;
    expect(search).toEqual(expect.arrayContaining(['--repo', 'JKHeadley/instar', `"${marker}" in:body`, AGENT_STOP_PR_JSON_FIELDS.join(',')]));
    expect(calls.find((a) => String(a[1]).includes('/compare/'))![1]).toBe('repos/JKHeadley/instar/compare/abc1234...v1.3.1640');

    // The surfacing pass reads the same thing and shows it in status.
    await surfacer.pass();
    expect(attention).toEqual([`green-pr-agent-stop:${latchId}`]);
    const stops = (await request(app).get('/green-pr-automerge')).body.gate.rollbackStops;
    expect(stops[0]).toMatchObject({ latchId, class: 'agent', conditionMet: false });

    // Rebuilt from disk: the class and the refusal both survive a restart.
    const restarted = build();
    expect(restarted.latches.stopClass('rollback', latchId)).toMatchObject({ active: true, class: 'agent' });
    expect((await request(restarted.app).post('/green-pr-automerge/release').send({ latchId, ...by })).status).toBe(409);

    // The fix reaches the running release: released, gate open.
    compare = 'ahead';
    const released = await request(restarted.app).post('/green-pr-automerge/release').send({ latchId, ...by });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ released: latchId, mergeAllowed: true, evidence: { pr: 2700, running: '1.3.1640' } });

    // Every step above holds for agent stops only. An operator stop stays with the PIN.
    const op = await request(restarted.app).post('/green-pr-automerge/rollback').send({ reason: 'stopped from the console' });
    expect(op.body.originClass).toBe('operator');
    expect((await request(restarted.app).post('/green-pr-automerge/release').send({ latchId: op.body.latchId, ...by })).status).toBe(403);
    expect((await request(restarted.app).post('/green-pr-automerge/enable').send({})).status).toBe(403);
    expect(restarted.latches.isMergeAllowed().allowed).toBe(false);
  });
});
