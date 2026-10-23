/**
 * R7 — dark-flag maturity (Standards A + B of maturation-followthrough-fix).
 *
 * The defect R7 exists to fix: R1/R2 could only see features whose SPEC
 * registered a rollout stage (3 tracks out of 1,201 items), so the real
 * inventory of dark / dry-run switches aged out of sight. R7 keys on the guard
 * key instead, so a staged switch is visible whether or not anyone registered it.
 *
 * Covered on BOTH sides: the rollback flag, the dry-run canary, aggregation
 * (never one finding per flag), the forgotten-backlog headline, the
 * never-promote-on-unknown honesty rule, R3's demotion, and the degrade-to-
 * skipped paths (no reader / no registry / read throws / snapshot unreadable).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GrowthMilestoneAnalyst,
  resolveGrowthSettings,
  riskTierForGuard,
  type GrowthAnalystSettings,
} from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import { DarkFlagMaturationRegistry } from '../../src/monitoring/DarkFlagMaturationRegistry.js';
import { getInitDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import type { GuardEffectiveState, GuardOffClass, GuardRow } from '../../src/monitoring/guardPostureView.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AGENT_SERVER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/server/AgentServer.ts'), 'utf-8');

const fakeTracker = {
  list: () => [],
  digest: (now: Date) => ({ generatedAt: now.toISOString(), items: [] }),
};

function row(
  key: string,
  effective: GuardEffectiveState = 'on-dry-run',
  offClass: GuardOffClass = null,
  extra: Partial<GuardRow> = {},
): GuardRow {
  return {
    key,
    configEnabled: null,
    defaultEnabled: null,
    effective,
    offClass,
    divergence: 'none',
    runtime: null,
    process: 'server',
    ...extra,
  } as GuardRow;
}

describe('R7 wiring and gating', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
  });

  function makeAnalyst(opts: {
    darkFlagInventory?: { enabled?: boolean; dryRun?: boolean };
    rows?: GuardRow[] | null;
    reader?: () => GuardRow[] | null;
    withRegistry?: boolean;
    proof?: (row: GuardRow) => number | undefined;
    owner?: (row: GuardRow) => 'agent' | 'operator' | null;
    rules?: Partial<GrowthAnalystSettings['rules']>;
    stateDir?: string;
  }) {
    const settings = resolveGrowthSettings({
      enabled: true,
      ...(opts.darkFlagInventory ? { darkFlagInventory: opts.darkFlagInventory } : {}),
      ...(opts.rules ? { rules: opts.rules } : {}),
    } as Partial<GrowthAnalystSettings>);
    const stateDir = opts.stateDir ?? dir;
    return new GrowthMilestoneAnalyst({
      stateDir,
      settings,
      tracker: fakeTracker,
      darkFlagInventory: opts.reader ?? (() => (opts.rows === undefined ? [] : opts.rows)),
      darkFlagRegistry:
        opts.withRegistry === false
          ? null
          : new DarkFlagMaturationRegistry({ stateDir, machineId: 'm_test' }),
      ...(opts.proof ? { darkFlagEvidenceCounter: opts.proof } : {}),
      ...(opts.owner ? { darkFlagOwnerFor: opts.owner } : {}),
    });
  }

  it('is OFF by default — the rollback flag reverts to InitiativeTracker-only behavior', () => {
    const a = makeAnalyst({ rows: [row('monitoring.a.enabled')] });
    const out = a.computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z'));
    expect(out.findings).toEqual([]);
    expect(out.entries).toEqual([]);
    // And it writes NO registry at all while off.
    expect(fs.existsSync(path.join(dir, 'state', 'dark-flag-maturation.json'))).toBe(false);
  });

  it('dryRun WRITES the durable registry but emits no findings (the canary ordering)', () => {
    const a = makeAnalyst({
      darkFlagInventory: { enabled: true, dryRun: true },
      rows: [row('monitoring.a.enabled')],
    });
    const out = a.computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z'));
    expect(out.findings).toEqual([]);
    expect(out.entries).toHaveLength(1);
    // The durable evidence accrues from day one — an in-memory counter could
    // never prove a soak across a restart, which is the defect being fixed.
    expect(fs.existsSync(path.join(dir, 'state', 'dark-flag-maturation.json'))).toBe(true);
  });

  it('emits findings once dryRun is cleared', () => {
    const a = makeAnalyst({
      darkFlagInventory: { enabled: true, dryRun: false },
      rows: [row('monitoring.a.enabled')],
    });
    const out = a.computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z'));
    expect(out.entries).toHaveLength(1);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings[0].rule).toBe('R7');
  });

  it('the per-rule flag can disable R7 independently of the inventory flag', () => {
    const a = makeAnalyst({
      darkFlagInventory: { enabled: true, dryRun: false },
      rows: [row('monitoring.a.enabled')],
      rules: { darkFlagMaturity: false },
    });
    expect(a.computeDarkFlagFindings(new Date()).findings).toEqual([]);
  });

  it.each([
    ['no inventory reader', { reader: undefined, withRegistry: true, nullReader: true }],
    ['no registry', { withRegistry: false }],
  ])('degrades to skipped with %s rather than guessing', (_label, cfg: any) => {
    const a = new GrowthMilestoneAnalyst({
      stateDir: dir,
      settings: resolveGrowthSettings({ enabled: true, darkFlagInventory: { enabled: true, dryRun: false } } as any),
      tracker: fakeTracker,
      ...(cfg.nullReader ? {} : { darkFlagInventory: () => [row('x')] }),
      darkFlagRegistry:
        cfg.withRegistry === false ? null : new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' }),
    });
    expect(a.computeDarkFlagFindings(new Date()).findings).toEqual([]);
  });

  it('a reader returning null (unreadable config snapshot) skips R7 — it never reads as "nothing is dark"', () => {
    const a = makeAnalyst({ darkFlagInventory: { enabled: true, dryRun: false }, rows: null });
    const out = a.computeDarkFlagFindings(new Date());
    expect(out.findings).toEqual([]);
    expect(out.entries).toEqual([]);
  });

  it('a throwing reader is reported and skipped, never fatal', () => {
    const errs: string[] = [];
    const a = new GrowthMilestoneAnalyst({
      stateDir: dir,
      settings: resolveGrowthSettings({ enabled: true, darkFlagInventory: { enabled: true, dryRun: false } } as any),
      tracker: fakeTracker,
      darkFlagInventory: () => {
        throw new Error('config read failed');
      },
      darkFlagRegistry: new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' }),
      onError: (where) => errs.push(where),
    });
    expect(a.computeDarkFlagFindings(new Date()).findings).toEqual([]);
    expect(errs).toContain('darkFlagInventory');
  });
});

describe('R7 aggregation — a 100-flag backlog is never 100 notifications', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-agg-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
  });

  function analystWith(rows: GuardRow[], stateDir = dir, proof?: (r: GuardRow) => number | undefined) {
    return new GrowthMilestoneAnalyst({
      stateDir,
      settings: resolveGrowthSettings({
        enabled: true,
        darkFlagInventory: { enabled: true, dryRun: false },
      } as any),
      tracker: fakeTracker,
      darkFlagInventory: () => rows,
      darkFlagRegistry: new DarkFlagMaturationRegistry({ stateDir, machineId: 'm' }),
      ...(proof ? { darkFlagEvidenceCounter: proof } : {}),
    });
  }

  it('collapses 120 legacy dark flags into ONE finding carrying the count and the list', () => {
    const rows = Array.from({ length: 120 }, (_, i) => row(`monitoring.f${i}.enabled`, 'off', 'dark-default'));
    const out = analystWith(rows).computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z'));
    const legacy = out.findings.filter((f) => f.subjectId === 'dark-flags:legacy-unproven');
    expect(legacy).toHaveLength(1);
    expect(legacy[0].affected).toHaveLength(120);
    expect(legacy[0].title).toMatch(/120 staged switches/);
    // Every one of them is un-owned, and the finding says so.
    expect(legacy[0].unowned).toBe(120);
  });

  it('emits at most one finding per class, never per flag', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(`monitoring.a${i}.enabled`)),
      ...Array.from({ length: 7 }, (_, i) => row(`monitoring.b${i}.enabled`, 'off', 'dark-default')),
    ];
    const out = analystWith(rows).computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z'));
    expect(out.findings.length).toBeLessThanOrEqual(3);
    for (const f of out.findings) expect(f.subjectId).toMatch(/^dark-flags:/);
  });

  it('separates proved from unproved into their own aggregate rows', () => {
    const rows = [row('monitoring.proved.enabled'), row('monitoring.unproved.enabled')];
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-two-'));
    try {
      const reg = new DarkFlagMaturationRegistry({ stateDir: dir2, machineId: 'm' });
      const seedWindow = { windowFor: () => ({ tier: 'standard' as const, windowDays: 7 }), proofCountFor: () => undefined, minProof: 1, ownerFor: () => null };
      // Establish the record FIRST with nothing dark — i.e. we were already
      // watching. Only then do the flags appear, so they are genuinely new and
      // get a real window instead of being stamped as pre-existing backlog.
      reg.reconcile({ rows: [], now: new Date('2026-01-01T00:00:00.000Z'), ...seedWindow });
      reg.reconcile({ rows, now: new Date('2026-01-02T00:00:00.000Z'), ...seedWindow });
      const b = new GrowthMilestoneAnalyst({
        stateDir: dir2,
        settings: resolveGrowthSettings({ enabled: true, darkFlagInventory: { enabled: true, dryRun: false } } as any),
        tracker: fakeTracker,
        darkFlagInventory: () => rows,
        darkFlagRegistry: reg,
        darkFlagEvidenceCounter: (r) => (r.key === 'monitoring.proved.enabled' ? 9 : undefined),
      });
      const out = b.computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z'));
      const ready = out.findings.find((f) => f.subjectId === 'dark-flags:window-elapsed');
      const expired = out.findings.find((f) => f.subjectId === 'dark-flags:expired-unproven');
      expect(ready?.affected).toEqual(['monitoring.proved.enabled']);
      expect(ready?.suggestedAction).toBe('promote');
      expect(expired?.affected).toEqual(['monitoring.unproved.enabled']);
      expect(expired?.suggestedAction).toBe('extend-fix-kill');
      // Neither is legacy — they were anchored while we were watching.
      expect(out.findings.some((f) => f.subjectId === 'dark-flags:legacy-unproven')).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
    }
  });

  it('the forgotten backlog is HIGH priority — it is the headline by construction', () => {
    const out = analystWith([row('monitoring.old.enabled', 'off', 'dark-default')]).computeDarkFlagFindings(
      new Date('2026-06-01T00:00:00.000Z'),
    );
    const legacy = out.findings.find((f) => f.subjectId === 'dark-flags:legacy-unproven');
    expect(legacy?.priority).toBe('high');
  });

  it('names load-bearing keys so they route to the EXISTING guard-gap surface, not a second row', () => {
    const rows = [
      row('monitoring.lb.enabled', 'on-dry-run', null, { loadBearing: true, criticalPath: 'inbound delivery' }),
      row('monitoring.plain.enabled'),
    ];
    const out = analystWith(rows).computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z'));
    const f = out.findings.find((x) => x.loadBearingKeys);
    expect(f?.loadBearingKeys).toEqual(['monitoring.lb.enabled']);
    expect(f?.detail).toMatch(/already tracked as a guard gap/);
  });

  it("never marks a flag window-elapsed on 'unknown' proof, however long it has been dark", () => {
    const out = analystWith([row('monitoring.x.enabled')]).computeDarkFlagFindings(
      new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(out.findings.some((f) => f.subjectId === 'dark-flags:window-elapsed')).toBe(false);
  });
});

describe('R7 text is safe to put in a message — no raw config keys', () => {
  // `detail` is rendered VERBATIM into the weekly Telegram digest
  // (GrowthDigestPublisher.renderFinding). A dotted config path is exactly the
  // literal the always-on tone gate blocks, and a blocked digest is the
  // 2026-06-29 failure that Standard C of this same spec exists to prevent. So
  // the keys must travel in the structured `affected` field, never in the prose.
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-safe-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
  });

  function findingsFor(rows: GuardRow[]) {
    const a = new GrowthMilestoneAnalyst({
      stateDir: dir,
      settings: resolveGrowthSettings({
        enabled: true,
        darkFlagInventory: { enabled: true, dryRun: false },
      } as any),
      tracker: fakeTracker,
      darkFlagInventory: () => rows,
      darkFlagRegistry: new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' }),
    });
    return a.computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z')).findings;
  }

  const DOTTED_KEY = /\b[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){2,}\b/;

  it('no R7 title or detail contains a dotted config path', () => {
    const rows = [
      row('monitoring.growthAnalyst.darkFlagInventory.enabled'),
      row('multiMachine.sessionPool.inboundQueue.enabled', 'off', 'dark-default'),
      row('subscriptionPool.swapContinuity.enabled', 'on-dry-run', null, { loadBearing: true, criticalPath: 'x' }),
    ];
    const findings = findingsFor(rows);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.title).not.toMatch(DOTTED_KEY);
      expect(f.detail).not.toMatch(DOTTED_KEY);
    }
  });

  it('the keys are still available to the dashboard via the structured field', () => {
    const findings = findingsFor([row('monitoring.alpha.beta.enabled')]);
    expect(findings[0].affected).toEqual(['monitoring.alpha.beta.enabled']);
  });

  it('the detail still tells the operator the count, the ownership gap, and where the list is', () => {
    const rows = [row('monitoring.a.enabled'), row('monitoring.b.enabled')];
    const f = findingsFor(rows)[0];
    expect(f.title).toMatch(/2 staged switches/);
    expect(f.detail).toMatch(/None of them has an owner/);
    expect(f.detail).toMatch(/dashboard/);
  });

  it('reports a partial ownership gap in plain words', () => {
    const a = new GrowthMilestoneAnalyst({
      stateDir: dir,
      settings: resolveGrowthSettings({
        enabled: true,
        darkFlagInventory: { enabled: true, dryRun: false },
      } as any),
      tracker: fakeTracker,
      darkFlagInventory: () => [row('monitoring.owned.enabled'), row('monitoring.nobody.enabled')],
      darkFlagRegistry: new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' }),
      darkFlagOwnerFor: (r) => (r.key === 'monitoring.owned.enabled' ? 'agent' : null),
    });
    // Seed a non-legacy anchor first so ownership is actually derived.
    const reg = new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' });
    reg.save({});
    const f2 = a.computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z')).findings;
    for (const f of f2) expect(f.detail).not.toMatch(DOTTED_KEY);
  });
});

describe('riskTierForGuard — conservative, never shortens a window on a guess', () => {
  it('gives a load-bearing guard the highRisk window', () => {
    expect(riskTierForGuard(row('a', 'on-dry-run', null, { loadBearing: true }))).toBe('highRisk');
  });
  it('gives everything else the standard window', () => {
    expect(riskTierForGuard(row('a'))).toBe('standard');
  });
});

describe('the digest reports R7 and DEMOTES R3', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-digest-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
  });

  function analyst(rows: GuardRow[], stalling: boolean) {
    return new GrowthMilestoneAnalyst({
      stateDir: dir,
      settings: resolveGrowthSettings({
        enabled: true,
        darkFlagInventory: { enabled: true, dryRun: false },
      } as any),
      tracker: {
        list: () => [],
        digest: (now: Date) => ({
          generatedAt: now.toISOString(),
          items: stalling
            ? [{ initiativeId: 'INIT-1', title: 'Something', reason: 'stale', detail: 'No update in a while.' }]
            : [],
        }),
      },
      darkFlagInventory: () => rows,
      darkFlagRegistry: new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' }),
    });
  }

  it('counts dark flags by state in the digest counts', () => {
    const d = analyst([row('monitoring.a.enabled'), row('monitoring.b.enabled', 'off', 'dark-default')], false)
      .buildDigest(new Date('2026-06-01T00:00:00.000Z'));
    expect(d.counts.darkLegacyUnproven).toBe(2);
    expect(d.counts.darkUnowned).toBe(2);
    expect(d.findings.some((f) => f.rule === 'R7')).toBe(true);
  });

  it('puts the maturity signal FIRST and the stalling noise LAST in the summary', () => {
    const d = analyst([row('monitoring.a.enabled', 'off', 'dark-default')], true).buildDigest(
      new Date('2026-06-01T00:00:00.000Z'),
    );
    const darkIdx = d.summary.indexOf('dark before anyone was watching');
    const stallIdx = d.summary.indexOf('stalling');
    expect(darkIdx).toBeGreaterThan(-1);
    expect(stallIdx).toBeGreaterThan(-1);
    expect(darkIdx).toBeLessThan(stallIdx);
  });

  it('a tombstoned flag stops counting as un-owned — the finding must be closable', () => {
    const a = analyst([row('monitoring.gone.enabled')], false);
    a.buildDigest(new Date('2026-06-01T00:00:00.000Z'));
    const b = analyst([], false); // the guard disappeared
    const d = b.buildDigest(new Date('2026-06-10T00:00:00.000Z'));
    expect(d.counts.darkUnowned).toBe(0);
    expect(d.counts.darkLegacyUnproven).toBe(0);
  });

  it('still counts incubating dark flags in the calm summary so the operator knows it watched', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-calm-'));
    try {
      const reg = new DarkFlagMaturationRegistry({ stateDir: dir2, machineId: 'm' });
      // Pre-seed so the next pass is NOT first-registration ⇒ real incubation.
      reg.reconcile({
        rows: [row('monitoring.fresh.enabled')],
        now: new Date('2026-06-01T00:00:00.000Z'),
        windowFor: () => ({ tier: 'standard', windowDays: 7 }),
        proofCountFor: () => undefined,
        minProof: 1,
        ownerFor: () => 'agent',
      });
      // Wipe the legacy marks by re-anchoring a second, non-legacy flag.
      const a = new GrowthMilestoneAnalyst({
        stateDir: dir2,
        settings: resolveGrowthSettings({
          enabled: true,
          darkFlagInventory: { enabled: true, dryRun: false },
        } as any),
        tracker: fakeTracker,
        darkFlagInventory: () => [row('monitoring.fresh.enabled'), row('monitoring.second.enabled')],
        darkFlagRegistry: reg,
      });
      const d = a.buildDigest(new Date('2026-06-02T00:00:00.000Z'));
      expect(d.counts.darkIncubating).toBe(1); // the newly-anchored, non-legacy one
      expect(d.summary).toBeTruthy();
    } finally {
      SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
    }
  });
});

describe('wiring integrity — the deps are real, not placeholders', () => {
  it('AgentServer builds the inventory through the SAME pure funnel /guards uses', () => {
    expect(AGENT_SERVER_SRC).toMatch(/darkFlagInventory:\s*\(\)\s*=>/);
    expect(AGENT_SERVER_SRC).toContain('buildGuardInventory({');
    // It must NOT hand back an empty list on a config read failure — that would
    // read as "nothing is dark" and could tombstone the whole registry.
    expect(AGENT_SERVER_SRC).toMatch(/snapshot\.readError[\s\S]{0,400}return null/);
  });

  it('AgentServer injects a real durable registry, machine-scoped', () => {
    expect(AGENT_SERVER_SRC).toContain('darkFlagRegistry: new DarkFlagMaturationRegistry({');
    expect(AGENT_SERVER_SRC).toMatch(/machineId:\s*options\.meshSelfId/);
  });

  it('owner derivation comes from the dev-gate registry, never invented', () => {
    expect(AGENT_SERVER_SRC).toMatch(/DEV_GATED_FEATURES\.some\(\(f\) => f\.configPath === row\.key\)/);
    expect(AGENT_SERVER_SRC).toMatch(/\?\s*'agent'\s*:\s*null/);
  });

  it('the feature registers itself in the guard manifest — it dogfoods its own guarantee', () => {
    const manifest = fs.readFileSync(path.join(process.cwd(), 'src/monitoring/guardManifest.ts'), 'utf-8');
    expect(manifest).toContain("key: 'monitoring.growthAnalyst.darkFlagInventory.enabled'");
    expect(manifest).toContain("dryRunConfigPath: 'monitoring.growthAnalyst.darkFlagInventory.dryRun'");
  });

  it('OMITS `enabled` from the shipped defaults so the dev-agent gate governs it', () => {
    // The dev-agent dark-gate standard (DEV-AGENT-DARK-GATE-ENFORCEMENT): a
    // hardcoded `enabled: false` would ship dark even on the dogfooding agent,
    // and its lint rejects any unclassified one. The driving spec says this
    // flag "rides the dev-agent gate, dry-run first" — so `enabled` is omitted
    // and `dryRun` ships true.
    for (const t of ['managed-project', 'standalone'] as const) {
      const dfi = (getInitDefaults(t).monitoring as any).growthAnalyst.darkFlagInventory;
      expect(dfi).toBeDefined();
      expect('enabled' in dfi).toBe(false);
      expect(dfi.dryRun).toBe(true);
    }
    const mig = (getMigrationDefaults('managed-project').monitoring as any).growthAnalyst.darkFlagInventory;
    expect('enabled' in mig).toBe(false);
    expect(mig.dryRun).toBe(true);
  });

  it('AgentServer resolves the flag through resolveDevAgentGate and feeds the result into settings', () => {
    // Without this the routes would report `enabled: false` on a dev agent
    // where the gate actually resolved it live — the dishonest-status bug the
    // analyst's own top-level `enabled` already had to fix once.
    expect(AGENT_SERVER_SRC).toMatch(
      /darkFlagInventory:\s*\{[\s\S]{0,400}enabled:\s*resolveDevAgentGate\(/,
    );
    expect(AGENT_SERVER_SRC).toMatch(
      /resolveDevAgentGate\(\s*options\.config\.monitoring\?\.growthAnalyst\?\.darkFlagInventory\?\.enabled/,
    );
  });

  it('resolveGrowthSettings still defaults the flag OFF when nothing is supplied (fleet posture)', () => {
    const s = resolveGrowthSettings({ enabled: true } as any);
    expect(s.darkFlagInventory).toEqual({ enabled: false, dryRun: true });
  });

  it('honors an explicitly-resolved true (what the dev gate passes in)', () => {
    const s = resolveGrowthSettings({ enabled: true, darkFlagInventory: { enabled: true } } as any);
    expect(s.darkFlagInventory).toEqual({ enabled: true, dryRun: true });
  });

  it('R3 is demoted to the tail of the publisher rule order', () => {
    const pub = fs.readFileSync(path.join(process.cwd(), 'src/monitoring/GrowthDigestPublisher.ts'), 'utf-8');
    const m = pub.match(/const RULE_ORDER: GrowthRuleId\[\] = \[([^\]]+)\]/);
    expect(m).toBeTruthy();
    const order = m![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(order[order.length - 1]).toBe('R3');
    expect(order.indexOf('R7')).toBeLessThan(order.indexOf('R3'));
  });
});

describe('the two aggregation points can never diverge again', () => {
  // The spec names "the criterion lives in two places that disagree" as one of
  // the four reasons the engine stalled, and this build hit exactly that bug:
  // buildDigest() carried R7 while computeFindings() (behind /growth/findings)
  // silently omitted it. This test is the structural guard on that class.
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-parity-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
  });

  function parityAnalyst(rows: GuardRow[], stalling: boolean) {
    return new GrowthMilestoneAnalyst({
      stateDir: dir,
      settings: resolveGrowthSettings({
        enabled: true,
        darkFlagInventory: { enabled: true, dryRun: false },
      } as any),
      tracker: {
        list: () => [],
        digest: (now: Date) => ({
          generatedAt: now.toISOString(),
          items: stalling
            ? [{ initiativeId: 'INIT-1', title: 'Drifty', reason: 'stale', detail: 'No update.' }]
            : [],
        }),
      },
      darkFlagInventory: () => rows,
      darkFlagRegistry: new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' }),
    });
  }

  it('computeFindings() and buildDigest().findings agree on rules AND order', () => {
    const rows = [row('monitoring.a.enabled'), row('monitoring.b.enabled', 'off', 'dark-default')];
    const now = new Date('2026-06-01T00:00:00.000Z');
    // Two separate instances over two state dirs so neither pass mutates the
    // other's registry mid-comparison (the registry is deliberately durable).
    const viaFindings = parityAnalyst(rows, true).computeFindings(now);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-parity-b-'));
    const viaDigest = parityAnalyst(rows, true).buildDigest(now).findings;

    expect(viaFindings.map((f) => f.rule)).toEqual(viaDigest.map((f) => f.rule));
    expect(viaFindings.map((f) => f.subjectId)).toEqual(viaDigest.map((f) => f.subjectId));
  });

  it('both surfaces demote R3 to last', () => {
    const rows = [row('monitoring.a.enabled', 'off', 'dark-default')];
    const now = new Date('2026-06-01T00:00:00.000Z');
    const findings = parityAnalyst(rows, true).computeFindings(now);
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain('R3');
    expect(rules).toContain('R7');
    expect(rules[rules.length - 1]).toBe('R3');
    expect(rules.indexOf('R7')).toBeLessThan(rules.indexOf('R3'));
  });

  it('both surfaces omit R7 identically while the feature is dark', () => {
    const rows = [row('monitoring.a.enabled')];
    const now = new Date('2026-06-01T00:00:00.000Z');
    const a = new GrowthMilestoneAnalyst({
      stateDir: dir,
      settings: resolveGrowthSettings({ enabled: true } as any),
      tracker: fakeTracker,
      darkFlagInventory: () => rows,
      darkFlagRegistry: new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' }),
    });
    expect(a.computeFindings(now).some((f) => f.rule === 'R7')).toBe(false);
    expect(a.buildDigest(now).findings.some((f) => f.rule === 'R7')).toBe(false);
  });
});

describe('readiness stays D7\'s — this registry never claims it', () => {
  // feature-maturation-recurring-evaluation.md (D7) is operator-approved under
  // the directive "extend, never duplicate" and owns the `ready` verdict: it
  // scores a feature's DECLARED measurement contract against fresh
  // observations. This inventory knows only that a window closed and a flag
  // fired. Two components answering "is this ready?" by different rules is the
  // defect this spec names as a reason the engine stalled, so the boundary is
  // asserted structurally rather than left to a comment.
  it('the state vocabulary contains no readiness verdict', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/monitoring/DarkFlagMaturationRegistry.ts'),
      'utf-8',
    );
    const union = src.slice(src.indexOf('export type DarkFlagState'), src.indexOf('export interface DarkFlagHistoryEntry'));
    const states = [...union.matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1]);
    expect(states).toContain('window-elapsed');
    // The collision that was removed, and D7's own term.
    expect(states).not.toContain('promotion-ready');
    expect(states).not.toContain('ready');
  });

  it('names D7 as the readiness owner so the next reader does not re-litigate it', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/monitoring/DarkFlagMaturationRegistry.ts'),
      'utf-8',
    );
    expect(src).toMatch(/evaluateMaturation/);
    expect(src).toMatch(/extend, never duplicate/);
  });

  it('the R7 finding for an elapsed window asks for a decision without asserting readiness', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-bound-'));
    try {
      const reg = new DarkFlagMaturationRegistry({ stateDir: dir, machineId: 'm' });
      const seed = { windowFor: () => ({ tier: 'standard' as const, windowDays: 7 }), proofCountFor: () => 9, minProof: 1, ownerFor: () => null };
      // Establish the record first (nothing dark), then let the flag appear, so
      // it is anchored in the PAST and non-legacy — the window can then elapse.
      reg.reconcile({ rows: [], now: new Date('2026-01-01T00:00:00.000Z'), ...seed });
      reg.reconcile({ rows: [row('monitoring.x.enabled')], now: new Date('2026-01-02T00:00:00.000Z'), ...seed });
      const a = new GrowthMilestoneAnalyst({
        stateDir: dir,
        settings: resolveGrowthSettings({ enabled: true, darkFlagInventory: { enabled: true, dryRun: false } } as any),
        tracker: fakeTracker,
        darkFlagInventory: () => [row('monitoring.x.enabled')],
        darkFlagRegistry: reg,
        darkFlagEvidenceCounter: () => 9,
      });
      const f = a.computeDarkFlagFindings(new Date('2026-06-01T00:00:00.000Z')).findings
        .find((x) => x.subjectId === 'dark-flags:window-elapsed');
      expect(f).toBeDefined();
      // It may still SUGGEST promote (that is the operator's prompt), but the
      // prose must not assert the feature has met its bar.
      expect(f!.detail).toMatch(/scored separately/);
      expect(f!.detail).not.toMatch(/ready to turn on/);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/growth-analyst-darkflag-r7.test.ts' });
    }
  });
});
