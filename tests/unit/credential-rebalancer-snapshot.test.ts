/**
 * Increment B, step B3b helper — the pure snapshot mappers (CredentialRebalancerSnapshot).
 *
 * Covers the units/sign translation from live state into the policy's snapshot: status
 * eligibility mapping (rate-limited stays eligible; needs-reauth/disabled don't), quota
 * mapping incl. missing-reading → stale, slot mapping (default flag, quarantined-empty →
 * null tenant), and config clamping + cooldown derivation.
 */

import { describe, it, expect } from 'vitest';
import {
  mapAccountStatus, mapAccount, mapSlot, resolveRebalancerConfig,
} from '../../src/core/CredentialRebalancerSnapshot.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';
import type { CredentialAssignment } from '../../src/core/CredentialLocationLedger.js';

const NOW = Date.parse('2026-06-13T12:00:00Z');

function poolAccount(p: Partial<SubscriptionAccount> & { id: string }): SubscriptionAccount {
  return {
    id: p.id, nickname: p.id, provider: 'anthropic' as SubscriptionAccount['provider'],
    framework: 'claude-code' as SubscriptionAccount['framework'], configHome: `~/.cfg/${p.id}`,
    status: 'active', enrolledAt: '2026-01-01T00:00:00Z', version: 1, ...p,
  };
}

describe('mapAccountStatus', () => {
  it('keeps rate-limited eligible (ok) so its walling slot can be rescued', () => {
    expect(mapAccountStatus('rate-limited')).toBe('ok');
    expect(mapAccountStatus('active')).toBe('ok');
    expect(mapAccountStatus('warming')).toBe('ok');
  });
  it('marks needs-reauth and disabled ineligible', () => {
    expect(mapAccountStatus('needs-reauth')).toBe('needs-reauth');
    expect(mapAccountStatus('disabled')).toBe('disabled');
  });
});

describe('mapAccount', () => {
  it('maps quota percentages + weekly reset hours from the snapshot', () => {
    const a = mapAccount(poolAccount({
      id: 'A',
      lastQuota: {
        fiveHour: { utilizationPct: 40, resetsAt: '2026-06-13T15:00:00Z' },
        sevenDay: { utilizationPct: 70, resetsAt: '2026-06-14T12:00:00Z' }, // 24h out
        measuredAt: '2026-06-13T11:59:00Z',
      },
    }), NOW);
    expect(a.fiveHrPct).toBe(40);
    expect(a.weeklyPct).toBe(70);
    expect(a.weeklyResetsInHours).toBeCloseTo(24, 1);
    expect(a.measuredAt).toBe(Date.parse('2026-06-13T11:59:00Z'));
    expect(a.status).toBe('ok');
  });

  it('treats a missing quota reading as stale (measuredAt 0) + null percentages', () => {
    const a = mapAccount(poolAccount({ id: 'B', lastQuota: null }), NOW);
    expect(a.fiveHrPct).toBeNull();
    expect(a.weeklyPct).toBeNull();
    expect(a.weeklyResetsInHours).toBeNull();
    expect(a.measuredAt).toBe(0); // epoch → always stale → source-only
  });
});

describe('mapSlot', () => {
  function assignment(p: Partial<CredentialAssignment> & { slot: string }): CredentialAssignment {
    return { slot: p.slot, accountId: 'A', since: '2026-06-13T10:00:00Z', lastVerifiedAt: '2026-06-13T11:00:00Z', quarantined: false, ...p };
  }

  it('flags the default slot and parses lastVerifiedAt', () => {
    const s = mapSlot(assignment({ slot: '~/.claude' }), { defaultSlot: '~/.claude' });
    expect(s.isDefault).toBe(true);
    expect(s.tenantAccountId).toBe('A');
    expect(s.lastVerifiedAt).toBe(Date.parse('2026-06-13T11:00:00Z'));
  });

  it('normalizes a quarantined-empty slot (accountId "") to a null tenant', () => {
    const s = mapSlot(assignment({ slot: 's2', accountId: '', quarantined: true, lastVerifiedAt: null }), {});
    expect(s.tenantAccountId).toBeNull();
    expect(s.quarantined).toBe(true);
    expect(s.lastVerifiedAt).toBeNull();
    expect(s.isDefault).toBe(false);
  });

  it('reads busyness / drain-hold / audit-divergent overrides when supplied', () => {
    const s = mapSlot(assignment({ slot: 's3' }), {
      busynessBySlot: { s3: 9 }, drainInProgressBySlot: { s3: true }, auditDivergentBySlot: { s3: true },
    });
    expect(s.busyness).toBe(9);
    expect(s.drainInProgress).toBe(true);
    expect(s.lastAuditDivergent).toBe(true);
  });
});

describe('resolveRebalancerConfig', () => {
  it('applies defaults and derives cooldowns from the poll interval', () => {
    const c = resolveRebalancerConfig({});
    expect(c.policy.highWaterPct).toBe(85);
    expect(c.policy.criticalPct).toBe(95);
    expect(c.policy.perPairCooldownMs).toBe(300_000);       // 1× default poll interval (5m)
    expect(c.policy.perTenantCooldownMs).toBe(600_000);     // 2× poll interval
    expect(c.policy.staleQuotaMs).toBe(600_000);            // 2 poll periods
    expect(c.breakerThreshold).toBe(3);
    expect(c.maxForcedOverridesPerWindow).toBe(5);
    expect(c.desiredDefaultAccountId).toBeNull();
  });

  it('clamps out-of-range knobs', () => {
    const c = resolveRebalancerConfig({ highWaterPct: 5, criticalPct: 200, passIntervalMs: 1, maxForcedSwapsPerPass: 99, slotCount: 3 });
    expect(c.policy.highWaterPct).toBe(50);           // clamped up to floor
    expect(c.policy.criticalPct).toBe(99);            // clamped to ceiling
    expect(c.policy.perPairCooldownMs).toBe(60_000);  // passInterval clamped to 60s floor
    expect(c.policy.maxForcedSwapsPerPass).toBe(3);   // clamped to slotCount
  });

  it('passes through the desired default account id', () => {
    const c = resolveRebalancerConfig({ desiredDefaultAccountId: 'acct-D' });
    expect(c.desiredDefaultAccountId).toBe('acct-D');
  });
});
