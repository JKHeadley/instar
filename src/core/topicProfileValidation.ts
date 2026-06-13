/**
 * topicProfileValidation — closed-enum clamps for every Topic Profile field.
 *
 * TOPIC-PROFILE-SPEC §10.2: EVERY profile field is clamped to its closed enum
 * server-side BEFORE persist and before it can reach a launch arg — not just
 * the model arm. The pin write is a NEW untrusted entry point that FABLE's
 * config-sourced resolver did not cover, and `thinkingMode` becomes a launch
 * arg (`-c model_reasoning_effort=…`), so it is an injection surface symmetric
 * to the model one.
 *
 * The clamp runs at the RESOLUTION boundary for every source (store pin,
 * config default, transferred entry) — `validateProfileFields` is pure and
 * callable from all three. Pure logic, no I/O.
 */

import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import { KNOWN_MODEL_IDS, MODEL_ID_RE, escapeIdForAudit } from './ModelTierEscalation.js';
import { SUPPORTED_FRAMEWORKS } from './TopicFrameworksStore.js';

export const THINKING_MODES = ['off', 'low', 'medium', 'high', 'max'] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

/**
 * Claude Code's `--effort` launch flag levels (the live CLI's verified set).
 * A DIRECT pin of the CLI flag value — distinct from `thinkingMode` (which is
 * a cross-framework reasoning-budget abstraction the launch builders MAP onto
 * `--effort`/`model_reasoning_effort`). `effort` passes through verbatim as
 * `--effort <level>` on claude-code spawns and is a strict no-op elsewhere.
 * NOTE: 'ultracode' / 'ultra' are NOT CLI values and are deliberately absent.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const ESCALATION_OVERRIDES = ['inherit', 'suppress'] as const;
export type EscalationOverride = (typeof ESCALATION_OVERRIDES)[number];

export const MODEL_TIERS = ['default', 'escalated'] as const;
export type ProfileModelTier = (typeof MODEL_TIERS)[number];

/** Failure classes for the §10.3 audit — never the raw value verbatim. */
export type ProfileFieldFailure =
  | 'off-enum'
  | 'regex'
  | 'length'
  | 'cross-framework-id'
  | 'model-and-tier-both-set'
  | 'per-token-lane'
  | 'unknown-field';

/**
 * §10.2 billing lane — model ids whose lane would be PER-TOKEN (API-billed,
 * outside the subscription envelope), refused at validation. `knownModelIds`
 * membership proves an id is *recognized*, not that it is inside the
 * subscription envelope; a pin can never introduce a per-token API path
 * (§10.3 — the cost gate's write-time arm).
 *
 * The table is a closed allow/deny classification per framework. TODAY every
 * member of the closed enums rides the subscription envelope (the codex enum
 * mirrors CODEX_MODELS_SUBSCRIPTION by construction; the claude enum is the
 * CLI's subscription-login surface), so the deny sets ship empty — the seam
 * exists so the moment a per-token id joins a known-ids enum it is named here
 * and refused, instead of slipping into a launch arg as billable API spend.
 * If this table and a framework's enum ever disagree, the REFUSAL wins.
 */
export const PER_TOKEN_LANE_MODEL_IDS: Partial<Record<IntelligenceFramework, readonly string[]>> = {
  // All KNOWN_CLAUDE_MODEL_IDS launch via the subscription-authed CLI today.
  'claude-code': [],
  // KNOWN_CODEX_MODEL_IDS mirrors the CODEX_MODELS_SUBSCRIPTION allowlist.
  'codex-cli': [],
  // gemini-cli runs the OAuth (code-assist) lane, not an API key, today.
  'gemini-cli': [],
  // pi-cli's enum is closed-empty — nothing to classify.
  'pi-cli': [],
};

/**
 * §10.2 — refuse a model id whose billing lane would be per-token. Returns
 * null when the id rides the subscription envelope. `perTokenIds` is
 * injectable for tests (both sides of the boundary stay coverable while the
 * shipped deny sets are empty).
 */
