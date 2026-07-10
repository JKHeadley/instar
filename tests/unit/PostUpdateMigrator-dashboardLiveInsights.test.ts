/**
 * Migration-parity test for Dashboard Live-LLM-Insights
 * (docs/specs/dashboard-live-insights.md). Verifies existing agents receive the
 * dev-gated dark defaults on UPDATE (not only fresh installs via init), that the
 * migration NEVER writes `enabled` (the #1001 trap), preserves an operator's
 * explicit fleet-flip + sibling dashboard blocks, and is idempotent.
 */
import { describe, it, expect } from 'vitest';
import { migrateConfigDashboardLiveInsightsDevGate } from '../../src/core/PostUpdateMigrator.js';

describe('migrateConfigDashboardLiveInsightsDevGate', () => {
  it('seeds the block on an agent that lacks it (enabled OMITTED so the gate resolves)', () => {
    const cfg: Record<string, unknown> = {};
    expect(migrateConfigDashboardLiveInsightsDevGate(cfg)).toBe(true);
    const li = (cfg.dashboard as any).liveInsights;
    expect(li).toMatchObject({ dryRun: true, ttlSeconds: 300, maxLines: 3 });
    expect('enabled' in li).toBe(false); // never written
  });

  it('preserves a sibling dashboard.fileViewer block when seeding', () => {
    const cfg: Record<string, unknown> = { dashboard: { fileViewer: { enabled: true } } };
    expect(migrateConfigDashboardLiveInsightsDevGate(cfg)).toBe(true);
    expect((cfg.dashboard as any).fileViewer).toEqual({ enabled: true });
    expect((cfg.dashboard as any).liveInsights).toBeTruthy();
  });

  it('strips a default-shaped enabled:false so the dev-agent gate resolves (the #1001 fix)', () => {
    const cfg: Record<string, unknown> = { dashboard: { liveInsights: { enabled: false, dryRun: true } } };
    expect(migrateConfigDashboardLiveInsightsDevGate(cfg)).toBe(true);
    expect('enabled' in (cfg.dashboard as any).liveInsights).toBe(false);
    expect((cfg.dashboard as any).liveInsights.dryRun).toBe(true); // other fields untouched
  });

  it('preserves an operator explicit enabled:true (fleet-flip)', () => {
    const cfg: Record<string, unknown> = { dashboard: { liveInsights: { enabled: true } } };
    expect(migrateConfigDashboardLiveInsightsDevGate(cfg)).toBe(false); // nothing to change
    expect((cfg.dashboard as any).liveInsights.enabled).toBe(true);
  });

  it('is idempotent — a second run finds nothing to do', () => {
    const cfg: Record<string, unknown> = {};
    migrateConfigDashboardLiveInsightsDevGate(cfg);
    expect(migrateConfigDashboardLiveInsightsDevGate(cfg)).toBe(false);
  });
});
