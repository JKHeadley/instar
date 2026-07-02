/**
 * silent-loss-refusal-conservation §2.D — the SenderValidationGate arm decision.
 * The gate never arms against a degenerate / never-populated / corrupt /
 * operator-unresolvable registry (fail toward delivery + shout); it keeps
 * rejecting a genuinely-unresolved sender against a HEALTHY populated registry
 * (real deauth still works); and a transiently-locked POPULATED store still arms.
 */
import { describe, it, expect, vi } from 'vitest';
import { SenderValidationGate, type SenderValidationGateDeps } from '../../src/core/senderValidationGate.js';
import type { RegistryClass } from '../../src/core/registryHighWater.js';

function gate(over: Partial<SenderValidationGateDeps> & { klass?: RegistryClass } = {}) {
  const alert = vi.fn();
  const log = vi.fn();
  const deps: SenderValidationGateDeps = {
    usersFilePath: '/nope/users.json',
    stateDir: '/nope',
    statUsers: () => ({ mtimeMs: 1, size: 10 }),
    resolveUid: over.resolveUid ?? (() => true),
    operatorUidForTopic: over.operatorUidForTopic ?? (() => null),
    alert,
    log,
    classify: () => ({ klass: over.klass ?? 'populated', detail: 'test', rawUserCount: 1 }),
    ...over,
  };
  return { g: new SenderValidationGate(deps), alert, log };
}

describe('§2.D SenderValidationGate', () => {
  it('degenerate registry → DISARM → deliver (fail toward delivery) + alert', () => {
    const { g, alert } = gate({ klass: 'degenerate', resolveUid: () => false });
    const d = g.decide(1234, '42');
    expect(d.verdict).toBe('deliver');
    expect(d.armed).toBe(false);
    expect(alert).toHaveBeenCalled();
  });

  it('populated + healthy + sender resolves → deliver (armed)', () => {
    const { g } = gate({ klass: 'populated', resolveUid: (uid) => uid === 1234 });
    expect(g.decide(1234, '42')).toMatchObject({ verdict: 'deliver', armed: true });
  });

  it('populated + healthy + sender does NOT resolve → REJECT (real deauth still works)', () => {
    const { g } = gate({ klass: 'populated', resolveUid: () => false, operatorUidForTopic: () => null });
    expect(g.decide(1234, '42')).toMatchObject({ verdict: 'reject', armed: true });
  });

  it('operator-resolution disarm: a bound operator that does NOT resolve → DISARM → deliver (the incident signature)', () => {
    // operator uid 55 is bound but the registry can't resolve it (fixture-clobbered).
    const { g, alert } = gate({
      klass: 'populated',
      operatorUidForTopic: () => 55,
      resolveUid: () => false, // nobody resolves — the clobbered store
    });
    const d = g.decide(1234, '42');
    expect(d.verdict).toBe('deliver');
    expect(d.armed).toBe(false);
    expect(d.reason).toContain('operator-unresolvable');
    expect(alert).toHaveBeenCalled();
  });

  it('populated-registry-always-arms: a bound operator that DOES resolve → armed, unresolved sender rejected', () => {
    const { g } = gate({
      klass: 'populated',
      operatorUidForTopic: () => 55,
      resolveUid: (uid) => uid === 55, // operator resolves, sender does not
    });
    expect(g.decide(1234, '42')).toMatchObject({ verdict: 'reject', armed: true });
  });

  it('unknown-unsafe (corrupt) → fail CLOSED (reject unresolved) + HIGH alert', () => {
    const { g, alert } = gate({ klass: 'unknown-unsafe', resolveUid: () => false, operatorUidForTopic: () => null });
    expect(g.decide(1234, '42')).toMatchObject({ verdict: 'reject', armed: true });
    expect(alert).toHaveBeenCalledWith('HIGH', expect.stringContaining('unknown-unsafe'), expect.any(String));
  });

  it('unknown-unsafe but the sender IS the locally-bound operator → deliver via the binding (KYP)', () => {
    const { g } = gate({ klass: 'unknown-unsafe', resolveUid: () => false, operatorUidForTopic: () => 1234 });
    expect(g.decide(1234, '42')).toMatchObject({ verdict: 'deliver', armed: true });
  });

  it('non-numeric / zero uid → deliver (Slack sender re-validation is tracked-followup 4)', () => {
    const { g } = gate({ klass: 'populated', resolveUid: () => false });
    expect(g.decide(0, '42')).toMatchObject({ verdict: 'deliver', armed: false });
    expect(g.decide(NaN, '42')).toMatchObject({ verdict: 'deliver', armed: false });
  });

  it('stat-gated: repeated messages under an UNCHANGED registry classify ONCE (≤1 classify call)', () => {
    const classify = vi.fn(() => ({ klass: 'populated' as RegistryClass, detail: 'x', rawUserCount: 1 }));
    const { g } = gate({ statUsers: () => ({ mtimeMs: 5, size: 20 }), classify, resolveUid: () => true });
    g.decide(1, '42'); g.decide(2, '42'); g.decide(3, '42');
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('a changed (mtime,size) re-classifies (a restored registry re-arms within one write)', () => {
    const classify = vi.fn(() => ({ klass: 'populated' as RegistryClass, detail: 'x', rawUserCount: 1 }));
    let stat = { mtimeMs: 5, size: 20 };
    const { g } = gate({ statUsers: () => stat, classify, resolveUid: () => true });
    g.decide(1, '42');
    stat = { mtimeMs: 6, size: 40 }; // the registry changed
    g.decide(2, '42');
    expect(classify).toHaveBeenCalledTimes(2);
  });
});
