// Unit tests for the pure tier classifier used by /instar-dev's pre-commit
// gate (scripts/lib/classify-tier.mjs). The classifier computes a TIER SIGNAL
// from a staged change — size → base tier, risk floor → may only raise — and
// surfaces a suggestion. It never decides for the agent and never returns 3.
//
// Also tests decideRequirementSet(): the pure helper that factors the gate's
// tier-enforcement DECISION (which requirement set to apply) so it is testable
// without git/fs mocking.

import { describe, it, expect } from 'vitest';
// @ts-expect-error: .mjs script, not typed
import {
  classifyTier,
  decideRequirementSet,
  SIZE_LOC,
  SIZE_FILES,
} from '../../scripts/lib/classify-tier.mjs';

describe('classifyTier — exported constants', () => {
  it('exports SIZE_LOC = 40 and SIZE_FILES = 3', () => {
    expect(SIZE_LOC).toBe(40);
    expect(SIZE_FILES).toBe(3);
  });
});

describe('classifyTier — size tier boundaries', () => {
  it('exactly 40 LOC across exactly 3 files → Tier 1', () => {
    const r = classifyTier({
      inScopeFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      addedLines: 30,
      deletedLines: 10, // 40 total, == SIZE_LOC
    });
    expect(r.sizeTier).toBe(1);
    expect(r.suggestedTier).toBe(1);
    expect(r.riskFloor).toBe(1);
  });

  it('41 LOC → Tier 2 (over SIZE_LOC)', () => {
    const r = classifyTier({
      inScopeFiles: ['src/a.ts'],
      addedLines: 41,
      deletedLines: 0,
    });
    expect(r.sizeTier).toBe(2);
    expect(r.suggestedTier).toBe(2);
  });

  it('40 LOC but 4 files → Tier 2 (over SIZE_FILES)', () => {
    const r = classifyTier({
      inScopeFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      addedLines: 40,
      deletedLines: 0,
    });
    expect(r.sizeTier).toBe(2);
    expect(r.suggestedTier).toBe(2);
  });

  it('counts BOTH added and deleted lines toward the size budget', () => {
    // 21 added + 20 deleted = 41 > 40 → Tier 2
    const r = classifyTier({
      inScopeFiles: ['src/a.ts'],
      addedLines: 21,
      deletedLines: 20,
    });
    expect(r.sizeTier).toBe(2);
  });

  it('zero-LOC, single-file change → Tier 1', () => {
    const r = classifyTier({
      inScopeFiles: ['src/a.ts'],
      addedLines: 0,
      deletedLines: 0,
    });
    expect(r.sizeTier).toBe(1);
    expect(r.suggestedTier).toBe(1);
  });
});

describe('classifyTier — risk floor: safety-invariant proximity', () => {
  it('a 1-line change to a path containing "secret" → suggested Tier 2 with a reason', () => {
    const r = classifyTier({
      inScopeFiles: ['src/messaging/SecretDropManager.ts'],
      addedLines: 1,
      deletedLines: 0,
    });
    expect(r.sizeTier).toBe(1); // size alone would be Tier 1
    expect(r.riskFloor).toBe(2); // risk floor raised it
    expect(r.suggestedTier).toBe(2);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.join(' ')).toMatch(/secret/i);
  });

  it.each([
    ['src/messaging/TelegramAdapter.ts', /telegram adapter/i],
    ['src/monitoring/DeliveryRelay.ts', /relay/i],
    ['src/auth/middleware.ts', /auth/i],
    ['src/core/TokenLedger.ts', /token/i],
    ['src/core/SafeFsExecutor.ts', /SafeFsExecutor/],
    ['src/core/SafeGitExecutor.ts', /SafeGitExecutor/],
    ['src/core/SourceTreeGuard.ts', /SourceTreeGuard/],
    ['src/monitoring/SessionReaper.ts', /reaper/i],
    ['src/core/session-lifecycle.ts', /lifecycle/i],
  ])('path %s raises the risk floor', (file, reasonRe) => {
    const r = classifyTier({ inScopeFiles: [file], addedLines: 1, deletedLines: 0 });
    expect(r.riskFloor).toBe(2);
    expect(r.suggestedTier).toBe(2);
    expect(r.reasons.join(' ')).toMatch(reasonRe);
  });
});

describe('classifyTier — risk floor: irreversibility', () => {
  it.each([
    ['src/core/migrations/0001-init.ts', /migration/i],
    ['src/db/schema.ts', /schema/i],
    ['src/core/PostUpdateMigrator.ts', /PostUpdateMigrator/],
  ])('path %s raises the risk floor for irreversibility', (file, reasonRe) => {
    const r = classifyTier({ inScopeFiles: [file], addedLines: 1, deletedLines: 0 });
    expect(r.riskFloor).toBe(2);
    expect(r.suggestedTier).toBe(2);
    expect(r.reasons.join(' ')).toMatch(reasonRe);
  });
});

