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
      // autonomous-progress-heartbeat (AutonomousProgressHeartbeat): a new
      // monitoring.autonomousProgressHeartbeat ConfigDefaults block (+13 lines)
      // was inserted near the top of SHARED_DEFAULTS (after line 57). It OMITS the
      // `enabled:` literal (dev-gated — resolveDevAgentGate decides), so it adds NO
      // new attributed path; it only shifts EVERY `enabled:` line below it DOWN by
      // +13. Each key below RE-VERIFIED by hand via the attributor on the edited
      // ConfigDefaults (each maps to a real `enabled:` line).
      // autonomous-liveness-reconciler (2026-06-17): a NEW
      // monitoring.autonomousLivenessReconciler ConfigDefaults block (+22 lines)
      // was inserted near the top of SHARED_DEFAULTS (above autonomousHeartbeat). It
      // OMITS the `enabled:` literal (dev-gated — resolveDevAgentGate decides), so it
      // adds NO new attributed path; it only shifts EVERY `enabled:` line below it
      // DOWN by +22. Each key below RE-VERIFIED via the attributor on the merged
      // ConfigDefaults (still 19 entries, same paths — confirming the dev-gate convention).
      '173': 'monitoring.sessionReaper.enabled',
      '231': 'monitoring.agentWorktreeReaper.enabled',
      // REBASE onto current main (incl. operator-auth-request #1138 authorizationRequests +
      // credential-repointing Increment B): main shifted mcpProcessReaper-onward; WS2.6 inserts
      // two new `enabled: false` stateSync blocks (userRegistry+topicOperator) after evolutionActions,
      // pushing cartographer to 1066/1111/1136. credentialRepointing + authorizationRequests OMIT
      // enabled (dev-gated). Every line RE-VERIFIED by hand via the attributor on the merged ConfigDefaults.
      '279': 'monitoring.mcpProcessReaper.enabled',
      '293': 'monitoring.agentSleep.enabled',
      // self-unblock-before-escalating (CMT-1519): the blockerLedger ConfigDefaults block
      // gained two nested OMITTED-`enabled` dev-gate sub-blocks (selfUnblockChecklist +
      // durableVaultSession) + a 6-line explanatory comment. Neither sub-block carries an
      // `enabled:` literal (they OMIT it so the dev-gate resolves them), so the attributor
      // does NOT track them — but the +10 lines they add shift every `enabled: false` default
      // BELOW blockerLedger (correctionLearning-onward) DOWN by +10. The four reapers/sleep
      // ABOVE the block (sessionReaper/agentWorktreeReaper/mcpProcessReaper/agentSleep) are
      // unchanged. Every line below RE-VERIFIED by hand via the attributor on the edited
      // ConfigDefaults (each maps to a real `enabled: false,` line).
      // self-unblock-producer-wiring (PRODUCER increment): the
      // monitoring.blockerLedger.selfUnblockChecklist block gained an OMITTED-enabled
      // `credentialScopeTags: {}` fail-closed default plus a 5-line explanatory
      // comment (NOT an `enabled:` path, so the attributor ignores it) ABOVE every
      // block below — shifting each subsequent `enabled: false` line DOWN by +5.
      // RE-VERIFIED by hand via the attributor on the edited ConfigDefaults.
      '364': 'monitoring.correctionLearning.enabled',
      '458': 'monitoring.apprenticeshipCycleSla.enabled',
      '466': 'monitoring.geminiCapacityEscalation.enabled',
      '490': 'monitoring.greenPrAutoMerge.enabled',
      '540': 'threadline.a2aCheckIn.enabled',
      // secure-a2a-verified-pairing §3.10 (Increment 6): the new
      // threadline.verifiedPairing block (~21 lines, NO `enabled:` literal — see the
      // note below the sessionPool keys) was inserted inside the `threadline` block
      // ABOVE mentor, shifting every subsequent `enabled: false` line DOWN by +19.
      // RE-VERIFIED by hand via the attributor on the edited ConfigDefaults.
      '651': 'mentor.enabled',
      '662': 'mentor.autonomousFix.enabled',
      '677': 'mentee.enabled',
      // multi-machine-lease-self-heal: a NEW multiMachine.leaseSelfHeal block was
      // inserted at the TOP of the `multiMachine` block (ABOVE accountFollowMe). It
      // adds TWO `enabled: false` literals — F2 staleHolderTakeover + F3
      // silentStandbyRelinquish (both classified action-bearing in DARK_GATE_EXCLUSIONS;
      // F1 tickWatchdog is `enabled: true` and F4 preferredAwakeMachineId is null, so
      // neither is attributed). The block (~30 lines incl. its comment) shifts every
      // subsequent `enabled: false` line DOWN by +28. RE-VERIFIED by hand via the
      // attributor on the edited ConfigDefaults (each maps to a real `enabled: false,` line).
      '780': 'multiMachine.leaseSelfHeal.staleHolderTakeover.enabled',
      '784': 'multiMachine.leaseSelfHeal.silentStandbyRelinquish.enabled',
      // WS4.1-durable-ack (CMT-1416) inserts a plain `ws41DurableAck: false`
      // seamlessness boolean (NOT `enabled:`, so the attributor ignores it) above
      // sessionPool. WS4.3-role-guard (CMT-1416) inserts another plain
      // `ws43RoleGuard: false` seamlessness boolean (also NOT `enabled:`, ignored
      // by the attributor) above sessionPool. WS4.4(f) pool-cache unification
      // (CMT-1416) inserts a 17-line seamlessness block (the OMITTED `ws44PoolCache`
      // dev-gate comment + the plain `ws44PoolCacheTtlMs: 3000` tunable — neither is
      // an `enabled:` path, so the attributor ignores both) above sessionPool,
      // shifting every sessionPool-onward `enabled: false` line. WS4.3 journal-
      // lease cutover inserts another 18-line plain-boolean seamlessness block
      // (ws43JournalLease + ws43JournalLeaseDryRun, NOT `enabled:` paths) above
      // sessionPool, a further +18 shift. RE-VERIFIED by hand via the attributor on the merged ConfigDefaults.
      // mm-pool-seamlessness-devgate (operator directive 2026-06-13, topic 13481):
      // the 5 multiMachine.seamlessness coherence flags (ws3OneVoice, ws13Reconcile,
      // ws41DurableAck, ws43RoleGuard, ws43JournalLease) had their hardcoded `false`
      // literals REMOVED (now OMITTED so the dev-gate resolves them live-on-dev / dark-
      // fleet). They were never `enabled:` paths so the attributor never tracked them, but
      // removing the literals + their comment reflow shifted the sessionPool block DOWN by
      // +23 (786→809) and cartographer DOWN by +23 (1100→1123). The 3 sessionPool flags
      // stay HARDCODED false (held — they share the StageAdvancer `stage !== 'dark'` gate,
      // not cleanly dev-gatable), so they remain attributed here. RE-VERIFIED by hand via
      // the attributor on the edited ConfigDefaults (each maps to a real `enabled: false,` line).
      // (+19 shift from the Increment-6 verifiedPairing block — see the mentor note above.)
      // ws52-account-follow-me PR1 (2026-06-17): a NEW multiMachine.accountFollowMe block
      // (~16 lines: an OMITTED-`enabled` dev-gate comment + credentialTransport:{} +
      // maxFollowMachines:5) was inserted into the `multiMachine` block ABOVE sessionPool. It
      // adds NO `enabled:` literal (the flag rides the developmentAgent gate; registered in
      // DEV_GATED_FEATURES) so it introduces no new attributed path. After merging JKHeadley/main
      // (which added its own config above), the sessionPool keys resolve to 872/897/926.
      // RE-VERIFIED by hand via the attributor on the MERGED ConfigDefaults.
      // R6b added `remoteScrapeTimeoutMs` (+7) and R7a added the `spendSlice` block ABOVE
      // these keys; merged with main's revocation-wiring (#1215) config additions → the
      // sessionPool keys resolve as below. RE-VERIFIED via the attributor on the MERGED ConfigDefaults.
      '956': 'multiMachine.sessionPool.enabled',
      '981': 'multiMachine.sessionPool.inboundQueue.enabled',
      '1010': 'multiMachine.sessionPool.holdForStability.enabled',
      // mm-stores-devgate (operator directive 2026-06-13, topic 13481): the 7
      // multiMachine.stateSync.* memory stores MOVED from DARK_GATE_EXCLUSIONS to
      // DEV_GATED_FEATURES and their `enabled: false` literals were REMOVED from
      // ConfigDefaults (the stores now OMIT `enabled` so the dev-gate resolves them
      // live on a dev agent, dark on the fleet) — so they have NO attributed path
      // here anymore (exactly like credentialRepointing/authorizationRequests). Their
      // removal shrank the stateSync block, shifting cartographer up: 1125→1100,
      // 1170→1145, 1195→1170. RE-VERIFIED by hand via the attributor on the edited
      // ConfigDefaults (each maps to a real `enabled: false,` line).
      // agent-owned-followthrough merge of JKHeadley/main (2026-06-15): main's WS2
      // send-side stateSync replication + topicOperator work inserted config between
      // the sessionPool block (824/849/878, unchanged) and cartographer, shifting all
      // three cartographer keys DOWN by +14 (1138→1152, 1183→1197, 1208→1222).
      // RE-VERIFIED by hand via the attributor on the merged ConfigDefaults.
      // secure-a2a-verified-pairing §3.8 (Increment 5): a NEW
      // multiMachine.stateSync.threadlinePairing block with an EXPLICIT `enabled: false`
      // (+ dryRun:true) was appended to the stateSync map (after topicOperator). UNLIKE
      // the 7 WS2 stores it is NOT dev-gated — it ships hard-dark (a credential-gating
      // surface) and is classified in DARK_GATE_EXCLUSIONS (action-bearing). The new
      // `enabled: false` literal IS attributed here (line 1047), and the ~17 lines it
      // adds shift the three cartographer keys DOWN by +17 (1152→1169, 1197→1214,
      // 1222→1239). RE-VERIFIED by hand via the attributor on the edited ConfigDefaults.
      // secure-a2a-verified-pairing §3.10 (Increment 6): a NEW
      // threadline.verifiedPairing block (~21 lines: an OMITTED-`enabled` dev-gate
      // comment + `dryRun:true` + `credentialShareEnforced:false`) was inserted into the
      // `threadline` block ABOVE the stateSync map. It deliberately adds NO `enabled:`
      // literal (the flag rides the developmentAgent gate — a literal `false` would
      // force-dark dev agents, the PR #1001 anti-pattern), so it introduces no new
      // attributed path; it only shifts the threadlinePairing + cartographer keys DOWN
      // by +19 (1047→1066, 1169→1188, 1214→1233, 1239→1258). RE-VERIFIED by hand via the
      // attributor on the edited ConfigDefaults.
      // After merging JKHeadley/main + my accountFollowMe block, these resolve as below.
      // RE-VERIFIED by hand via the attributor on the MERGED ConfigDefaults.
      '1179': 'multiMachine.stateSync.threadlinePairing.enabled',
      '1301': 'cartographer.freshnessSweep.enabled',
      '1346': 'cartographer.conformanceAudit.llmEnrichment.enabled',
      '1371': 'cartographer.subtreeNav.llmRerank.enabled',
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
