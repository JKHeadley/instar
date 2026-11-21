/**
 * geminiApiModels — the `gemini-api` metered door's OWN model table
 * (docs/specs/gemini-payg-metered-lane.md §1, §3).
 *
 * Deliberately NOT shared with the gemini-cli adapter's KNOWN_GEMINI_MODELS: that table
 * rewrites unknown ids to its default, which here would silently turn a Neon request
 * into a different, differently priced model. This door refuses an unknown label or id
 * instead (`unknown-price` at the gate; `unknown-model` here, before any key use).
 */

export type GeminiApiModelLabel = 'neon' | 'hydrogen';

export interface GeminiApiModel {
  label: GeminiApiModelLabel;
  /** The model id as the API names it, without the `models/` prefix. */
  id: string;
  /** Cheapest verified model is the one the release proof uses (§8). */
  cheapestRank: number;
}

export const GEMINI_API_MODELS: Readonly<Record<GeminiApiModelLabel, GeminiApiModel>> = Object.freeze({
  neon: { label: 'neon', id: 'gemini-4-neon', cheapestRank: 2 },
  hydrogen: { label: 'hydrogen', id: 'gemini-4-hydrogen', cheapestRank: 1 },
});

/** Default output + thinking sizes per caller (§1 Request rules). */
export const GEMINI_API_DEFAULT_SIZES = Object.freeze({
  'spec-review': { maxOutputTokens: 16_384, thinkingBudget: 8_192 },
  'second-opinion': { maxOutputTokens: 4_096, thinkingBudget: 2_048 },
  // The single release-proof call: fixed tiny input, at most 64 output tokens, the
  // model's minimum thinking budget (§8 "Release gate").
  // 128 is the smallest budget current Gemini thinking models accept; a model that wants
  // another value answers 400 before generating (no charge, the proof slot is released).
  'release-proof': { maxOutputTokens: 64, thinkingBudget: 128 },
} as const);

/** Resolve a label or an exact id to the door's model, or null (never a default). */
export function resolveGeminiApiModel(labelOrId: string | undefined | null): GeminiApiModel | null {
  if (typeof labelOrId !== 'string') return null;
  const v = labelOrId.trim().toLowerCase().replace(/^models\//, '');
  for (const m of Object.values(GEMINI_API_MODELS)) {
    if (v === m.label || v === m.id) return m;
  }
  return null;
}

/** The cheapest model in the table (Hydrogen). */
export function cheapestGeminiApiModel(): GeminiApiModel {
  return Object.values(GEMINI_API_MODELS).sort((a, b) => a.cheapestRank - b.cheapestRank)[0];
}
