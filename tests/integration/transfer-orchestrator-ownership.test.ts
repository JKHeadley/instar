/**
 * Integration test (§L3 + §L5): the TransferOrchestrator driving a handoff against
 * the REAL SessionOwnershipRegistry transfer FSM (active(S)→transferring→active(T))
 * and the REAL verifyLedgerSnapshot (with a real SHA-256). Proves the orchestrator's
 * CAS sequence moves ownership correctly through the state machine, and that a
 * non-terminal (in_flight) ledger snapshot causes a sync-corrupted abort that leaves
 * the record at `transferring` (S still the draining owner — no no-owner gap, no
 * double-run) and never claims the target.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { TransferOrchestrator, verifyLedgerSnapshot, type LedgerSnapshot, type TransferOrchestratorDeps } from '../../src/core/TransferOrchestrator.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';

const SESSION = 'sess-T';
function sha(s: LedgerSnapshot): string {
  const canonical = JSON.stringify({ sessionKey: s.sessionKey, entries: s.entries.map((e) => [e.messageId, e.status]) });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
function snapshotWith(statuses: Array<'reply_committed' | 'cursor_advanced' | 'in_flight'>): LedgerSnapshot {
  const entries = statuses.map((status, i) => ({ messageId: `m${i}`, status, updatedAt: i }));
  const base: LedgerSnapshot = { sessionKey: SESSION, generatedAt: 1, entries, snapshotSha256: '' };
  return { ...base, snapshotSha256: sha(base) };
}

describe('TransferOrchestrator over the real ownership FSM (§L3/§L5)', () => {
  let registry: SessionOwnershipRegistry;
  let nonce: number;
  let released: string[];

  beforeEach(() => {
    const seen = new Set<string>();
    registry = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => seen.has(k), recordNonce: (k) => seen.add(k) });
    nonce = 0;
    released = [];
    // Seed: place(S) → claim(S) → active(S).
    registry.cas({ type: 'place', machineId: 'S' }, { sessionKey: SESSION, sender: 'ROUTER', nonce: `n${++nonce}` });
    registry.cas({ type: 'claim', machineId: 'S' }, { sessionKey: SESSION, sender: 'S', nonce: `n${++nonce}` });
  });

  function makeDeps(snapshot: LedgerSnapshot): TransferOrchestratorDeps {
    return {
      casToTransferring: (sessionKey, target) => {
        const r = registry.cas({ type: 'transfer', to: target }, { sessionKey, sender: 'S', nonce: `n${++nonce}` });
        return { ok: r.ok, epoch: registry.read(sessionKey)?.ownershipEpoch ?? 0 };
      },
      drain: async () => ({ drained: true, abandonedPartial: false }),
      flushLedger: async () => ({ snapshot, ledgerSnapshotRef: 'git:ref', syncManifestRef: 'git:man' }),
      // The target pulls + verifies the snapshot with the REAL verify (SHA + all-terminal).
      sendTransferRpc: async () => {
        const v = verifyLedgerSnapshot(snapshot, snapshot.snapshotSha256, sha);
        return { ok: true, verified: v.ok, reason: v.ok ? undefined : v.reason };
      },
      targetClaim: (sessionKey) => {
        const r = registry.cas({ type: 'claim', machineId: 'T' }, { sessionKey, sender: 'T', nonce: `n${++nonce}` });
        return { ok: r.ok, epoch: registry.read(sessionKey)?.ownershipEpoch ?? 0 };
      },
      releaseSource: (sessionKey) => { released.push(sessionKey); },
      raiseAttention: () => {},
      now: () => 5000,
      sleep: async () => {},
    };
  }

  it('completes a clean transfer: ownership moves S → T through the real FSM', async () => {
    const out = await new TransferOrchestrator(makeDeps(snapshotWith(['reply_committed', 'cursor_advanced'])), { transferDrainTimeoutMs: 30000, transferOutputCutoffMs: 0 }).transfer({ sessionKey: SESSION, source: 'S', target: 'T', reason: 'pin', sourceAlive: true, baseEpoch: 2 });

    expect(out).toMatchObject({ ok: true, status: 'transferred' });
    const rec = registry.read(SESSION)!;
    expect(rec.status).toBe('active');
    expect(rec.ownerMachineId).toBe('T');
    expect(rec.ownershipEpoch).toBe(4); // place(1)→claim(2)→transfer(3)→claim(4)
    expect(registry.ownerOf(SESSION)).toBe('T');
    expect(released).toEqual([SESSION]); // source teardown ran after the target claimed
  });

  it('aborts sync-corrupted on an in_flight snapshot: record stays transferring (S draining), T never claims', async () => {
    const out = await new TransferOrchestrator(makeDeps(snapshotWith(['reply_committed', 'in_flight']))).transfer({ sessionKey: SESSION, source: 'S', target: 'T', reason: 'pin', sourceAlive: true, baseEpoch: 2 });

    expect(out).toMatchObject({ ok: false, status: 'sync-corrupted', detail: 'in-flight-entry' });
    const rec = registry.read(SESSION)!;
    // No no-owner gap: the record is transferring and still names S as the draining owner.
    expect(rec.status).toBe('transferring');
    expect(rec.ownerMachineId).toBe('S');
    expect(rec.transferTo).toBe('T');
    expect(registry.ownerOf(SESSION)).not.toBe('T'); // T never became active
    expect(released).toEqual([]); // source NOT torn down — no valid new owner
  });
});
