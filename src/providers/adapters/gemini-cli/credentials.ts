/**
 * Credential boundary rationale for the gemini-cli adapter (Rule-1a analog).
 *
 * Gemini CLI auths via `~/.gemini` cached OAuth credentials — the
 * subscription / cached-OAuth path. The danger, exactly as with Codex's
 * `OPENAI_API_KEY`, is that a billing-capable Google/Gemini env var present
 * in the parent process would silently route Gemini onto a BILLED API path
 * instead of the cached-OAuth path. A runaway loop on the raw API drains
 * real money; the asymmetric cost of a false-negative (silent billing) is
 * why the delete is UNCONDITIONAL.
 *
 * The structural defense lives in `transport/geminiSpawn.ts`:
 *   - `buildGeminiChildEnv` is an explicit ALLOWLIST (not a blocklist).
 *   - `GEMINI_BILLING_ENV_VARS` are hard-deleted from the child env on EVERY
 *     spawn, regardless of allowlist contents.
 *
 * The `geminiKeyLeakageCanary` asserts none of those vars ever reach a child
 * env even under sentinel-injection in the parent — the structural invariant
 * is "no billing leak, ever."
 *
 * RULE 3.1 RATIONALE
 *   Criticality: critical — a leak silently bills the user's Google/Gemini
 *                API account at full per-token rates.
 *   Frequency:   per-spawn (every Gemini child process construction).
 *   Stability:   stable — the env-allowlist is internal Instar code; the
 *                Gemini CLI's env-var precedence is the upstream surface this
 *                defends against (build-time §6 discovery sharpens the
 *                rationale but does NOT gate the delete).
 *   Fallback:    none — the invariant is "no leak, ever"; a detected
 *                violation requires a code fix, not self-heal.
 *   Verdict:     deterministic structural construction (allowlist + hard
 *                deletes), gated by the geminiKeyLeakageCanary.
 */

import { GEMINI_BILLING_ENV_VARS } from './transport/geminiSpawn.js';

/**
 * The billing-capable Google/Gemini env vars that are unconditionally
 * deleted from any Gemini child env. Re-exported from the transport (single
 * source of truth) so the canary + any future caller reference one list.
 */
export const BILLING_ENV_VARS = GEMINI_BILLING_ENV_VARS;
