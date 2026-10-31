// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { FailedFileDiagnosisCoordinator } from '../../../src/localVerify/FailedFileDiagnosisCoordinator.js';
import { diagnosisKey } from '../../../src/localVerify/failedFileDiagnosis.js';
import type { DiagnosisPeerClient, DiagnosisPeerRequest } from '../../../src/localVerify/failedFileDiagnosisPeer.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';

const H = 'a'.repeat(40), B = 'b'.repeat(40), P = 'c'.repeat(64), F = 'tests/unit/a.test.ts';
const record = { repo: 'JKHeadley/instar', pr: 9, headSha: H, baseSha: B, baseRefName: 'main',
  verifierVersion: 'v1', policyHash: P, outcome: 'failure', harnessChanging: false, protectedPath: false,
  failedFiles: [F], lanes: [{ name: 'unit', failed: 1 }], finishedAt: '2026-10-31T10:00:00.000Z' } as LocalVerifyRecord;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true,
  operation: 'FailedFileDiagnosisCoordinator.test.ts' }); });

function harness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-diag-coord-'));
  roots.push(stateDir);
  let mode: 'off' | 'observe' | 'auto' = 'auto';
  let head = H, base = B, open = true;
  let now = Date.parse('2026-10-31T10:01:00.000Z');
  let onResult: (() => void) | null = null;
  let busyRefusal = false;
  const sent: DiagnosisPeerRequest[] = [];
  const audit: Record<string, unknown>[] = [];
  const client: DiagnosisPeerClient = {
    status: async () => ({ enabled: true, busy: false, verifierVersion: 'v1', policyHash: P }),
    diagnose: async (_peer, request) => { sent.push(request); return busyRefusal
      ? { accepted: false, reason: 'busy' } : { accepted: true }; },
    result: async (_peer, id) => { onResult?.(); return { state: 'done', answer: {
      attemptId: id, identity: { repo: record.repo, pr: record.pr, headSha: H, baseSha: B,
        baseRefName: 'main', verifierVersion: 'v1', policyHash: P, failedFiles: [F] },
      peerMachineId: 'm5', coordinatorMachineId: 'studio', leaseEpoch: 7,
      classification: 'pr-reproducible', files: [{ file: F, originalPr: 'assertion-fail', peerPr: 'assertion-fail', peerBase: 'pass' }],
      machineMinutes: 1,
    } }; },
  };
  const cfg = { stateDir, repo: record.repo, machineId: 'studio', verifierVersion: 'v1', policyHash: P };
  const deps: ConstructorParameters<typeof FailedFileDiagnosisCoordinator>[1] = {
    now: () => now, mode: () => mode, holdsLease: () => true, leaseEpoch: () => 7,
    peers: () => [{ machineId: 'm5', url: 'http://m5:4042' }], fullVerifyWaiting: () => false,
    prView: async () => ({ headRefOid: head, baseRefName: 'main' }), baseHead: async () => base,
    isPrOpen: async () => open, client, audit: (event) => { audit.push(event); },
  };
  const coordinator = new FailedFileDiagnosisCoordinator(cfg, deps);
  return { coordinator, sent, audit, setMode: (v: typeof mode) => { mode = v; },
    setHead: (v: string) => { head = v; }, setBase: (v: string) => { base = v; },
    setOpen: (v: boolean) => { open = v; }, advance: (ms: number) => { now += ms; },
    setBusyRefusal: (value: boolean) => { busyRefusal = value; },
    restart: () => new FailedFileDiagnosisCoordinator(cfg, deps),
    onResult: (fn: () => void) => { onResult = fn; } };
}

describe('failed-file diagnosis coordinator', () => {
  it('refuses stale records before reserving a peer attempt', async () => {
    const h = harness();
    h.setHead('d'.repeat(40));
    await h.coordinator.tick([record]);
    expect(h.sent).toHaveLength(0);
    expect(h.coordinator.summary().pending).toBe(0);
  });

  it('persists one exact attempt and imports only its advisory answer', async () => {
    const h = harness();
    await h.coordinator.tick([record]);
    expect(h.sent).toHaveLength(1);
    expect(h.coordinator.forRecord(record)?.state).toBe('running');
    h.setMode('off'); // Turning off stops new work but still collects the active result.
    await h.coordinator.tick([record]);
    expect(h.coordinator.forRecord(record)?.result?.classification).toBe('pr-reproducible');
    expect(h.coordinator.summary()).toMatchObject({ mode: 'off', completed: 1, pending: 0 });
    await h.coordinator.tick([record]);
    expect(h.sent).toHaveLength(1);
    expect(diagnosisKey(h.sent[0])).toHaveLength(64);
  });

  it('invalidates a result when the PR head moves during the peer response', async () => {
    const h = harness();
    await h.coordinator.tick([record]);
    h.onResult(() => h.setHead('d'.repeat(40)));
    await h.coordinator.tick([record]);
    expect(h.coordinator.forRecord(record)?.result).toMatchObject({ classification: 'inconclusive',
      reason: 'head-base-or-target-moved' });
  });

  it('settles after one busy refusal, including across coordinator restart', async () => {
    const h = harness();
    h.setBusyRefusal(true);
    await h.coordinator.tick([record]);
    expect(h.sent).toHaveLength(1);
    expect(h.coordinator.forRecord(record)?.result).toMatchObject({ classification: 'inconclusive', reason: 'peer-busy' });
    for (let i = 0; i < 10; i++) await h.coordinator.tick([record]);
    const restarted = h.restart();
    for (let i = 0; i < 10; i++) await restarted.tick([record]);
    expect(h.sent).toHaveLength(1);
  });

  it('does not rediagnose an old red record after journal retention expires', async () => {
    const h = harness();
    await h.coordinator.tick([record]);
    expect(h.sent).toHaveLength(1);
    await h.coordinator.tick([record]);
    expect(h.coordinator.forRecord(record)?.state).toBe('done');
    h.advance(15 * 24 * 60 * 60_000);
    const restarted = h.restart();
    // A fresh, distinct diagnosis forces journal pruning after the 14-day retention window.
    await restarted.tick([{ ...record, pr: 10, finishedAt: '2026-11-15T10:00:00.000Z' }]);
    await restarted.tick([record]);
    expect(restarted.forRecord(record)).toBeNull(); // the terminal marker expired
    expect(h.sent).toHaveLength(2); // only the fresh PR was admitted
  });
});