describe('classifyTier — risk floor: migration / fleet-rollout surface', () => {
  it.each([
    // A 1-line change to http-hook-templates → suggested Tier 2 with a
    // fleet-rollout reason (the convergence-required fixture).
    ['src/data/http-hook-templates.ts', /fleet-rollout/i],
    // A 1-line change to NEXT.md → suggested Tier 2 with a fleet-rollout reason.
    ['upgrades/NEXT.md', /fleet-rollout/i],
    ['src/core/PostUpdateMigrator.ts', /fleet-rollout/i],
    ['src/core/migrateSettings.ts', /fleet-rollout/i],
    ['scripts/release-publish.mjs', /fleet-rollout/i],
    ['scripts/publish-fleet.js', /fleet-rollout/i],
  ])('path %s raises the risk floor for fleet-rollout', (file, reasonRe) => {
    const r = classifyTier({ inScopeFiles: [file], addedLines: 1, deletedLines: 0 });
    expect(r.sizeTier).toBe(1); // size alone would be Tier 1
    expect(r.riskFloor).toBe(2); // fleet-rollout raised it
    expect(r.suggestedTier).toBe(2);
    expect(r.reasons.join(' ')).toMatch(reasonRe);
  });

  it('a 1-line http-hook-templates change carries the DISTINCT fleet-rollout reason string', () => {
    const r = classifyTier({
      inScopeFiles: ['src/data/http-hook-templates.ts'],
      addedLines: 1,
      deletedLines: 0,
    });
    expect(r.suggestedTier).toBe(2);
    expect(r.reasons.some((reason: string) => /migration \/ fleet-rollout surface/.test(reason))).toBe(true);
  });

  it('a 1-line upgrades/NEXT.md change → suggested Tier 2 (fleet release manifest)', () => {
    const r = classifyTier({
      inScopeFiles: ['upgrades/NEXT.md'],
      addedLines: 1,
      deletedLines: 0,
    });
    expect(r.suggestedTier).toBe(2);
    expect(r.reasons.join(' ')).toMatch(/NEXT\.md/);
  });

  it('a release/publish script NOT under scripts/ does NOT trip the fleet-rollout signal alone', () => {
    // The release/publish heuristic is anchored to scripts/ — a docs file that
    // happens to contain "release" in its path must not raise the floor.
    const r = classifyTier({
      inScopeFiles: ['src/core/util.ts'],
      addedLines: 1,
      deletedLines: 0,
      addedDiffText: '// mentions release and publish in a comment',
    });
    expect(r.riskFloor).toBe(1);
    expect(r.suggestedTier).toBe(1);
  });
});

describe('classifyTier — risk floor: new capability (diff-text based)', () => {
  it('detects a net-new route (router.<verb>()) when addedDiffText is given', () => {
    const r = classifyTier({
      inScopeFiles: ['src/server/routes.ts'],
      addedLines: 3,
      deletedLines: 0,
      addedDiffText: "router.post('/widgets', widgetHandler);",
    });
    expect(r.riskFloor).toBe(2);
    expect(r.suggestedTier).toBe(2);
    expect(r.reasons.join(' ')).toMatch(/route/i);
  });

  it('detects a net-new exported class', () => {
    const r = classifyTier({
      inScopeFiles: ['src/core/Thing.ts'],
      addedLines: 5,
      deletedLines: 0,
      addedDiffText: 'export class WidgetEngine {\n  run() {}\n}',
    });
    expect(r.riskFloor).toBe(2);
    expect(r.reasons.join(' ')).toMatch(/class/i);
  });

  it('detects a new config key when the diff touches a config surface', () => {
    const r = classifyTier({
      inScopeFiles: ['src/config/ConfigDefaults.ts'],
      addedLines: 2,
      deletedLines: 0,
      addedDiffText: 'export const ConfigDefaults = {\n  newWidgetTimeout: 5000,\n};',
    });
    expect(r.riskFloor).toBe(2);
    expect(r.reasons.join(' ')).toMatch(/config key/i);
  });

  it('does NOT fire new-capability on a plain key:value with no config-surface hint', () => {
    const r = classifyTier({
      inScopeFiles: ['src/core/util.ts'],
      addedLines: 2,
      deletedLines: 0,
      addedDiffText: 'const opts = {\n  retries: 3,\n};',
    });
    // No router/class, and key:value gated behind config-surface hint → no raise
    expect(r.riskFloor).toBe(1);
    expect(r.suggestedTier).toBe(1);
  });

  it('SKIPS the new-capability check entirely when addedDiffText is absent', () => {
    // The diff would have contained `export class` but we did not pass it →
    // the classifier must NOT guess. Only size governs.
    const r = classifyTier({
      inScopeFiles: ['src/core/Thing.ts'],
      addedLines: 5,
      deletedLines: 0,
      // addedDiffText omitted
    });
    expect(r.riskFloor).toBe(1);
    expect(r.suggestedTier).toBe(1);
    expect(r.reasons).toEqual([]);
  });
});

