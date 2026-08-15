/**
 * `instar route` — One-shot framework+model routing for a task description.
 *
 * Composition root for Phase 5b's suggest-and-confirm UX, exposed via CLI so
 * Justin can exercise the end-to-end flow without standing up Telegram. The
 * CLI path forces the auto-default branch by passing `telegramTopicId: null`
 * — that yields the catalog default with `source: auto-defaulted-no-topic`,
 * which is the deterministic, testable outcome.
 *
 * Wiring:
 *   - IntelligenceProvider via `buildIntelligenceProvider({ framework })`
 *     so a Codex-only install picks Codex; a Claude install picks Claude.
 *   - PreferenceStore at `<stateDir>/framework-model-preferences.db`.
 *   - StaticCatalogProvider (hand-curated Phase 5a fitness picks).
 *   - CostStateTracker with a stub readSdkCredit (returns null until
 *     Tier 3.C plumbs UsageMeterProvider).
 *   - TelegramConfirmer with a no-op transport — the CLI never asks; it
 *     short-circuits at the `no-topic` branch.
 *
 * Output: human-readable summary by default, JSON when `--json` is set.
 */

import pc from 'picocolors';
import path from 'node:path';
import { loadConfig, ensureStateDir } from '../core/Config.js';
import {
  buildIntelligenceProvider,
  type IntelligenceFramework,
} from '../core/intelligenceProviderFactory.js';
import { createCodexExecJsonConfigResolver } from '../core/CodexCliIntelligenceProvider.js';
import { PreferenceStore } from '../providers/uxConfirm/PreferenceStore.js';
import { TaskClassifier } from '../providers/uxConfirm/TaskClassifier.js';
import { OverrideDetector } from '../providers/uxConfirm/OverrideDetector.js';
import { TelegramConfirmer } from '../providers/uxConfirm/TelegramConfirmer.js';
import { StaticCatalogProvider } from '../providers/uxConfirm/StaticCatalogProvider.js';
import { FrameworkModelRouter } from '../providers/uxConfirm/FrameworkModelRouter.js';
import { CostStateTracker } from '../providers/costAwareRouting.js';
import { SUPPORTED_FRAMEWORKS } from '../core/TopicFrameworksStore.js';
import { resolveFrameworkAlias } from '../core/frameworkFacts.js';

export interface RouteCommandOptions {
  user?: string;
  description?: string;
  framework?: string;
  json?: boolean;
  dir?: string;
}

/**
 * Round-22: this was the literal `['claude-code', 'codex-cli', 'gemini-cli']` —
 * an unannotated hand-written list, which is precisely the shape
 * `lint-framework-list-completeness` documents that it CANNOT see. Found by
 * grepping for the fixed defect's siblings rather than by the lint, which is the
 * honest reason to record the gap in that lint's header rather than paper over it.
 *
 * The consequence was small but the class is the recurring one: this feeds
 * OverrideDetector, so an operator saying "run it on grok" was not recognised as
 * naming a framework at all, and the request fell through to the default.
 */
const KNOWN_FRAMEWORKS: ReadonlyArray<string> = SUPPORTED_FRAMEWORKS;
const KNOWN_MODELS = [
  'opus-4.7',
  'sonnet-4.6',
  'haiku-4.5',
  'gpt-5.3-codex',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'deepseek-v4',
];

/**
 * Round-22: the alias table listed three frameworks, so `--framework grok-build`
 * (or `pi-cli`) matched nothing and fell through to `'claude-code'` — an explicit
 * operator instruction to use one framework silently answered by another. That is
 * the same class as the five impersonation sites rounds 15-17 closed, in the
 * mildest possible place: a CLI flag rather than a spawn path.
 *
 * The fix routes through `resolveFrameworkAlias` — the canonical table this repo
 * ALREADY had, which `frameworkFromEnv` had been using all along. My first cut
 * re-derived the aliases here from the canonical list, which would have been a
 * third spelling of the same table: correct today, free to drift tomorrow, and the
 * exact thing this whole round is about. Two callers of one table, not two tables.
 *
 * ROUND-22, SECOND DEFECT IN THE SAME FUNCTION — the sixth impersonation site.
 * The chain ended at a hardcoded `'claude-code'`, ignoring what the agent is
 * actually configured to run. Paired with the call site's
 * `binaryPath: framework === 'claude-code' ? config.sessions.claudePath : undefined`,
 * that is the round-15/16 shape at a sixth location: on a grok-primary agent
 * `sessions.claudePath` HOLDS THE GROK BINARY (Config.ts sets it from the
 * configured framework, a documented back-compat carry), so `instar route "..."`
 * with no flag resolved the label `claude-code`, handed it grok's binary, and
 * built a Claude provider around it — Claude's argv against grok's CLI, with none
 * of the grok lane's controls.
 *
 * Scope, stated at the width of the evidence: this is a CODE-PATH finding, read
 * from Config.ts's claudePath assignment and this call site. I did not execute it
 * — doing so spends real tokens against an unmetered pool, and the read is
 * unambiguous.
 *
 * Two corrections, both removing a duplicate rather than adding a guard:
 *   1. The chain now falls back to the agent's OWN resolved framework
 *      (`config.sessions.framework`) before the historical default. That value is
 *      `resolveConfiguredFramework`'s output, which ALREADY consults
 *      INSTAR_FRAMEWORK — so `frameworkFromEnv()` is dropped here rather than kept
 *      alongside it. A second env read is a second precedence chain, which is how
 *      two readers of one variable came to disagree in round 21.
 *   2. The call site now reads `frameworkBinaryPaths[framework]` — the canonical
 *      per-framework map that already honours operator overrides — instead of the
 *      back-compat `claudePath` whose meaning depends on which framework the agent
 *      runs. No framework label is ever paired with another framework's binary.
 */
