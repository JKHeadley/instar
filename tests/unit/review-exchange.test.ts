/**
 * Tier-1 tests for the ReviewExchange engine (coordination-mandate spec §7 G2.3).
 *
 * Covers BOTH sides of every decision boundary: creation validation, the linear
 * state machine (no skips), the mandate gate on BOTH sign-offs (peer approve +
 * owner countersign — deny refuses, allow records the audit hash), the ungated
 * request-changes path (a refusal delegates nothing), named-party enforcement
 * (verdicts/signs from strangers refuse), deny-by-default with no mandate, and
 * persistence round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MandateStore } from '../../src/coordination/MandateStore.js';
import { MandateAudit } from '../../src/coordination/MandateAudit.js';
import { ConditionsRegistry } from '../../src/coordination/conditions.js';
import { MandateGate } from '../../src/coordination/MandateGate.js';
import { ReviewExchangeEngine } from '../../src/coordination/ReviewExchange.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const sign = (c: string) => `proof::${c}`;
const verifySig = (c: string, s: string) => s === `proof::${c}`;

const ECHO = 'fp-echo';
const DAWN = 'fp-dawn';
const FUTURE = '2999-01-01T00:00:00Z';
const SHA = 'a'.repeat(64);

describe('ReviewExchange engine (spec §7 G2.3)', () => {
  let dir: string;
  let store: MandateStore;
  let audit: MandateAudit;
  let gate: MandateGate;
  let engine: ReviewExchangeEngine;
  let n: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-'));
    n = 0;
    const now = () => 1_700_000_000_000 + (n++);
    store = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig, now, genId: () => `m-${n}` });
    audit = new MandateAudit({ filePath: path.join(dir, 'audit.jsonl'), now });
    gate = new MandateGate({ store, conditions: new ConditionsRegistry(), audit, now });
    engine = new ReviewExchangeEngine({ filePath: path.join(dir, 'exchanges.json'), gate, now, genId: () => `rex-${n}` });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/review-exchange.test.ts' }));

  function issueMandate() {
    return store.issue({
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN], author: 'justin', expiresAt: FUTURE,
      authorities: [{ action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } }],
    });
  }

  function createExchange(over: Partial<Parameters<ReviewExchangeEngine['create']>[0]> = {}) {
    return engine.create({
      id: 'rex-1', mandateId: 'mig-1', artifact: 'migration-port',
      packageRef: 'docs/feedback-migration-phase1-review-package.md',
      packageSha256: SHA, parties: [ECHO, DAWN], ...over,
    });
  }

  // ── creation validation ──

  it('creates an exchange in "proposed" and persists it', () => {
    issueMandate();
    const r = createExchange();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.state).toBe('proposed');
      expect(r.record.signatures).toEqual([]);
    }
    // Persistence round-trip through a fresh engine over the same file.
    const fresh = new ReviewExchangeEngine({ filePath: path.join(dir, 'exchanges.json'), gate });
    expect(fresh.get('rex-1')?.packageSha256).toBe(SHA);
  });

  it('rejects a malformed sha256, identical parties, missing fields, and duplicate ids', () => {
    issueMandate();
    expect(createExchange({ packageSha256: 'nope' }).ok).toBe(false);
    expect(createExchange({ packageSha256: SHA.toUpperCase() }).ok).toBe(false);
    expect(createExchange({ parties: [ECHO, ECHO] }).ok).toBe(false);
    expect(createExchange({ artifact: '' }).ok).toBe(false);
    expect(createExchange().ok).toBe(true);
    const dup = createExchange();
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/already exists/);
  });

  // ── linear state machine: no skips ──

  it('enforces the linear order: cannot verdict or sign before delivery', () => {
    issueMandate();
    createExchange();
    const verdict = engine.recordPeerVerdict('rex-1', { verdict: 'approve', summary: 's', evidence: 'tl-1', peerFp: DAWN });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/must be "delivered"/);
    const signed = engine.sign('rex-1', ECHO);
    expect(signed.ok).toBe(false);
    if (!signed.ok) expect(signed.reason).toMatch(/must be "verdict-recorded"/);
  });

  it('markDelivered requires evidence and the "proposed" state', () => {
    issueMandate();
    createExchange();
    expect(engine.markDelivered('rex-1', '').ok).toBe(false);
    const ok = engine.markDelivered('rex-1', 'threadline-msg-42');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.record.state).toBe('delivered');
    // Re-delivery refused.
    expect(engine.markDelivered('rex-1', 'again').ok).toBe(false);
    expect(engine.markDelivered('ghost', 'x').ok).toBe(false);
  });

  // ── the mandate gate on the PEER's approve (their sign-off) ──

  it('records the peer approve-verdict THROUGH the gate: signature carries the audit hash', () => {
    issueMandate();
    createExchange();
    engine.markDelivered('rex-1', 'tl-42');
    const r = engine.recordPeerVerdict('rex-1', { verdict: 'approve', summary: 'reviewed, four scars verified', evidence: 'tl-43', peerFp: DAWN });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.state).toBe('verdict-recorded');
      expect(r.record.signatures).toHaveLength(1);
      expect(r.record.signatures[0].kind).toBe('authenticated-peer-verdict');
      expect(r.record.signatures[0].agentFp).toBe(DAWN);
      // The signature's auditHash matches a real allow entry in the chained audit.
      const entry = audit.all().find((e) => e.hash === r.record.signatures[0].auditHash);
      expect(entry?.decision).toBe('allow');
      expect(entry?.agentFp).toBe(DAWN);
    }
  });

  it('DENY-BY-DEFAULT: with no mandate issued, the peer approve refuses (and is audited as deny)', () => {
    createExchange(); // no issueMandate()
    engine.markDelivered('rex-1', 'tl-42');
    const r = engine.recordPeerVerdict('rex-1', { verdict: 'approve', summary: 's', evidence: 'tl-43', peerFp: DAWN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mandate denied the peer sign-off/);
    expect(audit.all().some((e) => e.decision === 'deny' && e.agentFp === DAWN)).toBe(true);
    expect(engine.get('rex-1')?.state).toBe('delivered'); // unchanged
  });

  it('refuses a verdict from a non-peer (stranger AND the owner itself)', () => {
    issueMandate();
    createExchange();
    engine.markDelivered('rex-1', 'tl-42');
    const stranger = engine.recordPeerVerdict('rex-1', { verdict: 'approve', summary: 's', evidence: 'e', peerFp: 'fp-attacker' });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.reason).toMatch(/not the named peer/);
    const owner = engine.recordPeerVerdict('rex-1', { verdict: 'approve', summary: 's', evidence: 'e', peerFp: ECHO });
    expect(owner.ok).toBe(false);
  });

  it('an out-of-bounds artifact denies the sign-off (bounds enforcement end-to-end)', () => {
    issueMandate(); // bounds: artifact 'migration-port'
    createExchange({ artifact: 'something-else' });
    engine.markDelivered('rex-1', 'tl-42');
    const r = engine.recordPeerVerdict('rex-1', { verdict: 'approve', summary: 's', evidence: 'e', peerFp: DAWN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mandate denied/);
  });

  // ── request-changes: ungated terminal refusal ──

  it('request-changes records WITHOUT a gate allow and terminates the exchange', () => {
    // No mandate issued — a refusal must still be recordable (it delegates nothing).
    createExchange();
    engine.markDelivered('rex-1', 'tl-42');
    const r = engine.recordPeerVerdict('rex-1', { verdict: 'request-changes', summary: 'fix the seam', evidence: 'tl-44', peerFp: DAWN });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.state).toBe('changes-requested');
      expect(r.record.signatures).toEqual([]); // a refusal is NOT a signature
    }
    // Terminal: no signing a changes-requested exchange.
    expect(engine.sign('rex-1', ECHO).ok).toBe(false);
  });

  // ── the owner countersignature → complete ──

  it('full mutual lifecycle: deliver → peer approve → owner sign → complete with two gate-authorized signatures', () => {
    issueMandate();
    createExchange();
    engine.markDelivered('rex-1', 'tl-42');
    engine.recordPeerVerdict('rex-1', { verdict: 'approve', summary: 'ok', evidence: 'tl-43', peerFp: DAWN });
    const r = engine.sign('rex-1', ECHO);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.state).toBe('complete');
      expect(r.record.signatures).toHaveLength(2);
      const kinds = r.record.signatures.map((s) => s.kind).sort();
      expect(kinds).toEqual(['authenticated-peer-verdict', 'mandate-gated-local']);
      // BOTH audit hashes resolve to allow entries.
      for (const s of r.record.signatures) {
        expect(audit.all().find((e) => e.hash === s.auditHash)?.decision).toBe('allow');
      }
    }
  });

  it('refuses the owner sign from a non-owner, and denies via the gate when the mandate is revoked mid-exchange', () => {
    issueMandate();
    createExchange();
    engine.markDelivered('rex-1', 'tl-42');
    engine.recordPeerVerdict('rex-1', { verdict: 'approve', summary: 'ok', evidence: 'tl-43', peerFp: DAWN });
    // Wrong party.
    expect(engine.sign('rex-1', DAWN).ok).toBe(false);
    expect(engine.sign('rex-1', 'fp-attacker').ok).toBe(false);
    // Operator kill switch between the two signatures → the countersign DENIES.
    store.revoke('mig-1', 'operator kill-switch');
    const r = engine.sign('rex-1', ECHO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/revoked/);
    expect(engine.get('rex-1')?.state).toBe('verdict-recorded'); // NOT complete
  });
});
