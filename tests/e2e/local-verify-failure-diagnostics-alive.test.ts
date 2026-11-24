import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { expect, it } from 'vitest';
import { buildLocalVerifyService } from '../../src/localVerify/localVerifyWiring.js';
import type { LocalVerifyServiceSeams } from '../../src/localVerify/LocalVerifyService.js';
import type { VerifyRunInput } from '../../src/localVerify/orchestrator.js';
import { runVerify } from '../../src/localVerify/orchestrator.js';
import { registerLocalVerifyRoutes } from '../../src/localVerify/localVerifyRoutes.js';
import { FAILURE_EVIDENCE_FILE } from '../../src/localVerify/failureEvidence.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { inProcessHttp } from '../helpers/localVerifyInProcessHttp.js';
import { verificationDiagnosticsFixture, DIAGNOSTIC_HEAD, DIAGNOSTIC_BASE } from '../helpers/verificationDiagnosticsFixture.js';

it('production verifier wiring preserves private failure diagnostics after the run and serves a healthy status route without raw details', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-diagnostics-alive-')));
  const fixture = verificationDiagnosticsFixture(home, true);
  const built = buildLocalVerifyService({ config: { enabled: true, peer: { enabled: true }, performanceCores: false }, expectedGhLogin: 'EchoOfDawn',
    repo: 'JKHeadley/instar', repoPath: home, stateDir: path.join(home, '.instar'), agentHome: home, machineId: 'owned-peer', mainEntry: path.resolve('src/localVerify/runVerifyMain.ts') });
  expect(built.reason).toBeNull(); const service = built.service!;
  try {
    service.setPeerWiring({ peerRoleEnabled: () => true });
    const seams = (service as unknown as { seams: LocalVerifyServiceSeams }).seams;
    seams.installedVerifierVersion = undefined;
    seams.prView = async () => ({ author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/owned-fixture', headRefOid: DIAGNOSTIC_HEAD, baseRefName: 'main', baseRefOid: DIAGNOSTIC_BASE });
    seams.foreignSuiteHolders = () => []; seams.isGroupAlive = () => false; seams.killGroup = () => {};
    seams.spawnRun = args => {
      const input = JSON.parse(fs.readFileSync(args.args[args.args.indexOf('--input') + 1], 'utf8')) as VerifyRunInput;
      const output = args.args[args.args.indexOf('--result') + 1];
      // Production service/orchestrator/filesystem are real. Git/install/full-suite
      // boundaries are controlled; only owned one-shot child fixtures execute.
      return { pid: 98765, exited: runVerify({ ...input, laneShards: fixture.input.laneShards, preflightMode: 'off', isolation: fixture.input.isolation }, fixture.seams).then(result => {
        fs.writeFileSync(output, JSON.stringify(result)); return { status: 0, signal: null };
      }) };
    };
    const answer = await service.peerRun({ attemptId: 'e'.repeat(32), pr: 7, headSha: DIAGNOSTIC_HEAD, baseSha: DIAGNOSTIC_BASE, baseRefName: 'main',
      verifierVersion: (service as any).cfg.verifierVersion, policyHash: (service as any).policyHash, coordinatorMachineId: 'owned-coordinator', leaseEpoch: 1 },
      { holdsLease: false, holderMachineId: 'owned-coordinator', leaseEpoch: 1 });
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    await service.whenIdle();
    expect(service.peerResult('e'.repeat(32))).toMatchObject({ state: 'done', record: { outcome: 'failure' } });
    const file = path.join(fixture.paths.runDir, FAILURE_EVIDENCE_FILE);
    const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(evidence.diagnostics).toContainEqual(expect.objectContaining({ kind: 'reporter', step: 'unit', unhandledErrors: 1 }));
    expect(evidence.diagnostics).toContainEqual(expect.objectContaining({ kind: 'process', stderr: expect.stringContaining('NativeFixtureError') }));
    const app = express(); app.use(express.json()); registerLocalVerifyRoutes(app, { service: () => service, lease: { holdsLease: () => false, holderMachineId: () => 'owned-coordinator' } });
    const status = await inProcessHttp(app, 'GET', '/local-verify/peer-status');
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toContain('NativeFixtureError');
    service.shutdown();
    expect(fs.readFileSync(file, 'utf8')).toContain('NativeFixtureError');
    expect(fs.existsSync(fixture.paths.reportsDir)).toBe(false);
  } finally { service.shutdown(); SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'verify-diagnostics:production-lifecycle-cleanup' }); }
});
