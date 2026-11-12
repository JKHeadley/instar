/**
 * T8 (frozen acceptance list, step3/acceptance-tests.md): the framework-id literal ratchet
 * (spec job-launch-intent-record, acceptance criterion 4, D6, D7).
 *
 * Contract fixed here (the spec names the rule, not the module):
 *   scripts/lint-framework-name-ratchet.mjs exports
 *   - countFrameworkLiterals(files: {path, content}[], { exclude: string[] })
 *       → { total: number, perFile: Record<string, number> }
 *     Counts string literals ('…', "…", or `…` with no interpolation) whose whole value is a
 *     framework id (claude-code, codex-cli, gemini-cli, pi-cli, grok-build). Substrings and
 *     comments do not count. `exclude` entries ending in '/' are path prefixes, others exact
 *     paths. Files with a zero count are omitted from perFile.
 *   - checkRatchet(counts, baseline) → { ok: boolean, reasons: string[] }
 *     baseline has the same shape. Fails when the total grows past baseline.total, or when the
 *     summed per-file growth exceeds the summed per-file decreases (a missing key is 0).
 *   The checked-in baseline is scripts/framework-name-ratchet-baseline.json; it must equal the real
 *   counts, and neither it nor src/ may exceed the FROZEN main counts stored in this file.
 *   package.json scripts.lint runs `node scripts/lint-framework-name-ratchet.mjs` as one && step.
 *   CLI: `node scripts/lint-framework-name-ratchet.mjs [--root DIR] [--baseline FILE]` scans DIR/src
 *   (default: the repo) against FILE (default: scripts/framework-name-ratchet-baseline.json), exits
 *   0 when checkRatchet passes and non-zero (printing the reasons) when it fails.
 * Red on main: the script does not exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts/lint-framework-name-ratchet.mjs');
const BASELINE_FILE = path.join(ROOT, 'scripts/framework-name-ratchet-baseline.json');
const EXCLUDE = ['src/providers/adapters/', 'src/core/frameworkFacts.ts', 'src/core/intelligenceProviderFactory.ts'];

type Counts = { total: number; perFile: Record<string, number> };
type Mod = {
  countFrameworkLiterals(files: { path: string; content: string }[], opts: { exclude: string[] }): Counts;
  checkRatchet(counts: Counts, baseline: Counts): { ok: boolean; reasons: string[] };
};

async function load(): Promise<Mod> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ SCRIPT);
  } catch (e) {
    expect.fail(`module missing: scripts/lint-framework-name-ratchet.mjs (${(e as Error).message.split('\n')[0]})`);
  }
  expect(typeof mod.countFrameworkLiterals, 'countFrameworkLiterals is not exported').toBe('function');
  expect(typeof mod.checkRatchet, 'checkRatchet is not exported').toBe('function');
  return mod as unknown as Mod;
}

const B = (perFile: Record<string, number>, total?: number): Counts => ({ perFile, total: total ?? Object.values(perFile).reduce((a, b) => a + b, 0) });

describe('T8 countFrameworkLiterals', () => {
  it('counts whole-value literals in every quote style; ignores substrings, comments and interpolated templates', async () => {
    const { countFrameworkLiterals } = await load();
    const content = [
      "const a = 'claude-code';",
      'const b = "codex-cli";',
      'const c = `gemini-cli`;',
      "if (f === 'pi-cli' || f === 'grok-build') {}",
      "const notId = 'claude-code-x'; const alsoNot = 'my codex-cli path';",
      "// a comment saying 'claude-code' does not count",
      "/* nor 'codex-cli' here */",
      'const t = `${x}-cli`;',
    ].join('\n');
    const r = countFrameworkLiterals([{ path: 'src/core/Foo.ts', content }], { exclude: EXCLUDE });
    expect(r.perFile).toEqual({ 'src/core/Foo.ts': 5 });
    expect(r.total).toBe(5);
  });

  it('skips the adapter tree and the id type definitions', async () => {
    const { countFrameworkLiterals } = await load();
    const lit = "x = 'claude-code';";
    const r = countFrameworkLiterals([
      { path: 'src/providers/adapters/anthropic-headless/a.ts', content: lit },
      { path: 'src/core/frameworkFacts.ts', content: lit },
      { path: 'src/core/intelligenceProviderFactory.ts', content: lit },
      { path: 'src/core/SessionManager.ts', content: lit },
      { path: 'src/core/Empty.ts', content: 'const n = 1;' },
    ], { exclude: EXCLUDE });
    expect(r).toEqual({ total: 1, perFile: { 'src/core/SessionManager.ts': 1 } });
  });
});

