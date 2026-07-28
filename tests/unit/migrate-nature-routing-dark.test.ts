/**
 * Unit (Tier 1) — migrateConfigNatureRoutingDark
 * (docs/specs/nature-axis-routing.md § Migration Parity). Seeds sessions.natureRouting
 * DARK (schemaVersion + dryRun + metered.goLive:false; `enabled` OMITTED for the
 * developmentAgent gate) on existing agents; existence-checked (never clobbers a
 * configured block); idempotent; no-op when there is no sessions block.
 */
import { describe, it, expect } from 'vitest';
import { migrateConfigNatureRoutingDark } from '../../src/core/PostUpdateMigrator.js';

describe('migrateConfigNatureRoutingDark', () => {
  it('seeds the dark block when absent, OMITTING enabled (dev-gate)', () => {
    const cfg: Record<string, unknown> = { sessions: { projectDir: '/x' } };
    expect(migrateConfigNatureRoutingDark(cfg)).toBe(true);
    const nr = (cfg.sessions as any).natureRouting;
    expect(nr).toEqual({ schemaVersion: 3, dryRun: true, metered: { goLive: false } });
    // enable-path integrity — a seeded `enabled:false` would force-dark even a dev agent.
    expect(Object.prototype.hasOwnProperty.call(nr, 'enabled')).toBe(false);
  });

  it('never clobbers an already-present block (existence-checked)', () => {
    const cfg: Record<string, unknown> = {
      sessions: { natureRouting: { enabled: true, dryRun: false } },
    };
    expect(migrateConfigNatureRoutingDark(cfg)).toBe(false);
    expect((cfg.sessions as any).natureRouting).toEqual({ enabled: true, dryRun: false });
  });

  it('no sessions block → safe no-op', () => {
    const cfg: Record<string, unknown> = { monitoring: {} };
    expect(migrateConfigNatureRoutingDark(cfg)).toBe(false);
    expect(cfg.sessions).toBeUndefined();
  });

  it('is idempotent — a second run finds the block present', () => {
    const cfg: Record<string, unknown> = { sessions: { projectDir: '/x' } };
    expect(migrateConfigNatureRoutingDark(cfg)).toBe(true);
    expect(migrateConfigNatureRoutingDark(cfg)).toBe(false);
  });
});
