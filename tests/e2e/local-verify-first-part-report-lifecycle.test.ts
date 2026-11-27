// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { expect, it } from 'vitest';
import { buildLocalVerifyService, wireLocalVerifySwitches } from '../../src/localVerify/localVerifyWiring.js';
import { runVerify, type VerifyRunInput, type OrchestratorSeams } from '../../src/localVerify/orchestrator.js';
import type { LocalVerifyServiceSeams } from '../../src/localVerify/LocalVerifyService.js';
import { registerLocalVerifyRoutes } from '../../src/localVerify/localVerifyRoutes.js';
import { inProcessHttp } from '../helpers/localVerifyInProcessHttp.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

it('production wiring writes a real verify observation and serves it through the report on a peer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
  const built = buildLocalVerifyService({ config: { enabled: true, peer: { enabled: true }, performanceCores: false }, expectedGhLogin: 'EchoOfDawn',
    repo: 'JKHeadley/instar', repoPath: dir, stateDir: dir, agentHome: dir, machineId: 'peer', mainEntry: path.resolve('src/localVerify/runVerifyMain.ts') });
  expect(built.reason).toBeNull(); const svc = built.service!;
  try {
    const config: Record<string, unknown> = { 'monitoring.localVerify.likelyFailingFirst': 'alternate' };
    wireLocalVerifySwitches(svc, { get: (k, fallback) => (config[k] ?? fallback) as never, set: (k, v) => { config[k] = v; } });
    svc.setPeerWiring({ peerRoleEnabled: () => true });
    const seams = (svc as unknown as { seams: LocalVerifyServiceSeams }).seams;
    seams.installedVerifierVersion = undefined;
    seams.prView = async () => ({ author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/test', headRefOid: 'a'.repeat(40), baseRefName: 'main', baseRefOid: 'b'.repeat(40) });
    seams.foreignSuiteHolders = () => []; seams.isGroupAlive = () => false; seams.killGroup = () => {};
    seams.spawnRun = (args) => {
      const input = JSON.parse(fs.readFileSync(args.args[args.args.indexOf('--input') + 1], 'utf8')) as VerifyRunInput;
      const resultPath = args.args[args.args.indexOf('--result') + 1];
      const runSeams: OrchestratorSeams = {
        git: async () => { throw new Error('fixture fetch unavailable'); }, exec: async () => { throw new Error('unexpected exec'); },
        fs: { exists: () => false, mkdirp: () => {}, writeFile: () => {}, readFile: () => null, mkdtemp: () => dir, removeTree: async () => {} },
        now: () => Date.now(), sleep: async () => {}, foreignSuiteHolders: () => [], log: () => {},
      };
      return { pid: 98765, exited: runVerify(input, runSeams).then((result) => {
        fs.writeFileSync(resultPath, JSON.stringify(result)); return { status: 0, signal: null };
      }) };
    };
    const answer = await svc.peerRun({ attemptId: 'a'.repeat(32), pr: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRefName: 'main',
      verifierVersion: (svc as any).cfg.verifierVersion, policyHash: (svc as any).policyHash, coordinatorMachineId: 'coord', leaseEpoch: 1, firstPartGroup: 'with' },
      { holdsLease: false, holderMachineId: 'coord', leaseEpoch: 1 });
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    await svc.whenIdle();
    const rows = svc.firstPartReport.rows(); expect(rows.filter((r) => r.type === 'observation')).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ id: 'a'.repeat(32), pr: 7, group: 'with', setting: 'alternate', ran: false, incomplete: true, outcome: 'error' });
    const peerResult = svc.peerResult('a'.repeat(32));
    expect(peerResult).toMatchObject({ state: 'done', record: { firstPart: { setting: 'alternate', group: 'with', ran: false } } });
    const app = express(); app.use(express.json()); registerLocalVerifyRoutes(app, { service: () => svc, lease: { holdsLease: () => false, holderMachineId: () => 'coord' } });
    const response = await inProcessHttp(app, 'GET', '/local-verify/first-part-report');
    expect(response.status).toBe(200); expect(response.body.groups.with).toMatchObject({ verifies: 1, errors: 1 });
  } finally { svc.shutdown(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'local-verify-first-part-report-lifecycle.test.ts' }); }
});
