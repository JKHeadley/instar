/**
 * Unit (Tier 1) — migrateConfigActionClaimSlackDevGate
 * (slack-followthrough-generalization §8.5). Strips a default-shaped literal
 * `false` on messaging.actionClaim.slack.enabled (the #1001 guard) so the dev-gate
 * resolves it; array-shaped messaging (real installs) is a safe no-op; explicit
 * `true` is preserved; idempotent.
 */
import { describe, it, expect } from 'vitest';
import { migrateConfigActionClaimSlackDevGate } from '../../src/core/PostUpdateMigrator.js';

describe('migrateConfigActionClaimSlackDevGate', () => {
  it('strips a default-shaped literal false so the dev-gate can resolve it', () => {
    const cfg: Record<string, unknown> = { messaging: { actionClaim: { slack: { enabled: false, dryRun: true } } } };
    expect(migrateConfigActionClaimSlackDevGate(cfg)).toBe(true);
    expect((cfg.messaging as any).actionClaim.slack).toEqual({ dryRun: true }); // enabled removed
  });

  it('preserves an explicit true (operator fleet-flip)', () => {
    const cfg: Record<string, unknown> = { messaging: { actionClaim: { slack: { enabled: true } } } };
    expect(migrateConfigActionClaimSlackDevGate(cfg)).toBe(false);
    expect((cfg.messaging as any).actionClaim.slack.enabled).toBe(true);
  });

  it('ARRAY-shaped messaging (real installs) → safe no-op', () => {
    const cfg: Record<string, unknown> = { messaging: [{ platform: 'telegram' }, { platform: 'slack' }] };
    expect(migrateConfigActionClaimSlackDevGate(cfg)).toBe(false);
    expect(Array.isArray(cfg.messaging)).toBe(true);
  });

  it('no slack block → no-op', () => {
    const cfg: Record<string, unknown> = { messaging: { actionClaim: { enabled: true } } };
    expect(migrateConfigActionClaimSlackDevGate(cfg)).toBe(false);
  });

  it('is idempotent — a second run finds nothing to strip', () => {
    const cfg: Record<string, unknown> = { messaging: { actionClaim: { slack: { enabled: false } } } };
    expect(migrateConfigActionClaimSlackDevGate(cfg)).toBe(true);
    expect(migrateConfigActionClaimSlackDevGate(cfg)).toBe(false);
  });
});
