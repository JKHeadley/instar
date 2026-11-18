/**
 * The design lane — one named model per door for design and review work
 * (docs/specs/frontier-design-review-standard.md §1).
 *
 * Every id here is pinned by `scripts/model-registry-freshness.manifest.json`
 * (pins `design-lane-*`), and each must be the door's `designLane` and a member of
 * the door's frontier set, so the id in code and the id in the registry cannot
 * drift and the strict freshness lint fails when the lane ages out of its review
 * window. No skill, brief, prompt or awareness text names a model id; they say
 * "the design model" and code resolves it here.
 */

import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import { CLAUDE_CODE_FRAMEWORK, CODEX_CLI_FRAMEWORK, GEMINI_CLI_FRAMEWORK, GROK_BUILD_FRAMEWORK, PI_CLI_FRAMEWORK } from './frameworkFacts.js';

/** The Claude door's design model (pinned: design-lane-claude-code). */
export const DESIGN_LANE_CLAUDE_CODE = 'claude-fable-5-2';
/** The Codex door's design model (pinned: design-lane-codex-cli). */
export const DESIGN_LANE_CODEX_CLI = 'gpt-6-astra';
/** The Gemini door's design model (pinned: design-lane-gemini-cli). */
export const DESIGN_LANE_GEMINI_CLI = 'gemini-4-argon';

/**
 * Door (framework) → design model, or `null` where the door has no lane. A door
 * with no lane gets today's behaviour everywhere this module is read.
 */
export const DESIGN_LANE_MODELS: Readonly<Record<IntelligenceFramework, string | null>> = Object.freeze({
  [CLAUDE_CODE_FRAMEWORK]: DESIGN_LANE_CLAUDE_CODE,
  [CODEX_CLI_FRAMEWORK]: DESIGN_LANE_CODEX_CLI,
  [GEMINI_CLI_FRAMEWORK]: DESIGN_LANE_GEMINI_CLI,
  [PI_CLI_FRAMEWORK]: null,
  [GROK_BUILD_FRAMEWORK]: null,
});

/** The design model for a framework, or `null` (unknown framework or no lane). */
export function resolveDesignModel(framework: string | undefined | null): string | null {
  if (typeof framework !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(DESIGN_LANE_MODELS, framework)) return null;
  return DESIGN_LANE_MODELS[framework as IntelligenceFramework] ?? null;
}

/** Whether `model` is the design model of any door. */
export function isDesignLaneModel(model: string | undefined | null): boolean {
  if (typeof model !== 'string' || model.length === 0) return false;
  return Object.values(DESIGN_LANE_MODELS).includes(model);
}
