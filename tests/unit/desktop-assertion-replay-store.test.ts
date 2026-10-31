import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopAssertionReplayStore } from '../../src/core/DesktopAssertionReplayStore.js';
import { mintDesktopOperatorAssertion, verifyDesktopOperatorAssertion } from '../../src/core/DesktopOperatorAssertion.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('DesktopAssertionReplayStore', () => {
  it('records an assertion accepted at the allowed clock-skew boundary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-replay-skew-'));
    try {
      const targetNow = 100_000;
      const store = new DesktopAssertionReplayStore(path.join(dir, 'state.json'), () => targetNow);
      const browserPublicKey = 'browser-public-key';
      const browserNonce = 'N'.repeat(24);
      const assertion = mintDesktopOperatorAssertion({
        issuerMachineId: `m_${'a'.repeat(32)}`, targetMachineId: `m_${'b'.repeat(32)}`,
        browserPublicKey, browserNonce, nowMs: targetNow + 100,
        sign: () => 'S'.repeat(64),
      });
      const verdict = verifyDesktopOperatorAssertion({
        assertion, expectedTargetMachineId: assertion.targetMachineId,
        expectedIssuerMachineId: assertion.issuerMachineId, browserPublicKey, browserNonce,
        nowMs: targetNow, resolveIssuerKey: () => 'key', verifySignature: () => true,
        seenJti: jti => store.seen(jti),
      });
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) throw new Error('expected a valid assertion');
      expect(() => store.record(verdict.jti, assertion.expiresAtMs)).not.toThrow();
      expect(store.seen(verdict.jti)).toBe(true);
      expect(() => store.record(verdict.jti, assertion.expiresAtMs)).toThrow('desktop-operator-replayed');
      const atLimit = mintDesktopOperatorAssertion({
        issuerMachineId: assertion.issuerMachineId, targetMachineId: assertion.targetMachineId,
        browserPublicKey, browserNonce, nowMs: targetNow + 2_000,
        sign: () => 'S'.repeat(64),
      });
      const atLimitVerdict = verifyDesktopOperatorAssertion({
        assertion: atLimit, expectedTargetMachineId: assertion.targetMachineId,
        expectedIssuerMachineId: assertion.issuerMachineId, browserPublicKey, browserNonce,
        nowMs: targetNow, resolveIssuerKey: () => 'key', verifySignature: () => true,
        seenJti: jti => store.seen(jti),
      });
      expect(atLimitVerdict.ok).toBe(true);
      if (!atLimitVerdict.ok) throw new Error('expected boundary assertion');
      expect(() => store.record(atLimitVerdict.jti, atLimit.expiresAtMs)).not.toThrow();
      expect(() => store.record('Z'.repeat(32), targetNow + 32_001)).toThrow('desktop-replay-invalid');
      const tooFarAhead = mintDesktopOperatorAssertion({
        issuerMachineId: assertion.issuerMachineId, targetMachineId: assertion.targetMachineId,
        browserPublicKey, browserNonce, nowMs: targetNow + 2_001,
        sign: () => 'S'.repeat(64),
      });
      expect(verifyDesktopOperatorAssertion({
        assertion: tooFarAhead, expectedTargetMachineId: assertion.targetMachineId,
        expectedIssuerMachineId: assertion.issuerMachineId, browserPublicKey, browserNonce,
        nowMs: targetNow, resolveIssuerKey: () => 'key', verifySignature: () => true,
        seenJti: jti => store.seen(jti),
      })).toEqual({ ok: false, reason: 'not-yet-valid' });
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-assertion-replay-store-test-cleanup' }); }
  });
  it('refuses reuse after a target process restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-replay-'));
    try {
      const file = path.join(dir, 'state.json');
      const jti = 'A'.repeat(32);
      new DesktopAssertionReplayStore(file, () => 100).record(jti, 30_100);
      const restarted = new DesktopAssertionReplayStore(file, () => 200);
      expect(restarted.seen(jti)).toBe(true);
      expect(() => restarted.record(jti, 30_100)).toThrow('desktop-operator-replayed');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-assertion-replay-store-test-cleanup' }); }
  });

  it('denies admission if replay state is unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-replay-'));
    try {
      const file = path.join(dir, 'state.json');
      fs.writeFileSync(file, '{invalid');
      const store = new DesktopAssertionReplayStore(file, () => 100);
      expect(() => store.seen('B'.repeat(32))).toThrow();
      expect(() => store.record('B'.repeat(32), 30_100)).toThrow();
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-assertion-replay-store-test-cleanup' }); }
  });

  it('refuses an oversized replay ledger before parsing it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-replay-'));
    try {
      const file = path.join(dir, 'state.json');
      fs.writeFileSync(file, ' '.repeat(100_001));
      expect(() => new DesktopAssertionReplayStore(file).seen('C'.repeat(32)))
        .toThrow('desktop-replay-ledger-over-capacity');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-assertion-replay-store-test-cleanup' }); }
  });
});
