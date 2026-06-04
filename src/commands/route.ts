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
  frameworkFromEnv,
  type IntelligenceFramework,
} from '../core/intelligenceProviderFactory.js';
import { PreferenceStore } from '../providers/uxConfirm/PreferenceStore.js';
import { TaskClassifier } from '../providers/uxConfirm/TaskClassifier.js';
import { OverrideDetector } from '../providers/uxConfirm/OverrideDetector.js';
import { TelegramConfirmer } from '../providers/uxConfirm/TelegramConfirmer.js';
import { StaticCatalogProvider } from '../providers/uxConfirm/StaticCatalogProvider.js';
import { FrameworkModelRouter } from '../providers/uxConfirm/FrameworkModelRouter.js';
import { CostStateTracker } from '../providers/costAwareRouting.js';

export interface RouteCommandOptions {
  user?: string;
  description?: string;
  framework?: string;
  json?: boolean;
  dir?: string;
}

const KNOWN_FRAMEWORKS = ['claude-code', 'codex-cli', 'gemini-cli'];
const KNOWN_MODELS = [
  'opus-4.7',
  'sonnet-4.6',
  'haiku-4.5',
  'gpt-5.3-codex',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'deepseek-v4',
];

function resolveFramework(opt: string | undefined): IntelligenceFramework {
  if (opt) {
    const normalized = opt.toLowerCase();
    if (normalized === 'claude' || normalized === 'claude-code') return 'claude-code';
    if (normalized === 'codex' || normalized === 'codex-cli') return 'codex-cli';
    if (normalized === 'gemini' || normalized === 'gemini-cli') return 'gemini-cli';
  }
  return frameworkFromEnv() ?? 'claude-code';
}

export async function route(taskPrompt: string, options: RouteCommandOptions): Promise<void> {
  if (!taskPrompt || !taskPrompt.trim()) {
    console.error(pc.red('Error: task description is required.'));
    console.error('Usage: instar route "describe the task here"');
    process.exit(1);
  }

  const config = loadConfig(options.dir);
  ensureStateDir(config.stateDir);

  const framework = resolveFramework(options.framework);
  const intelligence = buildIntelligenceProvider({
    framework,
    binaryPath: framework === 'claude-code' ? config.sessions.claudePath : undefined,
    workingDirectory: config.stateDir,
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