export function billingLaneError(
  id: string,
  framework: IntelligenceFramework,
  perTokenIds: readonly string[] = PER_TOKEN_LANE_MODEL_IDS[framework] ?? [],
): ProfileValidationError | null {
  if (perTokenIds.includes(id)) {
    return {
      field: 'model',
      failure: 'per-token-lane',
      reason:
        `'${escapeIdForAudit(id)}' bills per-token (outside the subscription envelope) — ` +
        `a topic pin can't introduce an API-billed path`,
      rejectedPrefix: escapeIdForAudit(id).slice(0, 32),
      rejectedLength: id.length,
    };
  }
  return null;
}

export interface ProfileValidationError {
  field: string;
  failure: ProfileFieldFailure;
  /** Human-readable named reason (operator-facing refusal text). */
  reason: string;
  /** Hard-truncated, charset-clamped prefix of the rejected value (§10.3). */
  rejectedPrefix?: string;
  /** Length of the rejected raw value (§10.3 audit field). */
  rejectedLength?: number;
}

export interface ProfilePatchInput {
  framework?: string | null;
  model?: string | null;
  modelTier?: string | null;
  escalationOverride?: string | null;
  thinkingMode?: string | null;
  effort?: string | null;
}

export interface ValidatedProfilePatch {
  framework?: IntelligenceFramework | null;
  model?: string | null;
  modelTier?: ProfileModelTier | null;
  escalationOverride?: EscalationOverride | null;
  thinkingMode?: ThinkingMode | null;
  effort?: EffortLevel | null;
}

/** §10.3 — a rejected value is arbitrary text; store only a clamped prefix. */
export function clampRejectedValue(value: unknown): { prefix: string; length: number } {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const safe = raw.replace(/[^A-Za-z0-9._\- ]/g, '?');
  return { prefix: safe.slice(0, 32), length: raw.length };
}

/**
 * Validate a profile patch's fields against the closed enums.
 *
 * `effectiveFramework` is the framework the model id will be validated
 * against — the patch's own framework when it sets one, otherwise the
 * topic's currently-resolved framework (caller supplies it).
 *
 * Returns either the validated (narrowed) patch or the FIRST error — a
 * refusal leaves the profile unchanged (§4), so one named reason suffices.
 * `null` field values are CLEAR requests and always valid; `undefined`
 * fields are absent from the patch.
 */
export function validateProfileFields(
  patch: ProfilePatchInput,
  effectiveFramework: IntelligenceFramework,
): { ok: true; patch: ValidatedProfilePatch } | { ok: false; error: ProfileValidationError } {
  const out: ValidatedProfilePatch = {};

  if (patch.framework !== undefined) {
    if (patch.framework === null) {
      out.framework = null;
    } else if ((SUPPORTED_FRAMEWORKS as readonly string[]).includes(patch.framework)) {
      out.framework = patch.framework as IntelligenceFramework;
    } else {
      const { prefix, length } = clampRejectedValue(patch.framework);
      return {
        ok: false,
        error: {
          field: 'framework',
          failure: 'off-enum',
          reason: `framework must be one of: ${SUPPORTED_FRAMEWORKS.join(', ')}`,
          rejectedPrefix: prefix,
          rejectedLength: length,
        },
      };
    }
  }

  if (patch.modelTier !== undefined) {
    if (patch.modelTier === null) {
      out.modelTier = null;
    } else if ((MODEL_TIERS as readonly string[]).includes(patch.modelTier)) {
      out.modelTier = patch.modelTier as ProfileModelTier;
    } else {
      const { prefix, length } = clampRejectedValue(patch.modelTier);
      return {
        ok: false,
        error: {
          field: 'modelTier',
          failure: 'off-enum',
          reason: `modelTier must be 'default' or 'escalated'`,
          rejectedPrefix: prefix,
          rejectedLength: length,
        },
      };
    }
  }

  if (patch.model !== undefined) {
    if (patch.model === null) {
      out.model = null;
    } else {
      const modelError = validateModelId(patch.model, modelFramework(patch, effectiveFramework));
      if (modelError) return { ok: false, error: modelError };
      out.model = patch.model;
    }
  }

  if (patch.thinkingMode !== undefined) {
    if (patch.thinkingMode === null) {
      out.thinkingMode = null;
    } else if ((THINKING_MODES as readonly string[]).includes(patch.thinkingMode)) {
      out.thinkingMode = patch.thinkingMode as ThinkingMode;
    } else {
      const { prefix, length } = clampRejectedValue(patch.thinkingMode);
      return {
        ok: false,
        error: {
          field: 'thinkingMode',
          failure: 'off-enum',
          reason: `thinkingMode must be one of: ${THINKING_MODES.join(', ')}`,
          rejectedPrefix: prefix,
          rejectedLength: length,
        },
      };
    }
  }

  if (patch.effort !== undefined) {
    if (patch.effort === null) {
      out.effort = null;
    } else if ((EFFORT_LEVELS as readonly string[]).includes(patch.effort)) {
      out.effort = patch.effort as EffortLevel;
    } else {
      const { prefix, length } = clampRejectedValue(patch.effort);
      return {
        ok: false,
        error: {
          field: 'effort',
          failure: 'off-enum',
          reason: `effort must be one of: ${EFFORT_LEVELS.join(', ')}`,
          rejectedPrefix: prefix,
          rejectedLength: length,
        },
      };
    }
  }

  if (patch.escalationOverride !== undefined) {
    if (patch.escalationOverride === null) {
      out.escalationOverride = null;
    } else if ((ESCALATION_OVERRIDES as readonly string[]).includes(patch.escalationOverride)) {
      out.escalationOverride = patch.escalationOverride as EscalationOverride;
    } else {
      const { prefix, length } = clampRejectedValue(patch.escalationOverride);
      return {
        ok: false,
        error: {
          field: 'escalationOverride',
          failure: 'off-enum',
          reason: `escalationOverride must be 'inherit' or 'suppress'`,
          rejectedPrefix: prefix,
          rejectedLength: length,
        },
      };
    }
  }

  return { ok: true, patch: out };
}

