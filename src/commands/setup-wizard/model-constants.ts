/**
 * Codex model used by the hybrid wizard's Codex driver.
 *
 * Codex CLI's bundled default (gpt-5.2-codex) was retired from
 * ChatGPT-subscription accounts on 2026-04-14 and is API-only since.
 * The wizard targets the subscription path by default, so we pin to a
 * model empirically confirmed-working on ChatGPT auth (see
 * src/providers/adapters/openai-codex/models.ts for the full
 * availability matrix). gpt-5.3-codex is the "balanced" tier in that
 * matrix.
 *
 * Override surface (LLM-ROUTING-REGISTRY.md risk item #5): the wizard
 * runs BEFORE `.instar/config.json` exists, so the override is an env
 * var, not a config key — `INSTAR_WIZARD_CODEX_MODEL`. Absent ⇒ the
 * shipped default applies, byte-for-byte.
 */
export const WIZARD_CODEX_MODEL_DEFAULT = 'gpt-5.3-codex';

/** Resolve the wizard codex model: env override → shipped default. */
export function resolveWizardCodexModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env['INSTAR_WIZARD_CODEX_MODEL']?.trim();
  return override || WIZARD_CODEX_MODEL_DEFAULT;
}

export const WIZARD_CODEX_MODEL = resolveWizardCodexModel();

/**
 * Gemini model used by the hybrid wizard's Gemini driver.
 *
 * This matches the verified one-shot default for the gemini-cli adapter:
 * `gemini -m gemini-2.5-flash --approval-mode default -p <prompt>`.
 *
 * Override surface (LLM-ROUTING-REGISTRY.md risk item #6): env var
 * `INSTAR_WIZARD_GEMINI_MODEL` (same pre-config rationale as above).
 */
export const GEMINI_WIZARD_MODEL_DEFAULT = 'gemini-2.5-flash';

/** Resolve the wizard gemini model: env override → shipped default. */
export function resolveWizardGeminiModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env['INSTAR_WIZARD_GEMINI_MODEL']?.trim();
  return override || GEMINI_WIZARD_MODEL_DEFAULT;
}

export const GEMINI_WIZARD_MODEL = resolveWizardGeminiModel();