describe('classifyTier — max(size, risk) and never-3', () => {
  it('suggestedTier = max(sizeTier, riskFloor): big change on a benign path → Tier 2 from size', () => {
    const r = classifyTier({
      inScopeFiles: ['src/core/util.ts'],
      addedLines: 100,
      deletedLines: 0,
    });
    expect(r.sizeTier).toBe(2);
    expect(r.riskFloor).toBe(1);
    expect(r.suggestedTier).toBe(2);
  });

  it('suggestedTier = max: small change on a risky path → Tier 2 from risk', () => {
    const r = classifyTier({
      inScopeFiles: ['src/messaging/SecretDropManager.ts'],
      addedLines: 2,
      deletedLines: 0,
    });
    expect(r.sizeTier).toBe(1);
    expect(r.riskFloor).toBe(2);
    expect(r.suggestedTier).toBe(2);
  });

  it('NEVER returns 3 even with size + every risk signal stacked', () => {
    const r = classifyTier({
      inScopeFiles: [
        'src/messaging/SecretDropManager.ts',
        'src/core/PostUpdateMigrator.ts',
        'src/db/schema.ts',
        'src/auth/token.ts',
      ],
      addedLines: 500,
      deletedLines: 500,
      addedDiffText: "export class X {}\nrouter.get('/y', h);",
    });
    expect(r.suggestedTier).toBe(2);
    expect(r.suggestedTier).not.toBe(3);
    expect(r.reasons.length).toBeGreaterThan(1);
  });
});

describe('classifyTier — defensive defaults', () => {
  it('tolerates empty / missing input without throwing', () => {
    const r = classifyTier({});
    expect(r.sizeTier).toBe(1); // 0 LOC, 0 files
    expect(r.riskFloor).toBe(1);
    expect(r.suggestedTier).toBe(1);
  });

  it('tolerates no argument at all', () => {
    const r = classifyTier();
    expect(r.suggestedTier).toBe(1);
  });
});

describe('decideRequirementSet — the gate enforcement decision', () => {
  it('tier 1 → tier1-lite requirement set', () => {
    expect(decideRequirementSet(1)).toEqual({ requirementSet: 'tier1-lite', resolvedTier: 1 });
  });

  it('tier 2 → tier2-full requirement set', () => {
    expect(decideRequirementSet(2)).toEqual({ requirementSet: 'tier2-full', resolvedTier: 2 });
  });

  it('tier 3 (project step) → tier2-full (a Tier-3 step is just a Tier-2 spec)', () => {
    expect(decideRequirementSet(3)).toEqual({ requirementSet: 'tier2-full', resolvedTier: 2 });
  });

  it('no tier (null) → tier2-full (back-compat default)', () => {
    expect(decideRequirementSet(null)).toEqual({ requirementSet: 'tier2-full', resolvedTier: 2 });
  });

  it('no tier (undefined) → tier2-full (back-compat default)', () => {
    expect(decideRequirementSet(undefined)).toEqual({ requirementSet: 'tier2-full', resolvedTier: 2 });
  });

  it('any unexpected value → tier2-full (conservative default)', () => {
    expect(decideRequirementSet(99 as unknown as number)).toEqual({
      requirementSet: 'tier2-full',
      resolvedTier: 2,
    });
  });
});

describe('belowFloor detection (the audit decision, computed from classifier output)', () => {
  // belowFloor = declaredTier != null && declaredTier < riskFloor. We test the
  // pure comparison against classifier output so the gate's audit logic is
  // covered without git/fs.
  const belowFloor = (declaredTier: number | null, riskFloor: number) =>
    declaredTier != null && declaredTier < riskFloor;

  it('declared Tier 1 under a risk floor of 2 → belowFloor true', () => {
    const r = classifyTier({
      inScopeFiles: ['src/messaging/SecretDropManager.ts'],
      addedLines: 1,
      deletedLines: 0,
    });
    expect(r.riskFloor).toBe(2);
    expect(belowFloor(1, r.riskFloor)).toBe(true);
  });

  it('declared Tier 2 at a risk floor of 2 → belowFloor false', () => {
    const r = classifyTier({
      inScopeFiles: ['src/messaging/SecretDropManager.ts'],
      addedLines: 1,
      deletedLines: 0,
    });
    expect(belowFloor(2, r.riskFloor)).toBe(false);
  });

  it('no declared tier → belowFloor false (never flagged when undeclared)', () => {
    const r = classifyTier({
      inScopeFiles: ['src/messaging/SecretDropManager.ts'],
      addedLines: 1,
      deletedLines: 0,
    });
    expect(belowFloor(null, r.riskFloor)).toBe(false);
  });
});
