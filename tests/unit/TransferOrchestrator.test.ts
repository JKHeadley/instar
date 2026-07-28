/**
 * Tier-1 tests for TransferOrchestrator + verifyLedgerSnapshot (Multi-Machine
 * Session Pool §L3/§L5 handoff). Drives the ordered sequence and asserts the two
 * timing contracts: drain bound (abandon partial) + output exclusion (T holds its
 * CONTINUATION until the cutoff window since `transferring`). Also covers the abort
 * paths (CAS lost, sync-corrupted, target-claim-failed) and ledger-snapshot verify.
 */
import { describe, it, expect, vi } from 'vitest';
import { TransferOrchestrator, verifyLedgerSnapshot, type TransferOrchestratorDeps, type TransferRequest, type LedgerSnapshot } from '../../src/core/TransferOrchestrator.js';

function snapshot(over: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return { sessionKey: 's1', generatedAt: 1, entries: [{ messageId: 'm1', status: 'reply_committed', updatedAt: 1 }], snapshotSha256: 'SHA', ...over };
}
const req: TransferRequest = { sessionKey: 's1', source: 'S', target: 'T', reason: 'pin', sourceAlive: true, baseEpoch: 4 };

function deps(over: Partial<TransferOrchestratorDeps> = {}): { d: TransferOrchestratorDeps; calls: string[] } {
  const calls: string[] = [];
  let t = 1000;
  const d: TransferOrchestratorDeps = {
    casToTransferring: vi.fn((_s, _t, e) => { calls.push('transferring'); return { ok: true, epoch: e + 1 }; }),
    drain: vi.fn(async () => { calls.push('drain'); return { drained: true, abandonedPartial: false }; }),
    flushLedger: vi.fn(async () => { calls.push('flush'); return { snapshot: snapshot(), ledgerSnapshotRef: 'ref', syncManifestRef: 'man' }; }),
    sendTransferRpc: vi.fn(async () => { calls.push('send'); return { ok: true, verified: true }; }),
    targetClaim: vi.fn((_s, e) => { calls.push('claim'); return { ok: true, epoch: e + 1 }; }),
    releaseSource: vi.fn(() => { calls.push('release'); }),
    raiseAttention: vi.fn(),
    now: () => (t += 1),
    sleep: vi.fn(async () => { calls.push('sleep'); }),
    ...over,
  };
  return { d, calls };
}

describe('TransferOrchestrator (§L3/§L5)', () => {
  it('drives the ordered sequence transferring→drain→flush→send→[cutoff]→claim→release', async () => {
    const { d, calls } = deps();
    const out = await new TransferOrchestrator(d).transfer(req);
    expect(out).toMatchObject({ ok: true, status: 'transferred' });
    // claim happens AFTER release? No — release is cleanup AFTER claim.
    expect(calls).toEqual(['transferring', 'drain', 'flush', 'send', 'sleep', 'claim', 'release']);
  });

  it('holds the target CONTINUATION (sleep) until the output-cutoff window elapses', async () => {
    const { d } = deps();
    await new TransferOrchestrator(d, { transferDrainTimeoutMs: 30000, transferOutputCutoffMs: 1000 }).transfer(req);
    // now() advances by 1 each call; transferringAt and the elapsed check leave ~999ms.
    expect(d.sleep).toHaveBeenCalledOnce();
    const waited = (d.sleep as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(1000);
  });

  it('does NOT sleep when the cutoff has already elapsed (drain took longer than the window)', async () => {
    let t = 1000;
    const { d } = deps({ now: () => (t += 1200) }); // each now() jumps 1200ms > the 1000ms cutoff
    await new TransferOrchestrator(d, { transferDrainTimeoutMs: 30000, transferOutputCutoffMs: 1000 }).transfer(req);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('records an abandoned partial when the drain timed out (no channel output past the deadline)', async () => {
    const { d } = deps({ drain: vi.fn(async () => ({ drained: false, abandonedPartial: true })) });
    const out = await new TransferOrchestrator(d).transfer(req);
    expect(out.ok).toBe(true);
    expect(out.drainAbandoned).toBe(true);
  });

  it('aborts cleanly if the source cannot enter transferring (CAS lost)', async () => {
    const { d } = deps({ casToTransferring: vi.fn(() => ({ ok: false, epoch: 9 })) });
    const out = await new TransferOrchestrator(d).transfer(req);
    expect(out).toMatchObject({ ok: false, status: 'aborted-cas-lost' });
    // Nothing past the failed CAS ran.
    expect(d.drain).not.toHaveBeenCalled();
    expect(d.flushLedger).not.toHaveBeenCalled();
    expect(d.sendTransferRpc).not.toHaveBeenCalled();
  });

  it('treats a transport-failed sendTransferRpc (ok:false) as sync-corrupted — does NOT claim (2026-05-29 review #9)', async () => {
    const { d, calls } = deps({ sendTransferRpc: vi.fn(async () => ({ ok: false, verified: false, reason: 'mesh-rpc-503' })) });
    const out = await new TransferOrchestrator(d).transfer(req);
    expect(out).toMatchObject({ ok: false, status: 'sync-corrupted', detail: 'mesh-rpc-503' });
    expect(d.raiseAttention).toHaveBeenCalled();
    expect(calls).not.toContain('claim');
    expect(calls).not.toContain('release');
  });

  it('escalates (sync-corrupted) and does NOT claim when the target verify fails', async () => {
    const { d, calls } = deps({ sendTransferRpc: vi.fn(async () => ({ ok: true, verified: false, reason: 'in-flight-entry' })) });
    const out = await new TransferOrchestrator(d).transfer(req);
    expect(out).toMatchObject({ ok: false, status: 'sync-corrupted', detail: 'in-flight-entry' });
    expect(d.raiseAttention).toHaveBeenCalled();
    expect(calls).not.toContain('claim');
    expect(calls).not.toContain('release'); // source NOT released — no valid new owner
  });

  it('reports target-claim-failed if T cannot CAS to active (no double-run, no release)', async () => {
    const { d, calls } = deps({ targetClaim: vi.fn(() => ({ ok: false, epoch: 6 })) });
    const out = await new TransferOrchestrator(d).transfer(req);
    expect(out).toMatchObject({ ok: false, status: 'target-claim-failed' });
    expect(calls).not.toContain('release');
  });
});

describe('verifyLedgerSnapshot (§L5)', () => {
  const sha = (s: LedgerSnapshot) => s.snapshotSha256; // identity for the test

  it('accepts a snapshot whose SHA matches and whose entries are all terminal', () => {
    expect(verifyLedgerSnapshot(snapshot(), 'SHA', sha)).toEqual({ ok: true });
  });

  it('rejects a SHA mismatch (tamper / partial sync)', () => {
    expect(verifyLedgerSnapshot(snapshot(), 'OTHER', sha)).toEqual({ ok: false, reason: 'sha-mismatch' });
  });

  it('rejects a snapshot with any in_flight entry (a turn was still processing)', () => {
    const s = snapshot({ entries: [{ messageId: 'm1', status: 'cursor_advanced', updatedAt: 1 }, { messageId: 'm2', status: 'in_flight', updatedAt: 2 }] });
    expect(verifyLedgerSnapshot(s, 'SHA', sha)).toEqual({ ok: false, reason: 'in-flight-entry' });
  });
});