describe('T8 checkRatchet', () => {
  it('growth in the total fails', async () => {
    const { checkRatchet } = await load();
    const r = checkRatchet(B({ 'src/a.ts': 3, 'src/b.ts': 2 }), B({ 'src/a.ts': 3, 'src/b.ts': 1 }));
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('a brand-new file with literals fails (growth with no offset)', async () => {
    const { checkRatchet } = await load();
    expect(checkRatchet(B({ 'src/a.ts': 3, 'src/new.ts': 1 }), B({ 'src/a.ts': 3 })).ok).toBe(false);
  });

  it('growth in one file with no offset fails even when the total stays under baseline.total', async () => {
    const { checkRatchet } = await load();
    // baseline.total carries slack (10 vs per-file sum 8); a.ts grows, nothing else drops.
    const r = checkRatchet(B({ 'src/a.ts': 4, 'src/b.ts': 5 }), B({ 'src/a.ts': 3, 'src/b.ts': 5 }, 10));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('src/a.ts');
  });

  it('a compensated rename passes (old key gone, new key carries the same count)', async () => {
    const { checkRatchet } = await load();
    expect(checkRatchet(B({ 'src/new/Moved.ts': 4, 'src/b.ts': 2 }), B({ 'src/old/Moved.ts': 4, 'src/b.ts': 2 }))).toEqual({ ok: true, reasons: [] });
  });

  it('moving counts between files (a split) passes when the total does not grow', async () => {
    const { checkRatchet } = await load();
    expect(checkRatchet(B({ 'src/a.ts': 1, 'src/a2.ts': 2, 'src/b.ts': 2 }), B({ 'src/a.ts': 3, 'src/b.ts': 2 })).ok).toBe(true);
  });

  it('a decrease passes', async () => {
    const { checkRatchet } = await load();
    expect(checkRatchet(B({ 'src/a.ts': 1 }), B({ 'src/a.ts': 3, 'src/b.ts': 2 })).ok).toBe(true);
  });

  it('zero delta passes', async () => {
    const { checkRatchet } = await load();
    const same = B({ 'src/a.ts': 3, 'src/b.ts': 2 });
    expect(checkRatchet(same, structuredClone(same))).toEqual({ ok: true, reasons: [] });
  });
});

/**
 * FROZEN pre-implementation counts, computed from unmodified main 3ae8208a6 (src/ unchanged at
 * 351dab98e) with the reference counter below (TypeScript AST: StringLiteral and
 * NoSubstitutionTemplateLiteral nodes whose cooked text is a framework id; comments never parsed
 * as literals). These numbers live in the test, not in a file the PR can edit, so raising the
 * checked-in baseline together with the source cannot pass. Do not regenerate them to make a
 * change pass: D7 says this PR adds zero literals outside the adapters.
 */
const FROZEN_MAIN: Counts = {
  "total": 1130,
  "perFile": {
    "src/cli.ts": 1,
    "src/commands/init.ts": 35,
    "src/commands/install.ts": 3,
    "src/commands/postDriveTranscriptAudit.ts": 1,
    "src/commands/reflect.ts": 3,
    "src/commands/route.ts": 1,
    "src/commands/server.ts": 85,
    "src/commands/setup-wizard/codex-driver.ts": 1,
    "src/commands/setup-wizard/gemini-driver.ts": 1,
    "src/commands/setup-wizard/state-machine.ts": 4,
    "src/commands/setup.ts": 36,
    "src/config/ConfigDefaults.ts": 2,
    "src/core/BrowserMcpProfileGuard.ts": 2,
    "src/core/ClaudeCliIntelligenceProvider.ts": 2,
    "src/core/ClaudePasteBackController.ts": 1,
    "src/core/CodexCliIntelligenceProvider.ts": 3,
    "src/core/CodexDeliveryObserver.ts": 1,
    "src/core/CodexDeviceLimitJudge.ts": 1,
    "src/core/CodexDeviceLimitTripwire.ts": 1,
    "src/core/CodexResumeMap.ts": 3,
    "src/core/CompositeCredentialIdentityOracle.ts": 2,
    "src/core/Config.ts": 62,
    "src/core/CredentialEnvTokenGate.ts": 1,
    "src/core/CredentialLocationLedger.ts": 1,
    "src/core/CredentialRebalancerSnapshot.ts": 1,
    "src/core/EnrollmentWizard.ts": 1,
    "src/core/FrameworkLoginDriver.ts": 15,
    "src/core/FrameworkSessionStore.ts": 10,
    "src/core/GeminiCliIntelligenceProvider.ts": 1,
    "src/core/IdentityRenderer.ts": 15,
    "src/core/InUseAccountResolver.ts": 1,
    "src/core/IntelligenceRouter.ts": 7,
    "src/core/InteractivePoolIntelligenceProvider.ts": 1,
    "src/core/JevCascade.ts": 1,
    "src/core/ModelSwapService.ts": 1,
    "src/core/ModelTierEscalation.ts": 18,
    "src/core/PendingLoginStore.ts": 5,
    "src/core/PiCliIntelligenceProvider.ts": 1,
    "src/core/PostUpdateMigrator.ts": 22,
    "src/core/PreCompactionFlush.ts": 8,
    "src/core/QuotaPoller.ts": 7,
    "src/core/ResumeValidator.ts": 6,
    "src/core/SessionManager.ts": 95,
    "src/core/StuckInputSentinel.ts": 2,
    "src/core/SubscriptionPool.ts": 1,
    "src/core/SubscriptionReloginHelper.ts": 2,
    "src/core/SubscriptionReloginRuntime.ts": 10,
    "src/core/TopicFrameworksStore.ts": 5,
    "src/core/TopicProfileOrchestrator.ts": 17,
    "src/core/TopicProfileResolver.ts": 4,
    "src/core/TopicResumeMap.ts": 11,
    "src/core/UsageWallRescue.ts": 9,
    "src/core/accountFollowMeCooperativeWipe.ts": 3,
    "src/core/classifyProfileChange.ts": 3,
    "src/core/claudeForbiddenGuard.ts": 1,
    "src/core/codexDeviceLimitWiring.ts": 2,
    "src/core/conversationPorts.ts": 3,
    "src/core/crossModelReviewer.ts": 41,
    "src/core/dashboardTopicProfile.ts": 1,
    "src/core/dynamicMcpConfig.ts": 1,
    "src/core/frameworkInjectionProcesses.ts": 5,
    "src/core/frameworkSessionLaunch.ts": 44,
    "src/core/internalFrameworkDefault.ts": 9,
    "src/core/machineCoherenceManifest.ts": 2,
    "src/core/nativeHookEventsGate.ts": 2,
    "src/core/newSubscriptionAccountId.ts": 2,
    "src/core/resolveFollowMeEnrollTarget.ts": 4,
    "src/core/subscriptionEnums.ts": 5,
    "src/core/threadlineMcpSpawn.ts": 2,
    "src/core/topicProfileValidation.ts": 5,
    "src/core/topicProfileWriteSurface.ts": 1,
    "src/core/types.ts": 71,
    "src/data/llmBenchCoverage.ts": 23,
    "src/data/stall-classes.ts": 5,
    "src/ecosystem/buildEcosystemIdeas.ts": 8,
    "src/feedback-factory/drain/readinessAuthorityProposal.ts": 4,
    "src/feedback-factory/execute/FeedbackExecutorService.ts": 1,
    "src/feedback-factory/execute/buildFeedbackExecutor.ts": 4,
    "src/feedback-factory/execute/independentReview.ts": 4,
    "src/feedback-factory/triage/FeedbackTriageAccountSelector.ts": 1,
    "src/feedback-factory/triage/FeedbackTriageArbiter.ts": 2,
    "src/feedback-factory/triage/buildFeedbackTriage.ts": 6,
    "src/install/doorSteps.ts": 2,
    "src/install/doors.ts": 10,
    "src/lifeline/TelegramLifeline.ts": 1,
    "src/messaging/messageOrigin.ts": 5,
    "src/messaging/shared/telegramRelayPrompt.ts": 5,
    "src/messaging/telegram-origin/OriginCodexModelCanary.ts": 4,
    "src/messaging/telegram-origin/OriginInstallation.ts": 7,
    "src/messaging/telegram-origin/OriginNativeCanaryLane.ts": 7,
    "src/messaging/telegram-origin/OriginNativeHookProof.ts": 2,
    "src/messaging/telegram-origin/OriginSessionRegistry.ts": 10,
    "src/messaging/telegram-origin/RuntimeOriginObserver.ts": 12,
    "src/messaging/telegram-origin/TelegramOriginBoot.ts": 2,
    "src/monitoring/ClaimClauseArbiter.ts": 2,
    "src/monitoring/ClaimObservation.ts": 1,
    "src/monitoring/CompactionSentinel.ts": 3,
    "src/monitoring/CompletionClaimVerifier.ts": 1,
    "src/monitoring/FeatureMetricsLedger.ts": 2,
    "src/monitoring/InstructionsVerifier.ts": 4,
    "src/monitoring/LearnedSkillReconciler.ts": 9,
    "src/monitoring/OrphanProcessReaper.ts": 1,
    "src/monitoring/PermissionPromptAutoResolver.ts": 2,
    "src/monitoring/PresenceProxy.ts": 1,
    "src/monitoring/QuotaCollector.ts": 3,
    "src/monitoring/QuotaTracker.ts": 11,
    "src/monitoring/RateLimitSentinel.ts": 4,
    "src/monitoring/SessionReaper.ts": 17,
    "src/monitoring/SessionWatchdog.ts": 4,
    "src/monitoring/SkillLearningSentinel.ts": 8,
    "src/monitoring/StallTriageNurse.ts": 2,
    "src/monitoring/TokenLedger.ts": 4,
    "src/monitoring/UsageLedger.ts": 13,
    "src/monitoring/adapterVerificationSuite.ts": 4,
    "src/monitoring/claudeTranscriptRoots.ts": 2,
    "src/monitoring/compactionCanary.ts": 6,
    "src/monitoring/contextBudgetSentinelBoot.ts": 8,
    "src/monitoring/contextLayers/layerCaptureWiring.ts": 3,
    "src/monitoring/contextLayers/promptContext.ts": 4,
    "src/monitoring/frameworkActivitySignals.ts": 5,
    "src/monitoring/frameworkProcessSignals.ts": 10,
    "src/monitoring/skillLearning/CommitProtocol.ts": 2,
    "src/monitoring/skillLearning/Drafter.ts": 4,
    "src/monitoring/skillLearning/Outcomes.ts": 2,
    "src/providers/bootRegistration.ts": 4,
    "src/providers/parity/rules/hookParityRule.ts": 10,
    "src/providers/parity/rules/memoryParityRule.ts": 2,
    "src/providers/parity/rules/skillParityRule.ts": 8,
    "src/providers/parity/toolNameMapping.ts": 2,
    "src/providers/uxConfirm/StaticCatalogProvider.ts": 23,
    "src/recommended/aiDoors.ts": 7,
    "src/scheduler/AgentMdJobLoader.ts": 5,
    "src/scheduler/JobModelRoute.ts": 2,
    "src/scheduler/JobScheduler.ts": 3,
    "src/scheduler/MentorOnboardingRunner.ts": 1,
    "src/scheduler/jobTranscriptEvidence.ts": 4,
    "src/server/AgentServer.ts": 5,
    "src/server/mobileCapacityRoutes.ts": 11,
    "src/server/originDisplayPreferences.ts": 1,
    "src/server/promptContextRoutes.ts": 2,
    "src/server/routes.ts": 14,
    "src/server/telegramOriginRoutes.ts": 2,
    "src/threadline/AgentDiscovery.ts": 2,
    "src/threadline/PipeSessionSpawner.ts": 4,
    "src/threadline/ThreadResumeMap.ts": 7,
    "src/threadline/ThreadlineMcpHttpService.ts": 3,
    "src/users/MemoryInboundTracker.ts": 2,
    "src/users/wireMemoryPrivacy.ts": 2
  }
};

const IDS = new Set(['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli', 'grok-build']);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
/** Run the lint exactly as the lint chain does (node, repo root as cwd). */
function runCli(args: string[]) {
  expect(fs.existsSync(SCRIPT), 'scripts/lint-framework-name-ratchet.mjs is missing').toBe(true);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}
const srcFiles = () => walk(path.join(ROOT, 'src')).map((f) => ({ path: path.relative(ROOT, f).split(path.sep).join('/'), content: fs.readFileSync(f, 'utf-8') }));
const excluded = (p: string) => EXCLUDE.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));

