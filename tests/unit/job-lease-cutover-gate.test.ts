/**
 * Unit tests — JobLeaseCutoverGate (WS4.3 journal-lease cutover discipline).
 *
 * The load-bearing invariant: the journal-lease path engages ONLY when the
 * pool is flag-coherent (every online peer advertises ws43JournalLease), and
 * never alongside the bus for the same job set. Adversarial lenses: a mixed
 * pool, an offline incoherent peer, a flag flip, dry-run, single-machine no-op.
 */

import { describe, it, expect } from 'vitest';
import { decideClaimPath, type CutoverPeerAdvert } from '../../src/scheduler/JobLeaseCutoverGate.js';

const coherentPeer = (id: string): CutoverPeerAdvert => ({ machineId: id, online: true, ws43JournalLease: true });
const incoherentPeer = (id: string): CutoverPeerAdvert => ({ machineId: id, online: true, ws43JournalLease: false });
const olderPeer = (id: string): CutoverPeerAdvert => ({ machineId: id, online: true }); // no flags field

describe('JobLeaseCutoverGate.decideClaimPath', () => {
  it('flag OFF → bus path, byte-for-byte today', () => {
    const d = decideClaimPath({ enabled: false, dryRun: false, peers: [coherentPeer('m2')] });
    expect(d.path).toBe('bus');
    expect(d.reason).toBe('flag-off');
    expect(d.journalDryRun).toBe(false);
  });

  it('single-machine (no peers) → strict no-op on the bus even when flag on', () => {
    const d = decideClaimPath({ enabled: true, dryRun: false, peers: [] });
    expect(d.path).toBe('bus');
    expect(d.reason).toBe('single-machine');
  });

  it('all peers offline → treated as single-machine (no online participant)', () => {
    const d = decideClaimPath({
      enabled: true, dryRun: false,
      peers: [{ machineId: 'm2', online: false, ws43JournalLease: true }],
    });
    expect(d.path).toBe('bus');
    expect(d.reason).toBe('single-machine');
  });

  it('coherent pool (flag on, all online peers advertise) → journal path', () => {
    const d = decideClaimPath({ enabled: true, dryRun: false, peers: [coherentPeer('m2'), coherentPeer('m3')] });
    expect(d.path).toBe('journal');
    expect(d.reason).toBe('journal-coherent');
    expect(d.incoherentPeers).toEqual([]);
  });

  it('ONE peer not advertising → whole pool stays on the bus (never-both invariant)', () => {
    const d = decideClaimPath({ enabled: true, dryRun: false, peers: [coherentPeer('m2'), incoherentPeer('m3')] });
    expect(d.path).toBe('bus');
    expect(d.reason).toBe('peers-incoherent');
    expect(d.incoherentPeers).toEqual(['m3']);
  });

  it('older peer (absent flags field) counts as NOT advertising → bus (invariant-5)', () => {
    const d = decideClaimPath({ enabled: true, dryRun: false, peers: [coherentPeer('m2'), olderPeer('m_old')] });
    expect(d.path).toBe('bus');
    expect(d.reason).toBe('peers-incoherent');
    expect(d.incoherentPeers).toEqual(['m_old']);
  });

  it('an OFFLINE incoherent peer does NOT block coherence (excluded)', () => {
    const d = decideClaimPath({
      enabled: true, dryRun: false,
      peers: [coherentPeer('m2'), { machineId: 'm_old', online: false }],
    });
    expect(d.path).toBe('journal');
    expect(d.reason).toBe('journal-coherent');
  });

  it('coherent pool + dry-run → bus path BUT journalDryRun flagged (log intended, never half-migrate)', () => {
    const d = decideClaimPath({ enabled: true, dryRun: true, peers: [coherentPeer('m2')] });
    expect(d.path).toBe('bus');
    expect(d.reason).toBe('dry-run');
    expect(d.journalDryRun).toBe(true);
  });

  it('NEVER returns both mechanisms — every decision is exactly one path', () => {
    const inputs = [
      { enabled: false, dryRun: false, peers: [] },
      { enabled: true, dryRun: false, peers: [] },
      { enabled: true, dryRun: false, peers: [coherentPeer('m2')] },
      { enabled: true, dryRun: false, peers: [incoherentPeer('m2')] },
      { enabled: true, dryRun: true, peers: [coherentPeer('m2')] },
    ];
    for (const input of inputs) {
      const d = decideClaimPath(input);
      expect(['journal', 'bus']).toContain(d.path);
      // journalDryRun can only be true alongside the bus path (never journal).
      if (d.journalDryRun) expect(d.path).toBe('bus');
    }
  });
});