/** The framework a model id in this patch should validate against. */
function modelFramework(
  patch: ProfilePatchInput,
  effectiveFramework: IntelligenceFramework,
): IntelligenceFramework {
  if (patch.framework && (SUPPORTED_FRAMEWORKS as readonly string[]).includes(patch.framework)) {
    return patch.framework as IntelligenceFramework;
  }
  return effectiveFramework;
}

/**
 * §10.2 model-id clamp: regex shape + membership in the framework's closed
 * `knownModelIds` enumeration. Returns null when valid.
 */
export function validateModelId(
  id: string,
  framework: IntelligenceFramework,
): ProfileValidationError | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    const { prefix, length } = clampRejectedValue(id);
    return {
      field: 'model',
      failure: 'length',
      reason: 'model id must be a non-empty string of at most 64 characters',
      rejectedPrefix: prefix,
      rejectedLength: length,
    };
  }
  if (!MODEL_ID_RE.test(id)) {
    const { prefix, length } = clampRejectedValue(id);
    return {
      field: 'model',
      failure: 'regex',
      reason: 'model id contains characters outside the safe id charset',
      rejectedPrefix: prefix,
      rejectedLength: length,
    };
  }
  const known = KNOWN_MODEL_IDS[framework] ?? [];
  if (!known.includes(id)) {
    return {
      field: 'model',
      failure: known.length === 0 ? 'cross-framework-id' : 'off-enum',
      reason:
        known.length === 0
          ? `framework '${framework}' has no pinnable model ids`
          : `'${escapeIdForAudit(id)}' is not a known ${framework} model id`,
      rejectedPrefix: escapeIdForAudit(id).slice(0, 32),
      rejectedLength: id.length,
    };
  }
  // §10.2 billing lane: enum membership proves the id is recognized, not that
  // it is inside the subscription envelope — a per-token id is refused here.
  const lane = billingLaneError(id, framework);
  if (lane) return lane;
  return null;
}

/**
 * §4 — model and modelTier are mutually exclusive; setting both (or a patch
 * whose merge RESULT would hold both) is a HARD refusal, never a silent
 * winner. Checked against the post-merge shape by the store.
 */
export function modelTierMutualExclusionError(merged: {
  model?: string | null;
  modelTier?: string | null;
}): ProfileValidationError | null {
  if (merged.model != null && merged.modelTier != null) {
    return {
      field: 'model',
      failure: 'model-and-tier-both-set',
      reason: 'pick one: an explicit model or a tier — a profile cannot hold both',
    };
  }
  return null;
}
