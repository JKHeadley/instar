import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// The SAME attributor the lint's assertion C uses — the golden-path test asserts
// THIS resolver reproduces a hand-authored map (never the resolver's own output).
import { attributeEnabledFalsePaths, VALID_CATEGORIES } from '../../scripts/lib/dark-gate-attribution.js';
import { DEV_GATED_FEATURES, DARK_GATE_EXCLUSIONS } from '../../src/core/devGatedFeatures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const LINT = path.join(ROOT, 'scripts', 'lint-dev-agent-dark-gate.js');

/** Run the lint's real attributor over the REAL ConfigDefaults.ts → { line→path }. */
function attributeRealConfigDefaults(): Record<string, string> {
  const { paths, error } = attributeEnabledFalsePaths(
    path.join(ROOT, 'src', 'config', 'ConfigDefaults.ts'),
  );
  if (error) throw new Error(`attribution error: ${error}`);
  const out: Record<string, string> = {};
  for (const { line, dottedPath } of paths) out[String(line)] = dottedPath;
  return out;
}

/** Run the lint; return { code, out }. Never throws on non-zero exit. */
function runLint(args: string[], env?: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync('node', [LINT, ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: { ...process.env, ...(env ?? {}) },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * Build a minimal-but-valid fixture pair (a ConfigDefaults.ts with a
 * SHARED_DEFAULTS literal + a devGatedFeatures.ts registry) in a tmpdir, and
 * return the env overrides that point the lint's assertion-C at them. The lint's
 * C-assertion reads these two files directly (independent of the file args), so
 * the overrides are the only way to exercise C's failure modes.
 */
function writeCFixture(opts: {
  defaultsBody: string;       // contents INSIDE the SHARED_DEFAULTS `{ ... }`
  gatedEntries?: string;      // contents INSIDE DEV_GATED_FEATURES `[ ... ]`
  exclusionEntries?: string;  // contents INSIDE DARK_GATE_EXCLUSIONS `[ ... ]`
}): { dir: string; env: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-C-'));
  const configDefaults = `const SHARED_DEFAULTS = {\n${opts.defaultsBody}\n};\nexport { SHARED_DEFAULTS };\n`;
  const registry = [
    'export const DEV_GATED_FEATURES = [',
    opts.gatedEntries ?? '',
    '];',
    'export const DARK_GATE_EXCLUSIONS = [',
    opts.exclusionEntries ?? '',
    '];',
    '',
  ].join('\n');
  const cdPath = path.join(dir, 'ConfigDefaults.ts');
  const regPath = path.join(dir, 'devGatedFeatures.ts');
  fs.writeFileSync(cdPath, configDefaults);
  fs.writeFileSync(regPath, registry);
  return {
    dir,
    env: {
      INSTAR_DARKGATE_CONFIG_DEFAULTS: cdPath,
      INSTAR_DARKGATE_REGISTRY: regPath,
    },
  };
}

function cleanup(dir: string) {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
}

describe('lint-dev-agent-dark-gate', () => {
  it('passes clean on the real src/ tree (migration complete, no hardcoded dark-gate defaults)', () => {
    const { code, out } = runLint([]);
    expect(out).toContain('clean');
    expect(code).toBe(0);
  });

  it('Assertion A: flags a hand-rolled `?? !!config.developmentAgent` outside the helper', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-A-'));
    const f = path.join(dir, 'someFeature.ts');
    fs.writeFileSync(f, 'export function f(cfg, config) {\n  const enabled = cfg?.enabled ?? !!config.developmentAgent;\n  return enabled;\n}\n');
    try {
      const { code, out } = runLint([f]);
      expect(code).toBe(1);
      expect(out).toContain('A: hand-rolled gate');
      expect(out).toContain('resolveDevAgentGate');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion A: does NOT flag a comment that merely describes the pattern', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-Aok-'));
    const f = path.join(dir, 'documented.ts');
    fs.writeFileSync(f, '// resolves enabled ?? !!config.developmentAgent at runtime (dev-gate)\nexport const x = 1;\n');
    try {
      const { code } = runLint([f]);
      expect(code).toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion B: flags a hardcoded `enabled: false` under a dev-gate marker comment in ConfigDefaults.ts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-B-'));
    const f = path.join(dir, 'ConfigDefaults.ts');
    fs.writeFileSync(
      f,
      [
        'export const defaults = {',
        '  // MyFeature — dark-feature gate (developmentAgent): dark fleet, live dev.',
        '  myFeature: {',
        '    enabled: false,',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    try {
      const { code, out } = runLint([f]);
      expect(code).toBe(1);
      expect(out).toContain('B: hardcoded enabled under gate marker');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion B: does NOT flag `enabled: true` (allowed fleet-flip) or comment prose under a marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-Bok-'));
    const f = path.join(dir, 'ConfigDefaults.ts');
    fs.writeFileSync(
      f,
      [
        'export const defaults = {',
        '  // MyFeature — dark-feature gate (developmentAgent): the fleet-flip',
        '  // registers `enabled: true` here. Default OMITS enabled.',
        '  myFeature: {',
        '    sampleIntervalMs: 1000,',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    try {
      const { code } = runLint([f]);
      expect(code).toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion A: flags the `?? Boolean(config.developmentAgent)` form (not just `!!`)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-Abool-'));
    const f = path.join(dir, 'someFeature.ts');
    fs.writeFileSync(f, 'export function f(cfg, config) {\n  const enabled = cfg?.enabled ?? Boolean(config.developmentAgent);\n  return enabled;\n}\n');
    try {
      const { code, out } = runLint([f]);
      expect(code).toBe(1);
      expect(out).toContain('A: hand-rolled gate');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion B: catches `enabled: false` even when a LONG marker comment precedes the block (the growthAnalyst window regression)', () => {
    // Regression for the fixed-window bug: growthAnalyst ships a ~10-line marker
    // comment, which pushed its config fields past the old 8-line window so a
    // regressed `enabled: false` slipped through. Block-matching must catch it
    // regardless of comment length.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-Blong-'));
    const f = path.join(dir, 'ConfigDefaults.ts');
    const longComment = Array.from({ length: 11 }, (_, k) =>
      k === 0
        ? '  // MyFeature — dark-feature gate (developmentAgent): dark fleet, live dev.'
        : `  // continuation line ${k} of a deliberately long explanatory comment.`,
    ).join('\n');
    fs.writeFileSync(
      f,
      ['export const defaults = {', longComment, '  myFeature: {', '    enabled: false,', '  },', '};', ''].join('\n'),
    );
    try {
      const { code, out } = runLint([f]);
      expect(code).toBe(1);
      expect(out).toContain('B: hardcoded enabled under gate marker');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  // ── Assertion C — no unclassified dark default (DEV-AGENT-DARK-GATE-ENFORCEMENT) ──

  it('Assertion C (a): an unclassified `enabled: false` FAILS', () => {
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      // registries empty — myFeature is in NEITHER → violation
    });
    try {
      const { code, out } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(1);
      expect(out).toContain('C: unclassified dark default');
      expect(out).toContain('myFeature.enabled');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C (b): the same path added to DARK_GATE_EXCLUSIONS PASSES', () => {
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      exclusionEntries:
        "  { configPath: 'myFeature.enabled', category: 'destructive', reason: 'kills things; off for everyone by design' },",
    });
    try {
      const { code } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C (c): a path registered in DEV_GATED_FEATURES that STILL hardcodes `enabled: false` FAILS', () => {
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      gatedEntries:
        "  { name: 'myFeature', configPath: 'myFeature.enabled', description: 'x', justification: 'read-only, no spend, safe on dev' },",
    });
    try {
      const { code, out } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(1);
      expect(out).toContain('C: registered but hardcodes false');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C (d-category): an exclusion with an UNKNOWN category FAILS', () => {
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      exclusionEntries:
        "  { configPath: 'myFeature.enabled', category: 'not-a-real-category', reason: 'this reason is plenty long enough' },",
    });
    try {
      const { code, out } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(1);
      expect(out).toContain('C: invalid exclusion category');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C (d-reason): an exclusion with a <12-char reason FAILS', () => {
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      exclusionEntries:
        "  { configPath: 'myFeature.enabled', category: 'destructive', reason: 'too short' },",
    });
    try {
      const { code, out } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(1);
      expect(out).toContain('C: exclusion reason too short');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C (f-brace-in-string): a `{`-bearing string default in the block region makes the lint ERROR (loud-fail, not silent desync)', () => {
    const { dir, env } = writeCFixture({
      // A string value containing a brace — codeOnly() does not strip string
      // contents, so the brace would desync depth attribution if not guarded.
      defaultsBody: "  label: 'a value with a { brace inside a string',\n  myFeature: {\n    enabled: false,\n  },",
      exclusionEntries:
        "  { configPath: 'myFeature.enabled', category: 'destructive', reason: 'kills things; off for everyone by design' },",
    });
    try {
      const { code, out } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(1);
      expect(out).toContain('brace-in-string in defaults block');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C (e) golden-path: the resolver reproduces the HAND-AUTHORED dotted-path map for EVERY current `enabled:` line in the real ConfigDefaults (regeneration FORBIDDEN — edit by hand)', () => {
    // ────────────────────────────────────────────────────────────────────────
    // DRIFT CANARY. This map is HAND-AUTHORED by reading src/config/ConfigDefaults.ts
    // directly. It is NOT a vitest snapshot and MUST NEVER be regenerated from the
    // resolver's own output (a snapshot regenerated from the resolver asserts
    // output == output and would bless any misattribution). Updating it is a manual
    // edit on a CODEOWNERS-reviewed path. If this fails, EITHER ConfigDefaults
    // changed (update the map by hand after verifying the new paths) OR the
    // attributor regressed (fix the attributor).
    // ────────────────────────────────────────────────────────────────────────
    // WS1.3 reconcile: the seamlessness block gained the 7-line
    // ws13Reconcile/ws13DryRun/ws13TickMs sub-block, shifting every entry at or
    // after multiMachine.sessionPool by +7. Verified by hand against
    // ConfigDefaults.ts after the post-#1079 merge.
    // CMT-1438 (DEV-AGENT-DARK-GATE-TEETH): 4 paths LEFT this map because their
    // `enabled: false` literal was REMOVED from ConfigDefaults so the dev-gate
    // resolves them live (they moved to DEV_GATED_FEATURES): bootHealthBeacon,
    // parallelWorkSentinel, failureLearning, releaseReadiness — they have NO
    // attributed path now (dev-gated). The 3 D4-held additions
    // (correctionLearning=cost-bearing, apprenticeshipCycleSla/geminiCapacityEscalation
    // =action-bearing) KEEP their `enabled: false` and stay in this map.
    // REBASE onto upstream/main @ v1.3.538 (credential-repointing Step 5/6 #1128/#1130
    // + build-session-yield-safety #1129): those PRs added ConfigDefaults blocks above
    // mcpProcessReaper (yieldSafety is dev-gated → NO new attributed path), shifting
    // every entry from mcpProcessReaper down by +13; sessionReaper/agentWorktreeReaper
    // unchanged. Every line below RE-VERIFIED by hand via the attributor against the
    // MERGED ConfigDefaults.ts (each maps to a real `enabled: false,` line).
    const EXPECTED: Record<string, string> = {
      '138': 'monitoring.sessionReaper.enabled',
      '196': 'monitoring.agentWorktreeReaper.enabled',
      // REBASE onto current main (incl. operator-auth-request #1138 authorizationRequests +
      // credential-repointing Increment B): main shifted mcpProcessReaper-onward; WS2.6 inserts
      // two new `enabled: false` stateSync blocks (userRegistry+topicOperator) after evolutionActions,
      // pushing cartographer to 1066/1111/1136. credentialRepointing + authorizationRequests OMIT
      // enabled (dev-gated). Every line RE-VERIFIED by hand via the attributor on the merged ConfigDefaults.
      '244': 'monitoring.mcpProcessReaper.enabled',
      '258': 'monitoring.agentSleep.enabled',
      '314': 'monitoring.correctionLearning.enabled',
      '408': 'monitoring.apprenticeshipCycleSla.enabled',
      '416': 'monitoring.geminiCapacityEscalation.enabled',
      '440': 'monitoring.greenPrAutoMerge.enabled',
      '490': 'threadline.a2aCheckIn.enabled',
      '582': 'mentor.enabled',
      '593': 'mentor.autonomousFix.enabled',
      '608': 'mentee.enabled',
      // WS4.1-durable-ack (CMT-1416) inserts a plain `ws41DurableAck: false`
      // seamlessness boolean (NOT `enabled:`, so the attributor ignores it) above
      // sessionPool. WS4.3-role-guard (CMT-1416) inserts another plain
      // `ws43RoleGuard: false` seamlessness boolean (also NOT `enabled:`, ignored
      // by the attributor) above sessionPool. WS4.4(f) pool-cache unification
      // (CMT-1416) inserts a 17-line seamlessness block (the OMITTED `ws44PoolCache`
      // dev-gate comment + the plain `ws44PoolCacheTtlMs: 3000` tunable — neither is
      // an `enabled:` path, so the attributor ignores both) above sessionPool,
      // shifting every sessionPool-onward `enabled: false` line +17 from the
      // pre-WS4.4(f) map. RE-VERIFIED by hand via the attributor on the merged ConfigDefaults.
      '768': 'multiMachine.sessionPool.enabled',
      '793': 'multiMachine.sessionPool.inboundQueue.enabled',
      '822': 'multiMachine.sessionPool.holdForStability.enabled',
      '913': 'multiMachine.stateSync.preferences.enabled',
      '927': 'multiMachine.stateSync.relationships.enabled',
      '941': 'multiMachine.stateSync.learnings.enabled',
      '956': 'multiMachine.stateSync.knowledge.enabled',
      '970': 'multiMachine.stateSync.evolutionActions.enabled',
      '984': 'multiMachine.stateSync.userRegistry.enabled',
      '999': 'multiMachine.stateSync.topicOperator.enabled',
      '1107': 'cartographer.freshnessSweep.enabled',
      '1152': 'cartographer.conformanceAudit.llmEnrichment.enabled',
      '1177': 'cartographer.subtreeNav.llmRerank.enabled',
    };
    const actual = attributeRealConfigDefaults();
    expect(actual).toEqual(EXPECTED);
  });

  it('Assertion C (g) destructive-not-gated: the three reapers are in DARK_GATE_EXCLUSIONS and NOT in DEV_GATED_FEATURES', () => {
    const gatedPaths = new Set(DEV_GATED_FEATURES.map((f) => f.configPath));
    const excludedPaths = new Set(DARK_GATE_EXCLUSIONS.map((e) => e.configPath));
    for (const p of [
      'monitoring.mcpProcessReaper.enabled',
      'monitoring.sessionReaper.enabled',
      'monitoring.agentWorktreeReaper.enabled',
    ]) {
      expect(excludedPaths.has(p), `${p} must be in DARK_GATE_EXCLUSIONS`).toBe(true);
      expect(gatedPaths.has(p), `${p} must NOT be in DEV_GATED_FEATURES (it is destructive)`).toBe(false);
    }
    // And each is classified `destructive`.
    for (const p of [
      'monitoring.mcpProcessReaper.enabled',
      'monitoring.sessionReaper.enabled',
      'monitoring.agentWorktreeReaper.enabled',
    ]) {
      const entry = DARK_GATE_EXCLUSIONS.find((e) => e.configPath === p)!;
      expect(entry.category).toBe('destructive');
    }
  });

  it('every DEV_GATED_FEATURES entry carries a non-trivial justification (the human-gate backstop)', () => {
    for (const f of DEV_GATED_FEATURES) {
      expect(typeof f.justification, `${f.name} justification`).toBe('string');
      expect(f.justification.replace(/\s/g, '').length, `${f.name} justification length`).toBeGreaterThanOrEqual(12);
    }
  });

  // ── CMT-1438 (DEV-AGENT-DARK-GATE-TEETH): the retired catch-all + new category ──

  it('VALID_CATEGORIES retires `deliberate-fleet-default` and adds `action-bearing` (the closed concrete-reason set)', () => {
    expect(VALID_CATEGORIES.has('deliberate-fleet-default')).toBe(false);
    expect(VALID_CATEGORIES.has('action-bearing')).toBe(true);
    // The full valid set is exactly the 5 concrete reasons.
    expect([...VALID_CATEGORIES].sort()).toEqual(
      ['action-bearing', 'cost-bearing', 'destructive', 'optional-integration', 'structural-stub'],
    );
  });

  it('Assertion C: the retired `deliberate-fleet-default` category now FAILS, and the fix points to DEV_GATED_FEATURES', () => {
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      exclusionEntries:
        "  { configPath: 'myFeature.enabled', category: 'deliberate-fleet-default', reason: 'off because we said so, no concrete reason' },",
    });
    try {
      const { code, out } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(1);
      expect(out).toContain('C: invalid exclusion category');
      // The fix message names the concrete categories AND points safe-on-dev
      // features to DEV_GATED_FEATURES (spec D2).
      expect(out).toContain('DEV_GATED_FEATURES');
      expect(out).toContain('action-bearing');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C: the new `action-bearing` category is ACCEPTED', () => {
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      exclusionEntries:
        "  { configPath: 'myFeature.enabled', category: 'action-bearing', reason: 'auto-sends a user-facing Telegram escalation when live' },",
    });
    try {
      const { code } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C count-match guard: a backtick/template-literal reason TRIPS the escaped-validation assertion (fail-loud, not silent skip)', () => {
    // The exact silent-skip hole the guard closes: the path regex parses the
    // configPath (so the entry is COUNTED), but the entry regex requires a
    // quote-delimited reason, so a backtick reason is invisible to category+reason
    // validation. Without the guard, a bogus category here would pass CI unseen.
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      exclusionEntries:
        '  { configPath: \'myFeature.enabled\', category: \'not-a-real-category\', reason: `a backtick reason that the entry regex cannot parse` },',
    });
    try {
      const { code, out } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(1);
      expect(out).toContain('C: exclusion entry escaped validation');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C count-match guard: a well-formed (quote-delimited) exclusion does NOT trip the guard', () => {
    const { dir, env } = writeCFixture({
      defaultsBody: '  myFeature: {\n    enabled: false,\n  },',
      exclusionEntries:
        "  { configPath: 'myFeature.enabled', category: 'action-bearing', reason: 'auto-sends a user-facing escalation when live' },",
    });
    try {
      const { code, out } = runLint([path.join(dir, 'ConfigDefaults.ts')], env);
      expect(code).toBe(0);
      expect(out).not.toContain('escaped validation');
    } finally {
      cleanup(dir);
    }
  });

  it('the 3 D4-held features are EXCLUSIONS with concrete categories (cost-bearing / action-bearing), NOT dev-gated', () => {
    const gatedPaths = new Set(DEV_GATED_FEATURES.map((f) => f.configPath));
    const excl = new Map(DARK_GATE_EXCLUSIONS.map((e) => [e.configPath, e.category]));
    expect(excl.get('monitoring.correctionLearning.enabled')).toBe('cost-bearing');
    expect(excl.get('monitoring.apprenticeshipCycleSla.enabled')).toBe('action-bearing');
    expect(excl.get('monitoring.geminiCapacityEscalation.enabled')).toBe('action-bearing');
    for (const p of [
      'monitoring.correctionLearning.enabled',
      'monitoring.apprenticeshipCycleSla.enabled',
      'monitoring.geminiCapacityEscalation.enabled',
    ]) {
      expect(gatedPaths.has(p), `${p} must NOT be dev-gated`).toBe(false);
    }
  });

  it('the 4 audited-safe migrants ARE in DEV_GATED_FEATURES and NOT in DARK_GATE_EXCLUSIONS', () => {
    const gatedPaths = new Set(DEV_GATED_FEATURES.map((f) => f.configPath));
    const excludedPaths = new Set(DARK_GATE_EXCLUSIONS.map((e) => e.configPath));
    for (const p of [
      'monitoring.parallelWorkSentinel.enabled',
      'monitoring.failureLearning.enabled',
      'monitoring.releaseReadiness.enabled',
      'monitoring.bootHealthBeacon.enabled',
    ]) {
      expect(gatedPaths.has(p), `${p} must be dev-gated`).toBe(true);
      expect(excludedPaths.has(p), `${p} must NOT be an exclusion`).toBe(false);
    }
  });

  it('no DARK_GATE_EXCLUSIONS entry uses the retired `deliberate-fleet-default` category', () => {
    for (const e of DARK_GATE_EXCLUSIONS) {
      expect(e.category, `${e.configPath}`).not.toBe('deliberate-fleet-default');
    }
  });
});
