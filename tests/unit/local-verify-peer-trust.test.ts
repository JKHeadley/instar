/**
 * Pure rules for how far a peer's main green is trusted (docs/specs/local-verify-peer-result-trust.md, D2).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  emptyPeerTrust, holdingDecision, noteDuration, noteLocallyVerified, olderClock, peerMainRoutingAllowed, peersGreenOn,
  readPeerTrust, refreshAgeMs, rememberPeerGreen, resetHoldingState, writePeerTrust, PEER_TRUST_LIMITS,
} from '../../src/localVerify/peerTrust.js';

const H = 3 * 60 * 60 * 1000;
const MIN = 60_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/local-verify-peer-trust.test.ts' }); });

describe('holding continuity (lease epoch rises on every boot)', () => {
  const self = 'm_coord';
  it('a restart while holding (epoch + 1) keeps the state; the same epoch keeps it', () => {
    expect(holdingDecision({ holder: self, epoch: 7 }, { holds: true, epoch: 8, holder: self }, self)).toBe('keep');
    expect(holdingDecision({ holder: self, epoch: 7 }, { holds: true, epoch: 7, holder: self }, self)).toBe('keep');
  });
  it('an epoch gap of 2 or more (another machine held it in between, A→B→A) resets', () => {
    expect(holdingDecision({ holder: self, epoch: 7 }, { holds: true, epoch: 9, holder: self }, self)).toBe('reset');
    expect(holdingDecision({ holder: self, epoch: 7 }, { holds: true, epoch: 6, holder: self }, self)).toBe('reset');
  });
  it('an unreadable read decides nothing; another holder is reported for the two-read rule', () => {
    expect(holdingDecision({ holder: self, epoch: 7 }, { unreadable: true, holds: false, epoch: null, holder: null }, self)).toBe('skip');
    expect(holdingDecision({ holder: self, epoch: 7 }, { holds: false, epoch: 8, holder: 'm_other' }, self)).toBe('other-holder');
  });
  it('no lease view on a single machine (null epochs both sides) is unbroken holding', () => {
    expect(holdingDecision({ holder: self, epoch: null }, { holds: true, epoch: null, holder: self }, self)).toBe('keep');
    expect(holdingDecision(null, { holds: true, epoch: null, holder: self }, self)).toBe('keep');
  });
  it('a null epoch read while a numbered epoch is on record decides nothing (it never wipes quarantines)', () => {
    expect(holdingDecision({ holder: self, epoch: 7 }, { holds: true, epoch: null, holder: self }, self)).toBe('skip');
  });
  it('a not-held read between two other-holder reads is reported as not-held (the caller resets its two-read count)', () => {
    expect(holdingDecision({ holder: self, epoch: 7 }, { holds: false, epoch: 8, holder: null }, self)).toBe('not-held');
  });
  it('a readable read where no one holds the lease is not another holder', () => {
    expect(holdingDecision({ holder: self, epoch: 7 }, { holds: false, epoch: 7, holder: null }, self)).toBe('not-held');
  });
  it('a reset keeps the measured durations and drops everything else', () => {
    const s = emptyPeerTrust();
    s.anchor = { head: 'a'.repeat(40), finishedAt: 'x' };
    s.quarantine.p = { head: 'a'.repeat(40), at: 1, arbitrated: false };
    noteDuration(s, 5 * MIN);
    const r = resetHoldingState(s, { holder: self, epoch: 9 });
    expect(r.anchor).toBeNull();
    expect(r.quarantine).toEqual({});
    expect(r.durations).toEqual([5 * MIN]);
    expect(r.holding).toEqual({ holder: self, epoch: 9, since: 9 }); // a new holding starts at its own epoch (local-verify-peer-works-through-restart C.1)
  });
});

describe('refresh age and routing', () => {
  const ten = (ms: number) => Array.from({ length: 10 }, () => ms);
  it('fewer than 10 local durations: no measurement, so main stays local', () => {
    expect(refreshAgeMs(ten(20 * MIN).slice(0, 9), H)).toBeNull();
  });
  it('fast runs reach the 2.5 h cap; a slow p90 hands main back earlier; too slow leaves no room', () => {
    expect(refreshAgeMs(ten(20 * MIN), H)).toBe(PEER_TRUST_LIMITS.refreshCapMs);
    expect(refreshAgeMs(ten(90 * MIN), H)).toBe(H - 135 * MIN); // 45 minutes
    expect(refreshAgeMs(ten(120 * MIN), H)!).toBeLessThanOrEqual(0);
  });
  it('routing to peers needs an anchor, a measurement, room in the bound, and a second clock younger than the refresh age', () => {
    const s = emptyPeerTrust();
    expect(peerMainRoutingAllowed(s, 0, H).why).toBe('no-anchor');
    s.anchor = { head: 'a'.repeat(40), finishedAt: 'x' };
    expect(peerMainRoutingAllowed(s, 0, H).why).toBe('unmeasured');
    s.durations = ten(20 * MIN);
    s.notLocallyVerifiedAt = 0;
    expect(peerMainRoutingAllowed(s, 2 * 60 * MIN, H)).toEqual({ allowed: true, why: null });
    expect(peerMainRoutingAllowed(s, 2.5 * 60 * MIN + 1, H).why).toBe('refresh-age');
    s.durations = ten(120 * MIN);
    expect(peerMainRoutingAllowed(s, 0, H).why).toBe('too-slow');
  });
  it('the older of two clocks counts; null means nothing unverified', () => {
    expect(olderClock(null, null)).toBeNull();
    expect(olderClock(5, null)).toBe(5);
    expect(olderClock(5, 3)).toBe(3);
  });
});

describe('peer greens, local heads and persistence', () => {
  it('remembers one entry per head and peer, bounded, and matches on verifier and policy', () => {
    const s = emptyPeerTrust();
    rememberPeerGreen(s, { head: 'h1', peer: 'p', verifierVersion: 'v', policyHash: 'x', at: 1 });
    rememberPeerGreen(s, { head: 'h1', peer: 'p', verifierVersion: 'v', policyHash: 'x', at: 2 });
    rememberPeerGreen(s, { head: 'h1', peer: 'q', verifierVersion: 'v2', policyHash: 'x', at: 3 });
    expect(peersGreenOn(s, 'h1', 'v', 'x')).toEqual(['p']);
    for (let i = 0; i < 60; i++) rememberPeerGreen(s, { head: `h${i + 10}`, peer: 'p', verifierVersion: 'v', policyHash: 'x', at: i });
    expect(s.peerMainGreens).toHaveLength(PEER_TRUST_LIMITS.peerMainGreensKept);
    noteLocallyVerified(s, 'h1');
    noteLocallyVerified(s, 'h1');
    expect(s.locallyVerified).toEqual(['h1']);
  });
  it('round-trips through its file; unreadable or malformed reads as empty', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-trust-'));
    dirs.push(d);
    const file = path.join(d, 'state', 'local-verify', 'peer-trust.json');
    expect(readPeerTrust(file)).toEqual(emptyPeerTrust());
    const s = emptyPeerTrust();
    s.anchor = { head: 'a'.repeat(40), finishedAt: 'x' };
    writePeerTrust(file, s);
    expect(readPeerTrust(file).anchor).toEqual(s.anchor);
    fs.writeFileSync(file, '{"v":2}');
    expect(readPeerTrust(file)).toEqual(emptyPeerTrust());
  });
});
