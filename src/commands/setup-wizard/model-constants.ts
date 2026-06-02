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
 */
export const WIZARD_CODEX_MODEL = 'gpt-5.3-codex';

/**
 * Gemini model used by the hybrid wizard's Gemini driver.
 *
 * This matches the verified one-shot default for the gemini-cli adapter:
 * `gemini -m gemini-2.5-flash --approval-mode default -p <prompt>`.
 */
export const GEMINI_WIZARD_MODEL = 'gemini-2.5-flash';
