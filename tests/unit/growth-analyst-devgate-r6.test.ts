import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GrowthMilestoneAnalyst,
  resolveGrowthSettings,
  type GrowthAnalystSettings,
} from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const fakeTracker = {
  list: () => [],
  digest: (now: Date) => ({ generatedAt: now.toISOString(), items: [] }),
};

function makeAnalyst(
  stateDir: string,
  liveConfig: { developmentAgent?: boolean } | null | undefined,
  rules?: Partial<GrowthAnalystSettings['rules']>,
) {
  return new GrowthMilestoneAnalyst({
    stateDir,
    settings: resolveGrowthSettings({ enabled: true, ...(rules ? { rules } : {}) } as any),
    tracker: fakeTracker,
    liveConfig,
  });
}

/** Build a dev-agent config with one registered feature hardcoded DARK (the #1001 shape). */
function devConfigWithFeatureDark(configPath: string): Record<string, any> {
  const cfg: Record<string, any> = { developmentAgent: true };
  const keys = configPath.split('.');
  let cur: Record<string, any> = cfg;
  for (const k of keys.slice(0, -1)) {
    cur[k] = cur[k] ?? {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = false;
  return cfg;
}

describe('GrowthMilestoneAnalyst R6 — dev-gate conformance', () => {
  let tmp: string;
  const feature = DEV_GATED_FEATURES[0];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gma-r6-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-devgate-r6.test.ts' });
  });

  it('emits an R6 finding when a registered feature is hardcoded DARK on a dev agent', () => {
    const findings = makeAnalyst(tmp, devConfigWithFeatureDark(feature.configPath)).computeFindings();
    const r6 = findings.filter((f) => f.rule === 'R6');
    expect(r6.length).toBeGreaterThan(0);
    expect(r6.some((f) => f.subjectId === feature.name)).toBe(true);
  });

  it('emits NO R6 finding when every dev-gated feature resolves live on a dev agent (enabled omitted)', () => {
    const findings = makeAnalyst(tmp, { developmentAgent: true }).computeFindings();
    expect(findings.filter((f) => f.rule === 'R6')).toHaveLength(0);
  });

  it('emits NO R6 finding on a fleet agent — darkness is expected off a dev agent', () => {
    // Even with a feature forced dark, a fleet agent should not be flagged.
    const cfg = devConfigWithFeatureDark(feature.configPath);
    cfg.developmentAgent = false;
    expect(makeAnalyst(tmp, cfg).computeFindings().filter((f) => f.rule === 'R6')).toHaveLength(0);
  });

  it('skips R6 when liveConfig is absent (no dev-agent context to check)', () => {
    expect(makeAnalyst(tmp, undefined).computeFindings().filter((f) => f.rule === 'R6')).toHaveLength(0);
  });

  it('skips R6 when the devGateConformance rule is disabled', () => {
    const findings = makeAnalyst(tmp, devConfigWithFeatureDark(feature.configPath), { devGateConformance: false }).computeFindings();
    expect(findings.filter((f) => f.rule === 'R6')).toHaveLength(0);
  });

  it('surfaces dev-gated-dark in the digest counts (and breaks calm)', () => {
    const digest = makeAnalyst(tmp, devConfigWithFeatureDark(feature.configPath)).buildDigest();
    expect(digest.counts.devGateDark).toBeGreaterThan(0);
    expect(digest.calm).toBe(false);
    expect(digest.summary).toContain('dev-gated-dark');
  });
});