/** Reference counter (independent of the module under test). */
function referenceCount(files: { path: string; content: string }[]): Counts {
  const perFile: Record<string, number> = {};
  let total = 0;
  for (const f of files) {
    if (excluded(f.path)) continue;
    const sf = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    let n = 0;
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && IDS.has(node.text)) n++;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (n) { perFile[f.path] = n; total += n; }
  }
  return { total, perFile };
}

describe('T8 this PR against FROZEN main counts (D7: zero delta)', { timeout: 60_000 }, () => {
  // Decreases are allowed (the ratchet permits them), so this is <=, not ===.
  // AFTER A REBASE onto a main that gained literals, re-capture FROZEN_MAIN from the new main
  // (unmodified src/, same reference counter) BEFORE re-applying this PR's src changes, and record
  // the new main sha in the comment above; never re-capture from the PR tree.
  it('the reference count of src/ does not exceed the frozen main total (no net new literal anywhere)', () => {
    const now = referenceCount(srcFiles());
    const grew = Object.entries(now.perFile).filter(([f, n]) => n > (FROZEN_MAIN.perFile[f] ?? 0)).map(([f, n]) => `${f}: ${FROZEN_MAIN.perFile[f] ?? 0} -> ${n}`);
    expect(now.total, `framework-id literals grew past frozen main (${grew.join('; ')})`).toBeLessThanOrEqual(FROZEN_MAIN.total);
  });

  it('the module counts src/ exactly as the reference does', async () => {
    const { countFrameworkLiterals } = await load();
    const files = srcFiles();
    expect(countFrameworkLiterals(files, { exclude: EXCLUDE })).toEqual(referenceCount(files));
  });

  it('the module, run against frozen main, passes its own ratchet', async () => {
    const { countFrameworkLiterals, checkRatchet } = await load();
    expect(checkRatchet(countFrameworkLiterals(srcFiles(), { exclude: EXCLUDE }), FROZEN_MAIN)).toEqual({ ok: true, reasons: [] });
  });

  it('the checked-in baseline equals the real counts and is no looser than frozen main', async () => {
    const { countFrameworkLiterals } = await load();
    expect(fs.existsSync(BASELINE_FILE), 'scripts/framework-name-ratchet-baseline.json is missing').toBe(true);
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8')) as Counts;
    const counts = countFrameworkLiterals(srcFiles(), { exclude: EXCLUDE });
    expect(baseline.total).toBe(counts.total);
    expect(baseline.perFile).toEqual(counts.perFile);
    expect(baseline.total, 'the baseline was raised above frozen main').toBeLessThanOrEqual(FROZEN_MAIN.total);
  });
});

