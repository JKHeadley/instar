/**
 * Unit (Tier 1) — migrateConfigRoutingSpendDark (routing-control-room-spend
 * § Migration parity). Seeds the top-level `routingSpend` block DARK
 * (tokenRollupRetentionDays only; `enabled` OMITTED for the developmentAgent gate) on
 * existing agents; existence-checked (never clobbers a configured block); idempotent.
 * Also asserts the CLAUDE.md awareness section builder is well-formed.
 */
import { describe, it, expect } from 'vitest';
import { migrateConfigRoutingSpendDark, ROUTING_SPEND_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';

describe('migrateConfigRoutingSpendDark', () => {
  it('seeds the dark block when absent, OMITTING enabled (dev-gate)', () => {
    const cfg: Record<string, unknown> = { sessions: {} };
    expect(migrateConfigRoutingSpendDark(cfg)).toBe(true);
    const rs = cfg.routingSpend as Record<string, unknown>;
    expect(rs).toEqual({ tokenRollupRetentionDays: 400 });
    // enable-path integrity — a seeded `enabled:false` would force-dark even a dev agent.
    expect(Object.prototype.hasOwnProperty.call(rs, 'enabled')).toBe(false);
  });

  it('never clobbers an already-present block (existence-checked)', () => {
    const cfg: Record<string, unknown> = { routingSpend: { enabled: true, tokenRollupRetentionDays: 90 } };
    expect(migrateConfigRoutingSpendDark(cfg)).toBe(false);
    expect(cfg.routingSpend).toEqual({ enabled: true, tokenRollupRetentionDays: 90 });
  });

  it('is idempotent — a second run finds the block present', () => {
    const cfg: Record<string, unknown> = {};
    expect(migrateConfigRoutingSpendDark(cfg)).toBe(true);
    expect(migrateConfigRoutingSpendDark(cfg)).toBe(false);
  });
});

describe('ROUTING_SPEND_CLAUDEMD_SECTION', () => {
  it('carries the content-sniff marker and both read routes with the agent port', () => {
    const section = ROUTING_SPEND_CLAUDEMD_SECTION(4042);
    expect(section).toContain('Routing Spend view');
    expect(section).toContain('/routing-spend/summary');
    expect(section).toContain('/routing-spend/caps');
    expect(section).toContain('localhost:4042');
  });
});
