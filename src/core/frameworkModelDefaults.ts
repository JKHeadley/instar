import { readFileSync } from 'node:fs';
import { CODEX_CLI_FRAMEWORK, CODEX_MOVING_MODEL_DEFAULT } from './frameworkFacts.js';
import { resolveInteractiveLaunchModel } from './frameworkSessionLaunch.js';

import { mergeDefaults } from './mergeDefaults.js';
import type { SessionManagerConfig } from './types.js';

type ModelDefaults = NonNullable<SessionManagerConfig['frameworkDefaultModels']>;

/** Effective defaults for launches and displays. Keep these out of saved config. */
export function effectiveFrameworkModelDefaults(overrides: ModelDefaults | undefined): ModelDefaults {
  return mergeDefaults<ModelDefaults>({ [CODEX_CLI_FRAMEWORK]: CODEX_MOVING_MODEL_DEFAULT }, overrides);
}

let reviewedCodexModels: readonly string[] | undefined;
const reportedWarnings = new Set<string>();

function warnOnce(message: string): void {
  if (reportedWarnings.has(message)) return;
  console.warn(`[framework-model-defaults] ${message}`);
  reportedWarnings.add(message);
}

const selectors = { 'latest:sol': 'sol', 'latest:astra': 'astra' } as const;

function selectorFamily(selector: string): string | undefined {
  return Object.hasOwn(selectors, selector) ? selectors[selector as keyof typeof selectors] : undefined;
}

function resolveSelector(selector: string): string | undefined {
  const family = selectorFamily(selector);
  return family ? newestCodexFamilyModel(family) : undefined;
}

export function validFrameworkModelDefaults(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([framework, model]) =>
      typeof model === 'string' && model.trim().length > 0
      && (framework !== CODEX_CLI_FRAMEWORK || !model.startsWith('latest:') || !!resolveSelector(model)),
    );
}

function codexModels(): readonly string[] {
  if (reviewedCodexModels) return reviewedCodexModels;
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../scripts/model-registry-freshness.manifest.json', import.meta.url), 'utf8'),
    );
    const models: unknown = manifest.doors[CODEX_CLI_FRAMEWORK].topModels;
    if (!Array.isArray(models)) throw new Error('Missing Codex model list');
    reviewedCodexModels = models
      .filter(model => typeof model?.id === 'string' && (model.role == null
        || (typeof model.role === 'string' && !model.role.startsWith('retired-'))))
      .map(model => model.id);
  } catch {
    warnOnce('The reviewed Codex catalog is unavailable. Moving defaults will use the built-in balanced model.');
    reviewedCodexModels = [];
  }
  return reviewedCodexModels;
}

const codexModel = /^gpt-(\d+)(?:\.(\d+))?-(sol|astra|luna|terra)$/;

export function newestCodexFamilyModel(family: string, models = codexModels()): string | undefined {
  let newest: { id: string; major: number; minor: number } | undefined;
  for (const id of models) {
    const match = codexModel.exec(id);
    if (match?.[3] !== family) continue;
    const major = Number(match[1]);
    const minor = Number(match[2] ?? 0);
    if (!newest || major > newest.major || (major === newest.major && minor > newest.minor)) {
      newest = { id, major, minor };
    }
  }
  return newest?.id;
}

export function resolveFrameworkModelDefault(framework: string, configured: string | undefined): string | undefined {
  if (configured !== undefined && (typeof configured !== 'string' || !configured.trim())) {
    warnOnce('An invalid framework model setting was ignored.');
    return framework === CODEX_CLI_FRAMEWORK ? resolveInteractiveLaunchModel(framework, undefined) : undefined;
  }
  if (framework !== CODEX_CLI_FRAMEWORK || !configured) return configured;
  if (configured.startsWith('latest:')) {
    const model = resolveSelector(configured);
    if (!model) warnOnce('A Codex family default could not be resolved. The built-in balanced model will be used.');
    return model ?? resolveInteractiveLaunchModel(framework, undefined);
  }

  const family = codexModel.exec(configured)?.[3];
  if (family) {
    const newest = newestCodexFamilyModel(family, [...codexModels(), configured]);
    if (newest && configured !== newest) warnOnce(`Codex default ${configured} is pinned behind ${newest}`);
  }
  return configured;
}