describe('T8 the lint actually runs in CI', { timeout: 120_000 }, () => {
  it('package.json scripts.lint invokes the ratchet as its own && step', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    const steps = pkg.scripts.lint.split('&&').map((x) => x.trim());
    expect(steps, 'scripts.lint does not run node scripts/lint-framework-name-ratchet.mjs').toContain('node scripts/lint-framework-name-ratchet.mjs');
  });

  it('run-lint-parallel (the CI runner) picks the step up from the same list', async () => {
    const runner = await import(/* @vite-ignore */ path.join(ROOT, 'scripts/run-lint-parallel.mjs')) as { parseLintSteps(s: string): string[] };
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    expect(runner.parseLintSteps(pkg.scripts.lint)).toContain('node scripts/lint-framework-name-ratchet.mjs');
  });

  it('the script as CI runs it: exit 0 on the real tree and checked-in baseline (passing control)', () => {
    const r = runCli([]);
    expect(r.status, `ratchet failed on the real tree:\n${r.stdout}${r.stderr}`).toBe(0);
  });

  describe('the script on a temporary fixture tree (--root DIR --baseline FILE)', () => {
    let fx: string;
    beforeEach(() => {
      fx = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-cli-'));
      fs.mkdirSync(path.join(fx, 'src', 'core'), { recursive: true });
      fs.mkdirSync(path.join(fx, 'src', 'providers', 'adapters', 'x'), { recursive: true });
      fs.writeFileSync(path.join(fx, 'src', 'core', 'A.ts'), "export const a = 'claude-code';\nexport const b = 'codex-cli';\n");
      fs.writeFileSync(path.join(fx, 'src', 'providers', 'adapters', 'x', 'ok.ts'), "export const c = 'gemini-cli';\n");
    });
    afterEach(() => SafeFsExecutor.safeRmSync(fx, { recursive: true, force: true, operation: 'tests/unit/framework-id-ratchet.test.ts:cli-fixture' }));
    const baseline = (counts: Counts) => { const f = path.join(fx, 'baseline.json'); fs.writeFileSync(f, JSON.stringify(counts)); return f; };

    it('exits 0 when the fixture matches its baseline (control)', () => {
      const r = runCli(['--root', fx, '--baseline', baseline({ total: 2, perFile: { 'src/core/A.ts': 2 } })]);
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    });

    it('exits non-zero, naming the file, when the fixture grows one past its baseline', () => {
      const r = runCli(['--root', fx, '--baseline', baseline({ total: 1, perFile: { 'src/core/A.ts': 1 } })]);
      expect(r.status, 'an over-baseline tree must fail the lint step').not.toBe(0);
      expect(r.status).not.toBeNull();
      expect(`${r.stdout}${r.stderr}`).toContain('src/core/A.ts');
    });

    it('exits non-zero for a brand-new file with no offset', () => {
      fs.writeFileSync(path.join(fx, 'src', 'core', 'New.ts'), "export const d = 'pi-cli';\n");
      const r = runCli(['--root', fx, '--baseline', baseline({ total: 2, perFile: { 'src/core/A.ts': 2 } })]);
      expect(r.status).not.toBe(0);
      expect(r.status).not.toBeNull();
      expect(`${r.stdout}${r.stderr}`).toContain('src/core/New.ts');
    });
  });
});