function resolveFramework(
  opt: string | undefined,
  configuredFramework: IntelligenceFramework | undefined,
): IntelligenceFramework {
  return resolveFrameworkAlias(opt) ?? configuredFramework ?? 'claude-code';
}

export async function route(taskPrompt: string, options: RouteCommandOptions): Promise<void> {
  if (!taskPrompt || !taskPrompt.trim()) {
    console.error(pc.red('Error: task description is required.'));
    console.error('Usage: instar route "describe the task here"');
    process.exit(1);
  }

  const config = loadConfig(options.dir);
  ensureStateDir(config.stateDir);

  const framework = resolveFramework(options.framework, config.sessions.framework);
  const intelligence = buildIntelligenceProvider({
    framework,
    // See resolveFramework above: NEVER `sessions.claudePath`, whose value is the
    // configured framework's binary rather than Claude's on a non-Claude agent.
    binaryPath: config.sessions.frameworkBinaryPaths?.[framework],
    workingDirectory: config.stateDir,
    // codex exec-json kill-switch — read from this project's config.json.
    resolveExecJson: createCodexExecJsonConfigResolver(
      path.join(options.dir ?? process.cwd(), '.instar', 'config.json'),
    ),
  });

  if (!intelligence) {
    console.error(pc.red(`Error: no IntelligenceProvider available for framework "${framework}".`));
    console.error('Check that the framework binary is installed and resolvable.');
    process.exit(1);
  }

  const dbPath = path.join(config.stateDir, 'framework-model-preferences.db');
  const store = new PreferenceStore({ dbPath });
  const catalog = new StaticCatalogProvider();
  const costStateTracker = new CostStateTracker({
    readSdkCredit: async () => null, // Tier 3.C will wire UsageMeterProvider here.
  });

  const classifier = new TaskClassifier({ intelligence });
  const overrideDetector = new OverrideDetector({
    intelligence,
    knownFrameworks: KNOWN_FRAMEWORKS,
    knownModels: KNOWN_MODELS,
  });

  // No-op transport — the CLI flow never reaches awaitReply because we pass
  // telegramTopicId: null below, which short-circuits at the no-topic gate
  // before the confirmer is consulted. The transport is here for type
  // soundness only.
  const noopTransport = {
    async send(): Promise<void> { /* no-op */ },
    async awaitReply(): Promise<string | null> { return null; },
  };
  const confirmer = new TelegramConfirmer({
    transport: noopTransport,
    overrideDetector,
  });

  const router = new FrameworkModelRouter({
    classifier,
    store,
    confirmer,
    costStateTracker,
    catalog,
  });

  const result = await router.route({
    userId: options.user ?? 'cli-user',
    taskPrompt,
    taskDescription: options.description ?? taskPrompt.slice(0, 80),
    telegramTopicId: null, // CLI path → auto-default branch (no UX round-trip).
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log();
  console.log(pc.bold('Framework + model routing result'));
  console.log(pc.dim('─'.repeat(48)));
  console.log(`  ${pc.cyan('Framework:')}      ${pc.bold(result.framework)}`);
  console.log(`  ${pc.cyan('Model:')}          ${pc.bold(result.model)}`);
  console.log(`  ${pc.cyan('Task pattern:')}   ${result.taskPattern}`);
  console.log(`  ${pc.cyan('Source:')}         ${pc.yellow(result.source)}`);
  console.log(`  ${pc.cyan('Catalog default:')} ${result.catalogDefault.framework} / ${result.catalogDefault.model} (${result.catalogDefault.confidence})`);
  console.log();
  console.log(pc.dim('Note: CLI invocation forces the no-topic branch (auto-defaults).'));
  console.log(pc.dim('The full confirm-via-Telegram flow lands when the server endpoint wires this router.'));
}
