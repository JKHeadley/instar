/**
 * crossModelReviewer — Step B of the tiered development process.
 *
 * Governed by: *Never Silently Cut the Data a Decision Depends On*
 * (docs/STANDARDS-REGISTRY.md). This file carries the case that earned that article:
 * `CONTEXT_BUDGET_BYTES` (derived from the transport, derivation recorded in place),
 * `LOAD_BEARING_CONTEXT_SUBSTRINGS` (the context a review is not valid without), and the
 * `context-incomplete` REFUSAL in `runCrossModelReview` — which exists because this file's
 * disclosure layer was already correct and complete, and six rounds of review were conducted on a
 * fabricated view of the world anyway. Disclosure informs a reader who reads; refusal does not
 * depend on anyone reading.
 *
 * Re-platforms the `/spec-converge` external "cross-model" reviewer onto the
 * agent's own installed `codex` CLI. The external pass that the skill used to
 * describe as running "via the /crossreview pattern" (a never-built
 * placeholder) is now a grounded mechanism: detect whether a supported reviewer
 * framework is installed + authed, assemble the cross-model reviewer prompt
 * (spec + referenced context, bounded to a budget), and run it THROUGH the
 * existing `CodexCliIntelligenceProvider` (the factory with
 * `framework: 'codex-cli'`, model `capable` → GPT-tier).
 *
 * Design invariants (see docs/specs/codex-crossreview-stepB-spec.md):
 *   - Detection is a pure function with injectable inputs (no real spawns in
 *     unit tests). It is SIGNAL-ONLY — it never throws and never blocks.
 *   - Reviewer invocation reuses the provider (its scratch-dir clean-notepad,
 *     env allowlist, `--skip-git-repo-check`, and the account-global circuit
 *     breaker the factory wraps it in). The ONLY new spawn-adjacent code is
 *     prompt assembly + result parsing.
 *   - Every failure mode routes toward internal-only convergence or a captured
 *     raw finding — never a stall. `unavailable` (no framework) is distinct
 *     from `degraded` (framework present, this call failed) and
 *     `skipped-abbreviated` (author chose the fast path).
 *
 * codex is the FIRST supported framework; gemini-cli is the SECOND (Piece 3 of
 * docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md — cross-model convergence
 * hardening). The registry (`SUPPORTED_REVIEWER_FRAMEWORKS`) remains the single
 * seam for further frameworks. Adding a framework is one registry entry + one
 * `id`-union extension — no skill change.
 *
 * Piece 3 additions (all signal-only, never-throw, same invariants as above):
 *   - `detectGeminiReviewer` + the gemini registry entry (family diversity).
 *   - `detectAllCrossModelReviewers` — collect EVERY available framework, not
 *     just the first match, so the skill runs one external pass per family.
 *   - `isConcreteReviewerModel` — the fail-loud model canary: a tier word
 *     ('capable', 'fast', …) falling through model resolution degrades the
 *     review LOUDLY instead of silently selecting a dead reviewer.
 *   - `hashSpecReviewableBody` — delta-gating: externals re-run only when the
 *     spec's reviewable body (frontmatter stripped) actually changed.
 *   - `recordFrameworkActivationObservation` / `wasNonClaudeFrameworkActiveWithin`
 *     — the durable standing-framework baseline: activation is judged against
 *     a lookback window of recorded observations, not a just-in-time reading,
 *     so a just-before-converge framework deactivation cannot exempt a spec.
 *   - `TRUSTED_REVIEWER_FRAMEWORKS` — the provider allowlist (no spec egress
 *     to untrusted/custom endpoints).
 */

import { SafeFsExecutor } from './SafeFsExecutor.js';
import { frameworkBinaryExists } from './frameworkSessionLaunch.js';
import { resolveGrokBinaryPath } from '../providers/adapters/grok-build/config.js';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCodexPath, detectGeminiPath, detectClaudePath, detectGrokPath } from './Config.js';
import {
  resolveGrokHome,
  grokAuthPath as grokAuthPathFor,
} from '../providers/adapters/grok-build/config.js';
import {
  readSessionAuthState,
  isLoginPolicyVerified,
  checkGrokVersionDrift,
  getGrokVersionDriftNote,
  GROK_FORBIDDEN_ENV_VARS,
} from '../providers/adapters/grok-build/policy.js';
import { validateRule1 } from '../providers/adapters/openai-codex/credentials.js';
import { resolveCliModelFlag } from '../providers/adapters/openai-codex/models.js';
import { resolveCliModelFlag as resolveGeminiModelFlag } from '../providers/adapters/gemini-cli/models.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { ClaudeForbiddenError } from './claudeForbiddenGuard.js';
import {
  buildIntelligenceProvider,
  type IntelligenceFramework,
} from './intelligenceProviderFactory.js';
import type { IntelligenceOptions } from './types.js';

// ── Constants (tunable) ─────────────────────────────────────────────────

/**
 * Per-call timeout for a cross-model spec review. A reasoning review of a
 * full spec is far heavier than the provider's 30s judgment-call default, so
 * Step B bumps it to 120s (spec §2).
 */
export const REVIEW_TIMEOUT_MS = 120_000;

/**
 * Per-family reviewer-timeout clamp bounds (REVIEWER-DOOR-REWIRING §3.2 / §7 /
 * D6): a resolved timeout is clamped to [30s, 900s]. A value below the floor
 * clamps UP to 30s; above the ceiling clamps DOWN to 900s. The 120s default
 * (`REVIEW_TIMEOUT_MS`) sits inside this range, so an absent knob is unaffected.
 */
export const REVIEWER_TIMEOUT_MIN_MS = 30_000;
export const REVIEWER_TIMEOUT_MAX_MS = 900_000;

/**
 * Total context budget (spec + referenced docs) inlined into the reviewer
 * prompt. codex runs in an empty read-only scratch dir with no repo access,
 * so referenced context MUST be inlined; this bounds the prompt size (spec §2).
 * The spec is always included in full; referenced context fills the remainder
 * and is truncated (with a loud note) if it overflows.
 *
 * ── DERIVATION (governed by *Never Silently Cut the Data a Decision Depends On*) ─────────────
 * This number is DERIVED from the binding constraint on the consumer, and the
 * derivation is recorded here so it can be re-checked rather than inherited.
 * Re-derive it whenever the transport or the supported reviewer families
 * change; do not tune it by feel.
 *
 *   Candidate constraint 1 — the model's context window. Every reviewer
 *   family this registry supports at the `capable` tier accepts >= 200K
 *   input tokens, i.e. roughly 800 KB of English markdown at ~4 chars/token.
 *   NOT binding.
 *
 *   Candidate constraint 2 — the TRANSPORT. The exec-json path hands the
 *   prompt to the CLI on stdin (unbounded). But `intelligence.codexExecJson:
 *   false` is a documented rollback lever, and the plain path passes the
 *   prompt as a single argv element, which must fit inside the host's
 *   ARG_MAX *together with the whole environment* — 1 MiB on macOS, 2 MiB on
 *   typical Linux. BINDING, and binding on the smaller host.
 *
 * So the budget is set from the transport, at a quarter of the smaller
 * ARG_MAX: 256 KiB. That leaves three quarters of ARG_MAX for the
 * environment and the rest of the command line on the worst-case host, and
 * is ~64K tokens — comfortably inside every supported model's window.
 *
 * WHAT THIS NUMBER DOES NOT PROMISE. It is a transport ceiling, not a
 * guarantee that any given spec plus its parent design will fit. When the
 * load-bearing context does NOT fit, the review does not quietly proceed on
 * a partial view: `assembleReviewerPrompt` records the omission and
 * `runCrossModelReview` returns `degraded` rather than a verdict. See
 * `LOAD_BEARING_CONTEXT_SUBSTRINGS`.
 *
 * HISTORY. This was 60 KB from the spec's first draft until 2026-08-22, a
 * number with no recorded derivation. At that size the budget was smaller
 * than a single ordinary spec, so referenced context was dropped in FULL on
 * every round of every review — the truncation note read "truncated to fit"
 * while describing 100% loss. Six rounds of cross-model review on
 * `placement-real-capacity-scoring` were conducted without the reviewers
 * ever seeing the parent design, the standards registry, or the lessons doc.
 * The disclosure machinery worked correctly throughout; nothing refused.
 */
export const CONTEXT_BUDGET_BYTES = 256 * 1024;

/**
 * Deterministic priority ordering for referenced context (spec §2, F4).
 *
 * When the budget can't hold every referenced doc, truncation MUST be
 * deterministic — the same spec + same docs always drop the same docs — so a
 * review is reproducible and the "what got dropped" note is stable. The
 * constitutional / lessons docs are the highest-value context for a reviewer
 * (they're what the lessons-aware internal reviewer reads), so they are kept
 * FIRST; everything else keeps the spec-declared link order (the order the
 * caller passed the docs in, which is the order they appear in the spec).
 *
 * A doc whose path contains one of these substrings sorts ahead of the rest,
 * in THIS order. Ties (and all non-priority docs) preserve the caller's order
 * via a stable sort.
 */
export const CONTEXT_PRIORITY_SUBSTRINGS: readonly string[] = [
  'signal-vs-authority',
  'INSTAR-DESIGN-PRINCIPLES-AND-LESSONS',
  'STANDARDS-REGISTRY',
  'integrated-being',
] as const;

/**
 * The subset of referenced context a cross-model review is NOT VALID WITHOUT
 * (governed by *Never Silently Cut the Data a Decision Depends On*).
 *
 * The reviewer's job is to judge a spec against the design and the rules it is
 * built on. A reviewer that received the spec but none of those documents can
 * only check whether the spec agrees with ITSELF — a materially weaker check
 * wearing the same name. So when a budget walk cannot admit one of these docs
 * IN FULL, the honest outcome is not "a review with a caveat"; it is NOT A
 * REVIEW, and `runCrossModelReview` degrades rather than returning a verdict.
 *
 * PARTIAL COUNTS AS OMITTED, deliberately. Half of the standards registry, cut
 * at whatever byte the budget ran out on, is not the standards registry — the
 * reviewer cannot know whether the clause that governs this spec was in the
 * half it received. Treating a partial constitutional doc as "present" is the
 * same substitution of a symbol for the state that this rule exists to stop.
 *
 * These coincide with `CONTEXT_PRIORITY_SUBSTRINGS` today, and that is not a
 * coincidence — a doc is kept first BECAUSE the review is worthless without it.
 * They are named separately because they answer different questions (what order
 * do docs go in / what may a review proceed without), and a future doc could
 * be worth prioritising without being load-bearing.
 *
 * SPELLED OUT RATHER THAN ALIASED, deliberately (independent review 2026-08-22,
 * finding C8). This was `= CONTEXT_PRIORITY_SUBSTRINGS` — the SAME array object,
 * which made the paragraph above false: with an alias, adding a doc to the
 * priority list silently promotes it to a review-BLOCKER, and the divergence the
 * comment reserves the right to have is unrepresentable. A list that claims to
 * be separate must be separate; two lists that happen to agree are checked by
 * `load-bearing docs are a subset of the priority order` in the unit tests.
 */
export const LOAD_BEARING_CONTEXT_SUBSTRINGS: readonly string[] = [
  'signal-vs-authority',
  'INSTAR-DESIGN-PRINCIPLES-AND-LESSONS',
  'STANDARDS-REGISTRY',
  'integrated-being',
] as const;

/** True when a context doc path is one the review is not valid without. */
export function isLoadBearingContext(docPath: string): boolean {
  const lower = docPath.toLowerCase();
  return LOAD_BEARING_CONTEXT_SUBSTRINGS.some((s) => lower.includes(s.toLowerCase()));
}

/**
 * Return a deterministic priority rank for a context doc path: a small index
 * for a constitutional/lessons doc (earlier substring = smaller rank), or a
 * large sentinel for everything else (so non-priority docs keep their relative
 * order behind the priority ones under a stable sort).
 */
function contextPriorityRank(docPath: string): number {
  const lower = docPath.toLowerCase();
  for (let i = 0; i < CONTEXT_PRIORITY_SUBSTRINGS.length; i++) {
    if (lower.includes(CONTEXT_PRIORITY_SUBSTRINGS[i].toLowerCase())) return i;
  }
  return CONTEXT_PRIORITY_SUBSTRINGS.length;
}

/**
 * Order referenced context deterministically: constitutional/lessons docs
 * first (per CONTEXT_PRIORITY_SUBSTRINGS), then the caller's spec-declared link
 * order for the rest. A stable sort on the priority rank achieves both — equal
 * ranks keep their input order. Pure; never mutates the input.
 */
export function orderContextDeterministically(
  context: readonly ReferencedContextDoc[],
): ReferencedContextDoc[] {
  return context
    .map((doc, idx) => ({ doc, idx, rank: contextPriorityRank(doc.path) }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map((e) => e.doc);
}

/** The canonical model tier a heavyweight cross-model review requests. */
const REVIEW_MODEL_TIER = 'capable' as const;

// ── Detection ───────────────────────────────────────────────────────────

/**
 * Reasons a supported reviewer framework is unavailable. Mirrors the
 * Rule-1 / auth-probe vocabulary so a report can render a specific
 * remediation.
 */
export type CrossModelUnavailableReason =
  | 'codex-not-installed'
  | 'codex-not-authed'
  | 'codex-auth-apikey-forbidden'
  | 'gemini-not-installed'
  | 'gemini-not-authed'
  | 'grok-not-installed'
  | 'grok-not-authed'
  | 'grok-auth-apikey-forbidden'
  | 'grok-login-policy-unverified'
  | 'grok-not-enabled'
  // Claude clean-door reviewer (REVIEWER-DOOR-REWIRING §1.2) — detection reasons
  // are PURELY STATIC/presence-based; auth/entitlement failures are invocation-time
  // `degraded` results (§1.4), never detection reasons.
  | 'claude-not-installed'
  | 'claude-config-missing'
  | 'claude-forbidden'
  | 'no-supported-framework';

export interface CrossModelDetectionResult {
  available: boolean;
  /**
   * The binary path detection actually resolved (round-12 adversarial). Carried
   * so the REVIEW spawns exactly what DETECTION approved — the reviewer used to
   * re-resolve independently via `configFromEnv()`, which skipped §2.1 rung 2
   * and could spawn a different binary than every other lane.
   */
  binaryPath?: string;
  /** Present when available; the framework id that will run the review. */
  framework?: IntelligenceFramework;
  /** Present when available; the concrete model the review resolves to. */
  model?: string;
  /** Present when unavailable; a specific machine-readable reason. */
  reason?: CrossModelUnavailableReason;
  /**
   * Is this a CROSS-MODEL (non-Claude) reviewer family (REVIEWER-DOOR-REWIRING §5)?
   * Populated at construction from the framework registry — so the guards that
   * decide "did this spec get a cross-model opinion?" filter on data they HOLD,
   * not a re-lookup against a list this spec adds claude to. Claude-reviewing-
   * Claude is a clean-door second read, NOT cross-model (`false`). Fail-CLOSED:
   * an absent value is treated as NOT cross-family by every consumer.
   */
  crossFamily?: boolean;
}

/**
 * Injectable inputs for `detectCrossModelReviewer` so the detection logic is
 * unit-testable without real spawns or a real `~/.codex/auth.json`.
 */
export interface CrossModelDetectInputs {
  /**
   * Path to the codex binary if detected, else null. Defaults to
   * `detectCodexPath()` (PATH + asdf/nvm-shim resolution).
   */
  codexPathDetected?: string | null;
  /**
   * Path to the codex auth.json. Defaults to
   * `${CODEX_HOME || ~/.codex}/auth.json`.
   */
  authJsonPath?: string;
  /** Process env (for the Rule-1 OPENAI_API_KEY probe). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Clock injection for the Rule-1 killswitch sunset check. */
  now?: Date;
  /**
   * Path to the gemini binary if detected, else null. Defaults to
   * `detectGeminiPath()` (PATH + known-location resolution).
   */
  geminiPathDetected?: string | null;
  /**
   * Path to the gemini CLI's cached OAuth credentials. Defaults to
   * `${GEMINI_HOME || ~/.gemini}/oauth_creds.json`.
   */
  geminiOauthCredsPath?: string;
  /**
   * Path to the grok binary if detected, else null. Defaults to
   * `detectGrokPath()` (grok-build framework integration spec §8).
   */
  grokPathDetected?: string | null;
  /**
   * `sessions.frameworkBinaryPaths['grok-build']` — §2.1 rung 2 (round-12
   * adversarial). Boot registration and the session fence both honoured the
   * persisted lever while the ONE LIVE lane did not, so a configured relocated
   * install detected + spawned a different binary here than everywhere else:
   * §2.1's split-roots failure arriving through the reviewer.
   */
  grokConfiguredPath?: string | undefined;
  /**
   * Path to the grok auth.json. Defaults to `${GROK_HOME || ~/.grok}/auth.json`.
   */
  grokAuthPath?: string;
  /**
   * Path to the claude binary if detected, else null. Defaults to
   * `detectClaudePath()` (REVIEWER-DOOR-REWIRING §1.2).
   */
  claudePathDetected?: string | null;
  /**
   * Whether a Claude config-home (`$CLAUDE_CONFIG_DIR` or `~/.claude`) is present.
   * Defaults to a real `existsSync` probe of that directory. Tests inject.
   */
  claudeConfigHomePresent?: boolean;
  /**
   * The agent's `enabledFrameworks`. When provided and it does NOT contain
   * `claude-code`, the claude reviewer detects `claude-forbidden` (a claude-
   * forbidden agent must never detect the family available — §1.2). Absent ⇒
   * treated as allowed (the dominant claude-agent case).
   */
  enabledFrameworks?: string[];
}

/** Resolve the default codex auth.json path (CODEX_HOME-aware). */
function defaultAuthJsonPath(env: NodeJS.ProcessEnv): string {
  const home = env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

/**
 * Is the codex auth.json an OAuth (`tokens.access_token`) shape? This is the
 * subscription-OAuth shape D3 requires. A missing / unreadable / malformed
 * file → false (not authed). Uses the same probe shape as the codex smoketest.
 */
function authHasOAuthAccessToken(authJsonPath: string): boolean {
  try {
    const raw = fs.readFileSync(authJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } };
    return typeof parsed?.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0;
  } catch {
    // missing / unreadable / malformed → not authed.
    return false;
  }
}

/**
 * Detect a codex reviewer. Returns `{ available: true, framework, model }`
 * iff ALL of: codex binary detected, OAuth `access_token` present, Rule-1
 * clean (no raw API key in env or auth.json). Any miss → a specific reason.
 *
 * Pure-ish: all external inputs are injectable. With no inputs it probes the
 * real host. It NEVER throws.
 */
export function detectCodexReviewer(
  inputs: CrossModelDetectInputs = {},
): CrossModelDetectionResult {
  const env = inputs.env ?? process.env;
  const now = inputs.now ?? new Date();
  const codexPath = inputs.codexPathDetected !== undefined ? inputs.codexPathDetected : detectCodexPath();
  const authJsonPath = inputs.authJsonPath ?? defaultAuthJsonPath(env);

  // 1. Binary present?
  if (!codexPath) {
    return { available: false, reason: 'codex-not-installed' };
  }

  // 2. Rule-1 clean? (API-key forbidden — env OPENAI_API_KEY or auth.json
  //    API-key shape). Reuses existing policy rather than inventing one.
  const rule1 = validateRule1(env, authJsonPath, now);
  if (!rule1.ok) {
    // The killswitch-expired / apikey-detected codes all collapse to the same
    // policy outcome here: a forbidden credential shape → reviewer unavailable.
    return { available: false, reason: 'codex-auth-apikey-forbidden' };
  }

  // 3. Authed via subscription OAuth?
  if (!authHasOAuthAccessToken(authJsonPath)) {
    return { available: false, reason: 'codex-not-authed' };
  }

  return {
    available: true,
    framework: 'codex-cli',
    model: resolveCliModelFlag(REVIEW_MODEL_TIER),
    crossFamily: true,
  };
}

/**
 * Resolve the default gemini oauth_creds.json path. DELIBERATELY no env-var
 * override: the gemini CLI (verified v0.25.2) resolves creds at
 * `~/.gemini/oauth_creds.json` UNCONDITIONALLY — there is no GEMINI_HOME.
 * Honoring one here would make detection probe a path the CLI never reads
 * (false-unavailable on an authed host -> the gemini pass silently skipped AND
 * a false `gemini-cli:false` recorded into the activation baseline — the exact
 * suppression Piece 3 exists to prevent). Tests inject `geminiOauthCredsPath`.
 */
function defaultGeminiOauthCredsPath(): string {
  return path.join(os.homedir(), '.gemini', 'oauth_creds.json');
}

/**
 * Is the gemini CLI's cached OAuth credentials file an authed shape? Authed
 * iff the file parses as JSON with a non-empty string `access_token` OR
 * `refresh_token` (the CLI refreshes an expired access token from the refresh
 * token, so either is a usable seat). A missing / unreadable / malformed file
 * → false (not authed). Never throws.
 */
function geminiOauthCredsAuthed(credsPath: string): boolean {
  try {
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { access_token?: unknown; refresh_token?: unknown };
    const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
    return nonEmptyString(parsed?.access_token) || nonEmptyString(parsed?.refresh_token);
  } catch {
    // @silent-fallback-ok — deny-safe: missing/unreadable/malformed creds mean
    // "not authed" (the reviewer is reported unavailable with a named reason);
    // mirrors the codex auth probe above.
    return false;
  }
}

/**
 * Detect a gemini reviewer (Piece 3 — the second family in the registry).
 * Returns `{ available: true, framework, model }` iff BOTH of: gemini binary
 * detected, cached OAuth credentials present (`access_token` or
 * `refresh_token`). Any miss → a specific reason.
 *
 * Pure-ish: all external inputs are injectable (mirrors
 * `detectCodexReviewer`). With no inputs it probes the real host. It NEVER
 * throws.
 */
export function detectGeminiReviewer(
  inputs: CrossModelDetectInputs = {},
): CrossModelDetectionResult {
  const env = inputs.env ?? process.env;
  const geminiPath =
    inputs.geminiPathDetected !== undefined ? inputs.geminiPathDetected : detectGeminiPath();
  const credsPath = inputs.geminiOauthCredsPath ?? defaultGeminiOauthCredsPath();

  // 1. Binary present?
  if (!geminiPath) {
    return { available: false, reason: 'gemini-not-installed' };
  }

  // 2. Authed via the CLI's cached OAuth?
  if (!geminiOauthCredsAuthed(credsPath)) {
    return { available: false, reason: 'gemini-not-authed' };
  }

  return {
    available: true,
    framework: 'gemini-cli',
    model: resolveGeminiModelFlag(REVIEW_MODEL_TIER),
    crossFamily: true,
  };
}

/**
 * Detect a grok reviewer (the THIRD cross-model family — grok-build spec §8).
 * Returns `{ available: true, framework, model }` iff ALL of: grok binary
 * detected, a USABLE subscription session in `$GROK_HOME/auth.json`, and
 * no metered key (XAI_API_KEY / GROK_DEPLOYMENT_KEY) in the env — the same
 * no-API-key rule the codex reviewer door enforces (Rule 1), applied to xAI.
 * "auth.json exists" is deliberately NOT the auth check — an unusable session
 * invites the CLI's own key-fallback ambiguity (review-1 finding 3), so the
 * expiry is parsed.
 *
 * ROUND-22 — "usable", not "non-expired", and the difference is load-bearing.
 * This previously required a NON-EXPIRED session and answered `grok-not-authed`
 * on any stale one. The CLI renews itself lazily from a stored refresh token, on
 * the next command that needs auth — so refusing here prevented the only call
 * that would have renewed it, and the reviewer went dark after any idle gap
 * until a human ran grok by hand. A lapsed session carrying a renewal credential
 * is now admitted (the call renews it); one with nothing to renew from still
 * detects `grok-not-authed`. The billing controls are untouched and independent:
 * the metered-key refusal above and the login-policy check below both still run
 * on every probe.
 *
 * Pure-ish: all external inputs are injectable. It NEVER throws.
 */
export function detectGrokReviewer(
  inputs: CrossModelDetectInputs = {},
): CrossModelDetectionResult {
  const env = inputs.env ?? process.env;
  // Round-11 (adversarial): this inlined a PARTIAL ladder too — an injected
  // value or bare detection — so an operator's `GROK_BUILD_PATH` (§2.1 rung 1)
  // could not open the reviewer door even with a working binary. The injected
  // value stays authoritative for tests; otherwise use the ONE resolver.
  const grokPath =
    inputs.grokPathDetected !== undefined
      ? inputs.grokPathDetected
      : resolveGrokBinaryPath({ env, configuredPath: inputs.grokConfiguredPath });
  const authPath = inputs.grokAuthPath ?? grokAuthPathFor(resolveGrokHome(env));
  const now = inputs.now ?? new Date();

  // 0. DARK-SHIP GATE (codex round-6): the grok reviewer requires the
  // EXPLICIT enabledFrameworks opt-in — UNLIKE codex/gemini, whose doors
  // open on installed+authed alone. The justified difference: those bill
  // separately per account, while grok draws an INVISIBLE pool SHARED
  // across every machine on the account — so an installed-but-not-opted-in
  // machine (e.g. machine 2 before the burn-rollup precondition) must not
  // silently consume reviewer budget. Absent list ⇒ NOT enabled (the dark
  // default; deliberately the inverse of the claude door's absent⇒allowed).
  if (!inputs.enabledFrameworks?.includes('grok-build')) {
    return { available: false, reason: 'grok-not-enabled' };
  }

  // 1. Binary present?
  // Round-17 (security): same dead gate as bootRegistration — the resolver is
  // total, so this could never fire and a missing CLI presented as an
  // available reviewer. Explicit `false` only.
  if (!grokPath || frameworkBinaryExists(grokPath) === false) {
    return { available: false, reason: 'grok-not-installed' };
  }

  // 2. No metered key in the environment (the no-API-key door rule).
  for (const name of GROK_FORBIDDEN_ENV_VARS) {
    if (env[name] !== undefined && env[name] !== '') {
      return { available: false, reason: 'grok-auth-apikey-forbidden' };
    }
  }

  // Version-drift canary (warn-only; async, cached per process; runs with
  // a minimal clean env AFTER the metered-key refusal — security round-7).
  checkGrokVersionDrift(grokPath);

  // 3. A live subscription session — or a lapsed one that can renew itself?
  //
  // ROUND-22, SECOND BOUNDARY. The deadlock fix landed first in
  // `assertGrokAuthAllowed` (the transport preflight) and would have been
  // reported as done while this gate, which runs EARLIER, still closed the
  // reviewer door on a bare expiry. Detection refuses → the transport is never
  // reached → the CLI is never invoked → the session never renews. Fixing the
  // later boundary alone leaves the outage exactly where it was, and the lane
  // this whole feature exists for is the one that stays dark.
  //
  // Found by checking the SEVERITY claim ("the grok reviewer goes dark") against
  // the code rather than assuming the one fix covered it. This is the round-20
  // shape verbatim — a fact carried correctly across one boundary and dropped at
  // the next — which is the argument for verifying a fix's reach, not just its
  // correctness.
  //
  // Same narrowing, same reasoning as the transport gate: a lapsed session
  // holding a renewal credential is ADMITTED (the reviewer call renews it), a
  // lapsed session with nothing to renew from is refused as before. The billing
  // controls are unchanged and independent — the metered-key refusal above and
  // the login-policy check below both still run on every probe.
  const { expiry, refreshable } = readSessionAuthState(authPath);
  if (expiry === null || (expiry.getTime() <= now.getTime() && !refreshable)) {
    return { available: false, reason: 'grok-not-authed' };
  }

  // 4. The vendor login policy (disable_api_key_auth) verifiably in force —
  // checked on EVERY availability probe, never a remembered one-time
  // verification (lessons review: the policy lives in vendor-owned mutable
  // state; a CLI update or config rewrite can silently reset it). This is
  // the PRIMARY billing control (spec §3.1.1); without it the reviewer door
  // must not open.
  const grokHome = inputs.grokAuthPath
    ? path.dirname(inputs.grokAuthPath)
    : resolveGrokHome(env);
  if (!isLoginPolicyVerified(grokHome, env)) {
    return { available: false, reason: 'grok-login-policy-unverified' };
  }

  return {
    available: true,
    binaryPath: grokPath,
    framework: 'grok-build',
    model: GROK_REVIEWER_MODEL,
    crossFamily: true,
  };
}

/**
 * Per-day grok reviewer-family budget (codex round-3 finding 4: the
 * reviewer is the FIRST production use, so the ceiling ships WITH it, not
 * as a deferred precondition). Durable at $HOME/.instar/grok-reviewer-budget.json
 * (machine-stable — see grokBudgetPath; the $GROK_HOME path is legacy, read once for migration)
 * — a simple {date, runs, totalTokens} counter; when either ceiling is hit,
 * further grok reviews DEGRADE for the rest of the UTC day (a degraded
 * family is loud in the convergence report; the pool stays protected).
 * Failure directions (round-6/7): MISSING ⇒ fresh day; CORRUPT ⇒
 * quarantine aside + DURABLY-persisted half-cap-precharged fresh day
 * (bounded self-heal — never a permanent brick, never a free full reset);
 * quarantine-failure ⇒ fail CLOSED for the day; ceiling breach ⇒ degrade.
 */
export const GROK_REVIEWER_DAILY_MAX_RUNS = 24;
export const GROK_REVIEWER_DAILY_MAX_TOKENS = 5_000_000;

interface GrokReviewerBudget {
  date: string;
  runs: number;
  totalTokens: number;
  /** Durable per-run trail (security/lessons round-5: the drift signal
   *  needs a durable consumer TODAY, not only at ledger-wiring time):
   *  the last runs' usage + anomaly notes, capped. */
  recentRuns?: Array<{
    at: string;
    inputTokens: number;
    outputTokens: number;
    anomalies: string[] | null;
  }>;
  /**
   * In-flight admissions (round-17 scalability). A reservation is a PENDING
   * claim on the daily ceiling, taken under the lock at admission and settled
   * into `runs` when the run records. Admission compares
   * `runs + live reservations` against the ceiling, which is what makes the
   * ceiling hold under concurrency — before this, N parallel reviewers all
   * read the same pre-run count and all admitted.
   *
   * Each carries an expiry so a crashed holder cannot leak its claim forever.
   * The TTL is generous on purpose: sweeping too early over-admits, which is
   * the failure this exists to prevent.
   */
  reservations?: Array<{ id: string; expiresAtMs: number }>;
}

/**
 * The daily reviewer ledger's location — MACHINE-STABLE, deliberately NOT under
 * `$GROK_HOME` (round-9 security).
 *
 * The spec's Multi-machine posture states the 24-run / 5M-token ceiling is
 * per-MACHINE. Keying the ledger to `resolveGrokHome(env)` made it per-GROK_HOME
 * instead, and Frontloaded Decision 9 explicitly blesses relocating that home —
 * so N homes on one machine meant N full budgets against the ONE invisible pool
 * the ceiling exists to protect. Anchoring to the OS user's instar root restores
 * the stated invariant, and incidentally removes the separately-accepted
 * "vendor home reset ⇒ ledger resets" residual, since a `grok logout`/reinstall
 * no longer takes the ledger with it.
 *
 * Per-OS-user rather than per-agent ON PURPOSE: every agent on this machine
 * draws on the same subscription pool, so they must share one ceiling.
 */
function grokBudgetPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HOME'] ?? os.homedir();
  return path.join(home, '.instar', 'grok-reviewer-budget.json');
}

/** The pre-round-9 location, read ONCE for migration (never written). */
function legacyGrokBudgetPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveGrokHome(env), 'instar-grok-reviewer-budget.json');
}

/** Sentinel returned when the ledger EXISTS but cannot be trusted —
 *  distinct from absent (decision-completeness round-6: missing-vs-corrupt
 *  are different cases with different fail directions). */
const CORRUPT_BUDGET: unique symbol = Symbol('corrupt-grok-budget');

function readGrokBudget(now: Date): GrokReviewerBudget | typeof CORRUPT_BUDGET {
  const today = now.toISOString().slice(0, 10);
  const p = grokBudgetPath();
  if (!fs.existsSync(p)) {
    // One-way migration off the pre-round-9 `$GROK_HOME` location: adopt
    // TODAY's legacy spend rather than handing out a free fresh ceiling on the
    // upgrade. Read-only — the legacy file is never written again, and a
    // stale-dated or unreadable one is simply ignored (fresh day).
    const legacy = legacyGrokBudgetPath();
    if (legacy !== p && fs.existsSync(legacy)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) as GrokReviewerBudget;
        if (
          parsed.date === today
          && Number.isFinite(parsed.runs)
          && Number.isFinite(parsed.totalTokens)
        ) {
          return {
            date: today,
            runs: Math.max(0, parsed.runs),
            totalTokens: Math.max(0, parsed.totalTokens),
          };
        }
      } catch {
        // @silent-fallback-ok — the LEGACY ledger is a one-way migration
        // SOURCE, read only while the machine-stable path is absent. An
        // unreadable one is treated exactly as an absent one (fresh day), which
        // is the same decided failure direction §8 states for the primary
        // ledger; the primary path's own corrupt/unwritable branches are the
        // ones that warn, and they still do.
      }
    }
    // MISSING ⇒ fresh day (blast radius bounded to one day's ceiling).
    return { date: today, runs: 0, totalTokens: 0 };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as GrokReviewerBudget;
    if (typeof parsed.date === 'string' && Number.isFinite(parsed.runs) && Number.isFinite(parsed.totalTokens)) {
      // Negative values must not disarm the cap (tampered/corrupt file).
      parsed.runs = Math.max(0, parsed.runs);
      parsed.totalTokens = Math.max(0, parsed.totalTokens);
      // Shape-validate recentRuns (a corrupt non-array value must not throw
      // inside the post-review record path — security round-6).
      if (!Array.isArray(parsed.recentRuns)) delete parsed.recentRuns;
      if (parsed.date === today) return parsed;
      return { date: today, runs: 0, totalTokens: 0 }; // day rollover
    }
  } catch {
    /* fall through to CORRUPT */
  }
  // PRESENT-but-unreadable/malformed ⇒ bounded SELF-HEAL, never a permanent
  // brick (lessons round-6 / P22): quarantine the corrupt file aside
  // (timestamped sibling — auditable, never silently destroyed) and start a
  // CONSERVATIVE fresh day with half the run cap pre-charged, so a crash-
  // corrupted ledger costs at most half a day's headroom instead of
  // degrading the family forever until a human deletes a file.
  try {
    const quarantine = `${p}.corrupt-${Date.now()}`;
    fs.renameSync(p, quarantine);
    const precharged: GrokReviewerBudget = {
      date: today,
      runs: Math.floor(GROK_REVIEWER_DAILY_MAX_RUNS / 2),
      totalTokens: Math.floor(GROK_REVIEWER_DAILY_MAX_TOKENS / 2),
    };
    // PERSIST the pre-charge (scalability round-7: an ephemeral in-memory
    // charge held for exactly one admission — the next reader would see
    // MISSING ⇒ zero-charged. Durable write also removes the concurrent-
    // reader divergence: the rename-race loser now parses a valid ledger).
    try {
      const tmp = `${p}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(precharged), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch {
      /* best-effort: the in-memory pre-charge still governs this admission */
    }
    console.warn(
      `[grok-reviewer-budget] ledger was corrupt — quarantined to ${quarantine}; ` +
        `conservative fresh day persisted (half the caps pre-charged)`,
    );
    return precharged;
  } catch {
    // Quarantine itself failed (permissions?) — NOW fail closed for the
    // day; a family we can neither budget nor heal must not run unbudgeted.
    return CORRUPT_BUDGET;
  }
}

/**
 * Exclusive advisory lock around the ledger's read-modify-write (round-12
 * external). The bounded last-writer-wins loss was accepted for three rounds
 * on the reasoning that a 24-run/day dark lane cannot lose much — but the
 * reviewer's operational framing is the right one: the risk is that someone
 * later parallelizes convergence and silently weakens the only live spend
 * brake, with nothing to notice. A lockfile removes the class instead of
 * bounding it.
 *
 * Deliberately SMALL: `wx` create (atomic), a stale-holder reclaim so a crashed
 * writer cannot wedge the brake forever, a short bounded wait, and — on failure
 * to acquire — proceed anyway. A lock that could BLOCK recording would trade a
 * bounded undercount for a possible total loss, which is the wrong direction
 * for a spend brake.
 */
function withGrokBudgetLock<T>(fn: (lockHeld: boolean) => T): T {
  if (process.env['GROK_LOCK_SENSITIVITY_PROBE'] === '1') return fn(false);
  const lockPath = `${grokBudgetPath()}.lock`;
  const STALE_MS = 30_000;
  const deadline = Date.now() + 2_000;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      held = true;
      break;
    } catch {
      // Held by someone else — reclaim it if the holder is provably stale.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          SafeFsExecutor.safeRmSync(lockPath, {
            force: true,
            operation: 'crossModelReviewer.withGrokBudgetLock.stale-reclaim',
          });
          continue;
        }
      } catch {
        // @silent-fallback-ok — the lock vanished between the failed create and
        // this stat, i.e. the holder just released. Loop and retry.
      }
      // Busy-wait briefly; this path is a per-review write, never hot.
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    // ROUND-19: `fn` now RECEIVES whether the lock was actually acquired.
    //
    // Round-18 tried to make admission fail closed with a `lockHeld` flag the
    // callback set as its first statement — but this `try` runs `fn()`
    // UNCONDITIONALLY, so that flag was always true and the refusal branch was
    // dead code. The fix was written from a correct measurement and never
    // re-measured against itself; three independent reviewers reproduced the
    // original over-admission on the "fixed" version (12 concurrent admissions
    // with a foreign lock held: 12 admitted, only 8 reservations persisted —
    // 4 slots lost).
    //
    // A flag set INSIDE the callback can never observe whether the callback
    // should have run. The acquisition fact has to cross the boundary.
    return fn(held);
  } finally {
    if (held) {
      try {
        SafeFsExecutor.safeRmSync(lockPath, {
          force: true,
          operation: 'crossModelReviewer.withGrokBudgetLock.release',
        });
      } catch {
        // @silent-fallback-ok — a leftover lockfile is reclaimed as stale by
        // the next writer; failing to unlink must never mask the write result.
      }
    }
  }
}

/**
 * Test-only seam for the budget ledger's record path (round-12): the
 * concurrency + stale-lock behaviour must be exercised directly, not only
 * through a full review run.
 */
/**
 * Test seam for the round-17 admission reservation.
 *
 * Exposed because the defect it pins — over-admission under concurrency — is
 * only observable across REAL concurrent processes; an in-process loop runs
 * sequentially and would pass against the broken code.
 */
export function reserveGrokBudgetSlotForTest(): 'ok' | 'corrupt' | 'exhausted' | 'lock-unavailable' {
  return reserveGrokBudgetSlot(new Date()).verdict;
}

/** Test seam for the round-18 release path (see releaseGrokReservation). */
export function reserveAndReleaseGrokSlotForTest(): 'released' | 'not-reserved' {
  const r = reserveGrokBudgetSlot(new Date());
  if (r.verdict !== 'ok') return 'not-reserved';
  releaseGrokReservation(r.id);
  return 'released';
}

export function recordGrokBudgetForTest(
  inputTokens: number,
  outputTokens: number,
  anomalies: string[] | null,
): void {
  recordGrokBudget(
    { date: new Date().toISOString().slice(0, 10), runs: 0, totalTokens: 0 },
    inputTokens,
    outputTokens,
    anomalies,
  );
}

/**
 * Admit a run and RESERVE its slot atomically — round-17 (scalability).
 *
 * The round-12 lock was justified as protection against "someone later
 * parallelizes convergence and silently weakens the only live spend brake",
 * but it only ever guarded the WRITE. Admission stayed an unlocked
 * check-then-act with no reservation, so N parallel reviewers all read
 * `runs = 0`, all passed the ceiling, and all spent. The lock serialised
 * COUNTING while leaving OVER-ADMISSION wide open: the counters were correct
 * after the fact and the ceiling was not enforced.
 *
 * Reserve-then-settle closes it. Admission takes the lock, re-reads, checks
 * the ceiling, and writes `runs + 1` before releasing — so a concurrent
 * admission sees the reservation. `recordGrokBudget` then SETTLES the true
 * token count against that reservation rather than incrementing again.
 *
 * A crashed holder would otherwise leak its reservation forever, so each
 * carries an expiry: reservations older than the TTL are swept on the next
 * admission. The TTL is deliberately generous — a swept-too-early reservation
 * over-admits, which is the failure this exists to prevent.
 *
 * Returns null when admitted (with the reservation held), or the refusal
 * reason. Fails toward REFUSAL on a corrupt ledger, matching §8's stated
 * direction for a spend-bearing family against an invisible pool.
 */
const GROK_RESERVATION_TTL_MS = 15 * 60 * 1000;

let reservationCounter = 0;

/**
 * Release a reservation WITHOUT settling it into `runs` — round-18.
 *
 * Round-17 wrote a reservation at admission and settled it in
 * `recordGrokBudget`. Every exit BETWEEN those two points leaked the slot for
 * the full TTL, and the worst of them is deliberate: the capacity-shed branch
 * skips recording precisely so transient HOST load cannot exhaust the grok
 * family's day — while the reservation it had already written did exactly that.
 * Measured by executing the path (its first execution ever): 24 sheds with zero
 * settles closed the ceiling at `runs: 0`.
 */
function releaseGrokReservation(id: string): void {
  try {
    withGrokBudgetLock(() => {
      const fresh = readGrokBudget(new Date());
      if (fresh === CORRUPT_BUDGET) return;
      writeGrokBudgetUnlocked({
        ...fresh,
        reservations: (fresh.reservations ?? []).filter((r) => r.id !== id),
      });
    });
  } catch (err) {
    // NOT silent, and the ratchet is right to have pushed back on the first
    // draft, which swallowed this. A failed release leaks a ceiling slot until
    // the TTL sweeps it — that is precisely the condition whose accumulation
    // closed the family's day at `0 runs / 0 tokens`, so it is worth knowing
    // about. Still non-throwing: the caller is already on an error path and
    // must not be given a second failure to handle.
    console.warn(
      `[grok-reviewer] reservation ${id} could not be released (it will expire on TTL): `
        + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function reserveGrokBudgetSlot(
  now: Date,
): { verdict: 'ok'; id: string } | { verdict: 'corrupt' | 'exhausted' | 'lock-unavailable' } {
  // A holder rather than a bare `let`: the assignments happen inside the lock
  // CALLBACK, which TypeScript cannot prove runs, so a plain `let` narrows to
  // its initializer and the later comparison reads as dead code.
  const out: { verdict: 'corrupt' | 'exhausted' | 'lock-unavailable' | 'ok'; id: string } = {
    verdict: 'corrupt',
    id: '',
  };
  withGrokBudgetLock((lockHeld) => {
    // ROUND-19: admission fails CLOSED on an unacquired lock, and this now
    // actually fires — the round-18 version branched on a flag set inside this
    // callback, which the callback cannot use to learn whether it should have
    // run. Recording deliberately keeps the fail-OPEN variant (never lose a
    // paid run); only ADMISSION refuses, because over-admitting spends money
    // while refusing merely delays a review.
    if (!lockHeld) {
      out.verdict = 'lock-unavailable';
      return;
    }
    const fresh = readGrokBudget(now);
    if (fresh === CORRUPT_BUDGET) {
      out.verdict = 'corrupt';
      return;
    }
    const nowMs = now.getTime();
    const live = (Array.isArray(fresh.reservations) ? fresh.reservations : []).filter(
      (r) => Number.isFinite(r.expiresAtMs) && r.expiresAtMs > nowMs,
    );
    if (
      fresh.runs + live.length >= GROK_REVIEWER_DAILY_MAX_RUNS
      || fresh.totalTokens >= GROK_REVIEWER_DAILY_MAX_TOKENS
    ) {
      out.verdict = 'exhausted';
      // Persist the sweep even on refusal so expired reservations cannot
      // wedge the ceiling shut.
      writeGrokBudgetUnlocked({ ...fresh, reservations: live });
      return;
    }
    // Round-18: `${pid}-${ms}` collides for two reservations in the same
    // millisecond in one process, and the settle needs to drop ITS OWN row.
    out.id = `${process.pid}-${nowMs}-${reservationCounter++}`;
    writeGrokBudgetUnlocked({
      ...fresh,
      reservations: [...live, { id: out.id, expiresAtMs: nowMs + GROK_RESERVATION_TTL_MS }],
    });
    out.verdict = 'ok';
  });
  // Round-18: the lock fails OPEN, which is right for RECORDING (never lose a
  // paid run) and inverted for ADMISSION (never over-admit). Measured: with a
  // foreign lock held, admission waited the full 2s deadline and then wrote its
  // reservation anyway — the exact check-then-act the reservation exists to
  // remove, reappearing precisely when contention exists. Admission now fails
  // CLOSED: an unacquired lock refuses rather than admits.
  return out.verdict === 'ok' ? { verdict: 'ok', id: out.id } : { verdict: out.verdict };
}

/** Write the ledger. Caller MUST already hold the lock. */
function writeGrokBudgetUnlocked(budget: GrokReviewerBudget): void {
  const target = grokBudgetPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(budget), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function recordGrokBudget(
  _staleBudget: GrokReviewerBudget,
  inputTokens: number,
  outputTokens: number,
  anomalies: string[] | null,
  settleReservationId?: string,
): void {
  // CONCURRENCY-SAFE record (scalability/security round-6): RE-READ the
  // ledger at record time and merge THIS run into the FRESH state — the
  // pre-run read is minutes stale by now and last-writer-wins would
  // undercount the only spend brake this framework has. Write via
  // tmp+rename so a torn write can never yield an unparseable file (which
  // would fail the NEXT run closed). All mutation inside the best-effort
  // try: a broken ledger never discards a completed, paid-for review.
  try {
    withGrokBudgetLock(() => {
    const fresh = readGrokBudget(new Date());
    const base: GrokReviewerBudget =
      fresh === CORRUPT_BUDGET
        ? { date: new Date().toISOString().slice(0, 10), runs: 0, totalTokens: 0 }
        : fresh;
    const recent = Array.isArray(base.recentRuns) ? base.recentRuns : [];
    // Round-17: SETTLE against this run's reservation rather than
    // incrementing blind — the slot was already counted at admission, so a
    // second increment here would double-count every run.
    const nowMs = Date.now();
    const heldReservations = (Array.isArray(base.reservations) ? base.reservations : []).filter(
      (r) => Number.isFinite(r.expiresAtMs) && r.expiresAtMs > nowMs,
    );
    // Round-18: this was `slice(1)` — positional, so a settle dropped the FIRST
    // live reservation rather than its own. Correct only while nothing is
    // TTL-swept: once a run outlives the TTL its own row is gone, so its settle
    // drops a LIVE FOREIGN reservation while adding +1, silently granting one
    // extra admission per occurrence. Reachable because the reviewer timeout is
    // operator-set and unbounded above.
    const settled = settleReservationId
      ? heldReservations.filter((r) => r.id !== settleReservationId)
      : heldReservations.slice(1);
    const merged: GrokReviewerBudget = {
      date: base.date,
      // Always +1: a reservation is a PENDING claim, not a settled run, and
      // admission checks `runs + live reservations` against the ceiling. So
      // settling converts one pending claim into one settled run — never
      // double-counts, and never loses a completed paid-for run whose
      // reservation the TTL swept.
      runs: base.runs + 1,
      totalTokens: base.totalTokens + inputTokens + outputTokens,
      reservations: settled,
      recentRuns: [
        ...recent.slice(-19),
        { at: new Date().toISOString(), inputTokens, outputTokens, anomalies },
      ],
    };
    const target = grokBudgetPath();
    // The machine-stable root may not exist yet on a fresh install.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
    fs.renameSync(tmp, target);
    });
  } catch (e) {
    // @silent-fallback-ok — NOT silent: this branch warns loudly on stderr with
    // the failure reason and states that the run was not recorded. The write is
    // deliberately best-effort so an unwritable ledger never blocks a review;
    // the ratchet's detector keys on DegradationReporter, which is not wired
    // into this module's pure-function surface.
    // Best-effort: an unwritable ledger never blocks the review itself —
    // but it must not be SILENT either (a permanently-unwritable ledger
    // would otherwise degrade the family to unbudgeted forever, unseen).
    console.warn(
      `[grok-reviewer-budget] ledger write failed (${e instanceof Error ? e.message : String(e)}) — this run was NOT durably recorded`,
    );
  }
}

/** Exposed for tests: is the grok reviewer family within its daily budget?
 *  A corrupt ledger reads as NOT available (fail closed). */
export function grokReviewerBudgetAvailable(now: Date = new Date()): boolean {
  const b = readGrokBudget(now);
  if (b === CORRUPT_BUDGET) return false;
  return b.runs < GROK_REVIEWER_DAILY_MAX_RUNS && b.totalTokens < GROK_REVIEWER_DAILY_MAX_TOKENS;
}

/**
 * The concrete model the grok reviewer pins. PROBED (grok 1.0.4,
 * 2026-08-14): `-m grok-4.6` is accepted by the CLI and serves the SAME
 * model as the default — the envelope's modelUsage key is
 * `grok-4.6-build`, identical to every run in the §0.2 rate-card evidence
 * set and returning stopReason end_turn — so the billing/envelope evidence
 * covers exactly this invocation. A concrete id, never a tier word.
 */
export const GROK_REVIEWER_MODEL = 'grok-4.6';

// ── Claude clean-door reviewer (REVIEWER-DOOR-REWIRING §1) ───────────────

/**
 * The concrete default model the Anthropic clean-door reviewer pins
 * (REVIEWER-DOOR-REWIRING §1.3). NEVER the tier word `'capable'` — that resolves
 * to opus (`src/core/models.ts`), the measured-penalized `opus × coding-harness`
 * pair this reviewer family exists to move OFF. Registered in
 * `scripts/model-registry-freshness.manifest.json` under the strict (CI-gating)
 * freshness lint, so a rotted pin fails CI (the anti-rot ratchet); the
 * degraded-loud no-silent-fallback path (§1.3) is the second, runtime guarantee.
 */
export const CLAUDE_REVIEWER_DEFAULT_MODEL = 'claude-fable-5';

/**
 * The accept-set a config override (`specConverge.reviewers.anthropic.model`) is
 * validated against (§1.3). A concrete-but-non-frontier id — e.g.
 * `claude-opus-4-8` — is REJECTED (`override-not-frontier`), never silently
 * honored, because a misconfigured override could otherwise re-pin the reviewer
 * to opus and re-create the exact door-penalty gap this spec closes. Kept fresh
 * by the same freshness lint that pins `CLAUDE_REVIEWER_DEFAULT_MODEL`, so this
 * "derived-from-the-manifest frontier set" stays current structurally rather than
 * by willpower (Structure > Willpower).
 */
export const CLAUDE_REVIEWER_FRONTIER_MODELS: readonly string[] = [CLAUDE_REVIEWER_DEFAULT_MODEL];

/** The default Claude config-home path (`$CLAUDE_CONFIG_DIR` or `~/.claude`). */
function defaultClaudeConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

/**
 * Detect a Claude clean-door reviewer (REVIEWER-DOOR-REWIRING §1.2). Reports
 * "installed-and-configured" — NOT entitlement-verified: usable auth,
 * subscription tier, and Fable-5 entitlement are INVOCATION-time `degraded`
 * results (§1.4), never detection reasons. Detection reasons are the purely
 * static presence set only: `claude-not-installed` / `claude-config-missing` /
 * `claude-forbidden`. NEVER throws; all inputs injectable (mirrors codex/gemini).
 */
export function detectClaudeReviewer(
  inputs: CrossModelDetectInputs = {},
): CrossModelDetectionResult {
  // 1. claude-code allowed on this agent? (A claude-forbidden agent must never
  //    detect the family available — §1.2. Absent enabledFrameworks ⇒ allowed.)
  if (inputs.enabledFrameworks && !inputs.enabledFrameworks.includes('claude-code')) {
    return { available: false, reason: 'claude-forbidden', crossFamily: false };
  }

  // 2. Binary present?
  const claudePath =
    inputs.claudePathDetected !== undefined ? inputs.claudePathDetected : detectClaudePath();
  if (!claudePath) {
    return { available: false, reason: 'claude-not-installed', crossFamily: false };
  }

  // 3. Config-home present?
  const configHomePresent =
    inputs.claudeConfigHomePresent !== undefined
      ? inputs.claudeConfigHomePresent
      : fs.existsSync(defaultClaudeConfigHome());
  if (!configHomePresent) {
    return { available: false, reason: 'claude-config-missing', crossFamily: false };
  }

  return {
    available: true,
    framework: 'claude-code',
    // The default pin; the config-override validation happens at INVOCATION
    // (§1.4) so detection stays purely presence-based. crossFamily:false — Claude
    // reviewing Claude is a clean-door second read, NOT a cross-model opinion (§5).
    model: CLAUDE_REVIEWER_DEFAULT_MODEL,
    crossFamily: false,
  };
}

/** Outcome of resolving the Claude reviewer's concrete model (§1.3). */
export type ClaudeReviewerModelResolution =
  | { ok: true; model: string }
  | { ok: false; reason: 'override-not-concrete' | 'override-not-frontier'; model: string };

/**
 * Resolve the Claude reviewer's concrete model (§1.3), with NO silent fallback:
 *   1. a config override (`specConverge.reviewers.anthropic.model`) if set — it
 *      MUST be a concrete id (`isConcreteReviewerModel`) AND a member of the
 *      frontier accept-set (`CLAUDE_REVIEWER_FRONTIER_MODELS`); a non-frontier
 *      concrete id (e.g. `claude-opus-4-8`) is REJECTED (`override-not-frontier`);
 *   2. else the default pin `CLAUDE_REVIEWER_DEFAULT_MODEL` (`claude-fable-5`).
 * A rejected override degrades the round LOUDLY (§1.4) — it is never coerced to
 * a default, because a config typo silently re-opening the door penalty is
 * exactly the "strongest model isn't actually reviewing" gap this spec closes.
 */
export function resolveClaudeReviewerModel(
  config?: ReviewerConfig,
): ClaudeReviewerModelResolution {
  const override = config?.specConverge?.reviewers?.anthropic?.model;
  if (typeof override === 'string' && override.trim().length > 0) {
    const id = override.trim();
    if (!isConcreteReviewerModel(id)) {
      return { ok: false, reason: 'override-not-concrete', model: id };
    }
    if (!CLAUDE_REVIEWER_FRONTIER_MODELS.includes(id)) {
      return { ok: false, reason: 'override-not-frontier', model: id };
    }
    return { ok: true, model: id };
  }
  return { ok: true, model: CLAUDE_REVIEWER_DEFAULT_MODEL };
}

/**
 * Runtime hardening preflight (§1.4): does the INSTALLED Claude CLI actually
 * ACCEPT the required inbound-safety hardening flags (`--allowedTools ''`,
 * `--strict-mcp-config`)? A fleet machine may run a drifted CLI that renamed or
 * dropped a flag, so the reviewer verifies support on EACH machine at runtime
 * and is NEVER run unhardened. FAIL-CLOSED: an unresolvable binary, an exec
 * error, or a `--help` output missing either flag ⇒ `false` (degrade, never run
 * unsafe). Cached per process; `__resetClaudeHardeningPreflightCache()` for tests.
 */
let _claudeHardeningPreflightCache: boolean | null = null;
export function claudeSupportsReviewerHardening(claudePath?: string): boolean {
  if (_claudeHardeningPreflightCache !== null) return _claudeHardeningPreflightCache;
  let supported = false;
  try {
    const bin = claudePath ?? detectClaudePath();
    if (bin) {
      // lint-allow-sync-spawn: one-shot CLI capability probe (`claude --help`),
      // cached per-process (runs at most once), invoked only from the reviewer
      // path driven by the spec-converge SKILL script — a short-lived CLI process,
      // never the server event loop.
      const help = execFileSync(bin, ['--help'], {
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      supported = help.includes('--allowedTools') && help.includes('--strict-mcp-config');
    }
  } catch {
    // @silent-fallback-ok — fail-CLOSED: an inconclusive preflight is treated as
    // UNSUPPORTED so the reviewer degrades (`hardening-unsupported`) rather than
    // running the untrusted-text review without the security boundary.
    supported = false;
  }
  _claudeHardeningPreflightCache = supported;
  return supported;
}

/** Test helper — clear the per-process hardening-preflight cache. */
export function __resetClaudeHardeningPreflightCache(): void {
  _claudeHardeningPreflightCache = null;
}

// ── Supported-reviewer registry (the extension point) ───────────────────

export interface ReviewerResult {
  /** Outcome class for the cross-model pass. */
  status: 'ok' | 'degraded' | 'unavailable';
  /** The framework that ran (or would have run). */
  framework?: IntelligenceFramework;
  /** Concrete model used. */
  model?: string;
  /** Parsed verdict, when the review returned. */
  verdict?: ReviewVerdict;
  /** Structured findings (one record), folded alongside internal reviewers. */
  findings?: ReviewFinding[];
  /** A reason string for degraded/unavailable outcomes. */
  reason?: string;
  /** The flag string that gets written to frontmatter + the report banner. */
  flag: string;
  /**
   * Is this a CROSS-MODEL (non-Claude) reviewer result (REVIEWER-DOOR-REWIRING §5)?
   * Populated at construction from the framework registry. `aggregateRoundOutcomes`
   * counts ONLY `crossFamily: true` successes toward the spec-level
   * `cross-model-review` flag, so a claude-only success (`false`) can NEVER
   * launder a clean cross-model pass. Fail-CLOSED: absent ⇒ treated as NOT
   * cross-family by every consumer.
   */
  crossFamily?: boolean;
}

/**
 * The minimal agent-config shape the reviewer layer reads (REVIEWER-DOOR-REWIRING
 * §1.5): the developmentAgent gate flag + the `specConverge.reviewers` block. The
 * driver reads `.instar/config.json` and threads this in; production callers pass
 * it, tests inject it. Absent ⇒ the Anthropic clean-door family is DARK on the
 * fleet (byte-identical `[codex, gemini]`) and LIVE on a development agent.
 */
export interface ReviewerConfig {
  developmentAgent?: boolean;
  specConverge?: {
    reviewers?: {
      anthropic?: {
        /** Omitted ⇒ developmentAgent gate (live-on-dev / dark-fleet); explicit wins. */
        enabled?: boolean;
        /** Optional concrete frontier model override, validated in §1.3. */
        model?: string;
      };
      /**
       * Per-family reviewer call timeout (REVIEWER-DOOR-REWIRING §3.2 / D6). EITHER
       * a single number (milliseconds, applied to ALL families) OR a
       * `{ default, byFramework }` map for a per-family value. Absent ⇒ today's
       * 120s default for EVERY family (byte-identical fleet behavior). Each
       * resolved value is clamped to [30s, 900s]. This knob only adds the
       * PER-FAMILY budget; it does NOT itself raise any family's default (the
       * measure-first gemini 600s raise is inc3's dogfood decision). Resolved by
       * `resolveReviewerTimeoutMs`.
       */
      timeoutMs?:
        | number
        | {
            /** Default for any family not named in `byFramework`. */
            default?: number;
            /** Per-framework override (milliseconds). */
            byFramework?: Partial<Record<IntelligenceFramework, number>>;
          };
    };
  };
}

export type ReviewVerdict = 'CLEAN' | 'MINOR ISSUES' | 'SERIOUS ISSUES' | 'UNKNOWN';

export interface ReviewFinding {
  /** Reviewer tag, e.g. 'cross-model:codex-cli:gpt-5.5'. */
  reviewer: string;
  verdict: ReviewVerdict;
  /** The findings body (verbatim text the reviewer produced). */
  body: string;
  /** True when the reply could not be parsed into a verdict (captured raw). */
  unstructured?: boolean;
}

interface SupportedReviewerFramework {
  /** Extend this union (in the type below) to add a framework. */
  id: IntelligenceFramework;
  /**
   * Is this a CROSS-MODEL (non-Claude) reviewer family (REVIEWER-DOOR-REWIRING
   * §5.1)? A REQUIRED field with NO default: a future reviewer provider/door
   * CANNOT be added to the registry without an explicit cross-model
   * classification decision (a test asserts every entry sets it). codex/gemini
   * `true`; the claude clean-door family `false`.
   */
  crossFamily: boolean;
  /** Detection — does this framework's reviewer have what it needs to run? */
  detect(inputs?: CrossModelDetectInputs): CrossModelDetectionResult;
  /**
   * Run the review: assemble already done by the caller; this builds the
   * provider, evaluates the prompt, and parses the result. Returns a
   * ReviewerResult (never throws — failures map to a degraded result).
   */
  review(args: ReviewerInvokeArgs): Promise<ReviewerResult>;
}

export interface ReviewerInvokeArgs {
  /** The fully-assembled cross-model reviewer prompt (prompt + spec + context). */
  promptText: string;
  /** Per-call timeout. */
  timeoutMs: number;
  /**
   * Optional provider override — tests inject a stub so no real spawn happens.
   * Production passes nothing and the factory builds the real one. Typed with
   * the full IntelligenceOptions so a test can read the claude reviewer's
   * `reviewerHardening.model` (the concrete-pin assertion, §1.4).
   */
  providerOverride?: { evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> };
  /**
   * Optional detection override — `runCrossModelReview` passes the detection
   * it already computed (so review never re-probes the host), and tests inject
   * synthetic detections (e.g. a tier-word model to exercise the canary).
   * Absent → the entry runs its own real-host detect, as before (back-compat).
   */
  detectionOverride?: CrossModelDetectionResult;
  /**
   * Agent config for the claude clean-door family (REVIEWER-DOOR-REWIRING §1.3):
   * the model override is resolved + validated from this at invocation. Ignored
   * by codex/gemini. Absent ⇒ the default pin.
   */
  reviewerConfig?: ReviewerConfig;
  /**
   * Test override for the claude hardening preflight (§1.4). When set, skips the
   * real `claude --help` probe (`true` = supported, `false` = drives the
   * `hardening-unsupported` degrade). Production omits it → the real preflight.
   */
  hardeningSupportedOverride?: boolean;
  /**
   * Test-only claude provider FACTORY override. Production omits it → the entry
   * calls `buildIntelligenceProvider({ framework: 'claude-code' })`, whose
   * constructor THROWS on a claude-forbidden agent. Tests inject a factory that
   * throws (throw-safety → `degraded`) or returns null (`provider-unavailable`).
   * A `providerOverride` still short-circuits this (no construction at all).
   */
  claudeProviderFactory?: () => { evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> } | null;
}

/**
 * Fail-loud model canary (Piece 3). A cross-model review must run on a
 * CONCRETE model id — never a bare tier word that fell through a
 * tier→model resolution map (the `resolveModelForFramework` fall-through
 * failure class: the literal string 'capable' is not a model, and silently
 * passing it selects a dead reviewer). Returns false for undefined/empty
 * strings and for bare tier words (case-insensitive). Both registry entries
 * check this BEFORE invoking the provider and degrade LOUDLY
 * (`model-resolution-canary`) on a failure.
 */
export function isConcreteReviewerModel(model: string | undefined): boolean {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim();
  if (trimmed.length === 0) return false;
  const TIER_WORDS = new Set(['fast', 'balanced', 'capable', 'haiku', 'sonnet', 'opus']);
  return !TIER_WORDS.has(trimmed.toLowerCase());
}

/**
 * The codex reviewer entry. Detection delegates to `detectCodexReviewer`;
 * `review` routes through the factory-built `CodexCliIntelligenceProvider`.
 */
const codexReviewer: SupportedReviewerFramework = {
  id: 'codex-cli',
  crossFamily: true,
  detect: (inputs) => detectCodexReviewer(inputs),
  review: async (args) => {
    const detection = args.detectionOverride ?? detectCodexReviewer();
    const model = detection.model ?? resolveCliModelFlag(REVIEW_MODEL_TIER);
    const tag = `cross-model:codex-cli:${model}`;

    // Fail-loud model canary (Piece 3): NEVER silently review with a
    // tier-word model — a fall-through 'capable' is a dead reviewer.
    if (!isConcreteReviewerModel(model)) {
      return {
        status: 'degraded',
        framework: 'codex-cli',
        model,
        reason: 'model-resolution-canary',
        flag: `cross-model-review: codex-cli:${model} (degraded: model-resolution-canary)`,
        crossFamily: true,
      };
    }

    // Build (or accept an injected) provider. The factory wraps it in the
    // account-global circuit breaker, so a rate-limited review degrades the
    // same way every other instar LLM call does.
    const provider =
      args.providerOverride ??
      buildIntelligenceProvider({ framework: 'codex-cli' });

    if (!provider) {
      // Binary vanished between detect and review (or detection said
      // unavailable and review was called anyway). Degraded, not a throw.
      return {
        status: 'degraded',
        framework: 'codex-cli',
        model,
        reason: 'provider-unavailable',
        flag: `cross-model-review: codex-cli:${model} (degraded: provider-unavailable)`,
        crossFamily: true,
      };
    }

    let raw: string;
    try {
      raw = await provider.evaluate(args.promptText, {
        model: REVIEW_MODEL_TIER,
        timeoutMs: args.timeoutMs,
        attribution: { component: 'crossModelReviewer' }, // attribution for /metrics/features
      });
    } catch (err) {
      const reason = classifyReviewFailure(err);
      return {
        status: 'degraded',
        framework: 'codex-cli',
        model,
        reason,
        flag: `cross-model-review: codex-cli:${model} (degraded: ${reason})`,
        crossFamily: true,
      };
    }

    const parsed = parseReviewerReply(raw, tag);
    return {
      status: 'ok',
      framework: 'codex-cli',
      model,
      verdict: parsed.verdict,
      findings: [parsed],
      flag: `cross-model-review: codex-cli:${model}`,
      crossFamily: true,
    };
  },
};

/**
 * The gemini reviewer entry (Piece 3 — family diversity: a second non-Claude
 * model family alongside GPT). Detection delegates to `detectGeminiReviewer`;
 * `review` routes through the factory-built `GeminiCliIntelligenceProvider`
 * (same circuit-breaker wrapping, same degraded semantics as codex).
 */
const geminiReviewer: SupportedReviewerFramework = {
  id: 'gemini-cli',
  crossFamily: true,
  detect: (inputs) => detectGeminiReviewer(inputs),
  review: async (args) => {
    const detection = args.detectionOverride ?? detectGeminiReviewer();
    const model = detection.model ?? resolveGeminiModelFlag(REVIEW_MODEL_TIER);
    const tag = `cross-model:gemini-cli:${model}`;

    // Fail-loud model canary (Piece 3): NEVER silently review with a
    // tier-word model — a fall-through 'capable' is a dead reviewer.
    if (!isConcreteReviewerModel(model)) {
      return {
        status: 'degraded',
        framework: 'gemini-cli',
        model,
        reason: 'model-resolution-canary',
        flag: `cross-model-review: gemini-cli:${model} (degraded: model-resolution-canary)`,
        crossFamily: true,
      };
    }

    // Build (or accept an injected) provider. The factory wraps it in the
    // account-global circuit breaker, so a rate-limited review degrades the
    // same way every other instar LLM call does.
    const provider =
      args.providerOverride ??
      buildIntelligenceProvider({ framework: 'gemini-cli' });

    if (!provider) {
      // Binary vanished between detect and review (or detection said
      // unavailable and review was called anyway). Degraded, not a throw.
      return {
        status: 'degraded',
        framework: 'gemini-cli',
        model,
        reason: 'provider-unavailable',
        flag: `cross-model-review: gemini-cli:${model} (degraded: provider-unavailable)`,
        crossFamily: true,
      };
    }

    let raw: string;
    try {
      raw = await provider.evaluate(args.promptText, {
        model: REVIEW_MODEL_TIER,
        timeoutMs: args.timeoutMs,
        attribution: { component: 'crossModelReviewer' }, // attribution for /metrics/features
      });
    } catch (err) {
      const reason = classifyReviewFailure(err);
      return {
        status: 'degraded',
        framework: 'gemini-cli',
        model,
        reason,
        flag: `cross-model-review: gemini-cli:${model} (degraded: ${reason})`,
        crossFamily: true,
      };
    }

    const parsed = parseReviewerReply(raw, tag);
    return {
      status: 'ok',
      framework: 'gemini-cli',
      model,
      verdict: parsed.verdict,
      findings: [parsed],
      flag: `cross-model-review: gemini-cli:${model}`,
      crossFamily: true,
    };
  },
};

/**
 * The Claude clean-door reviewer entry (REVIEWER-DOOR-REWIRING §1). The headline
 * change: the strongest available Anthropic model (`claude-fable-5`) reads the
 * spec through the clean `claude -p` door instead of never reading it at all.
 *
 * This is a SECOND READ, not a cross-model opinion — `crossFamily: false` (§5).
 * The call is hardened to codex-door parity for the untrusted-text review (§1.4):
 * `reviewerHardening` makes `ClaudeCliIntelligenceProvider` run with empty
 * allowed-tools + `--strict-mcp-config` + a neutral scratch cwd + the prompt via
 * stdin + an env allowlist that strips agent secrets. The model argument is the
 * CONCRETE resolved pin (never the tier word `'capable'`, which resolves to opus).
 */
const claudeReviewer: SupportedReviewerFramework = {
  id: 'claude-code',
  crossFamily: false,
  detect: (inputs) => detectClaudeReviewer(inputs),
  review: async (args) => {
    // Model resolution + override validation (§1.3) — no silent fallback.
    const resolution = resolveClaudeReviewerModel(args.reviewerConfig);
    if (!resolution.ok) {
      return {
        status: 'degraded',
        framework: 'claude-code',
        model: resolution.model,
        reason: resolution.reason,
        flag: `clean-door-anthropic-review: claude-code:${resolution.model} (degraded: ${resolution.reason})`,
        crossFamily: false,
      };
    }
    const model = resolution.model;
    const tag = `clean-door:claude-code:${model}`;

    // Fail-loud model canary (§1.4): NEVER review on a tier word — passing
    // 'capable' here would silently resolve to opus, the penalized pair.
    if (!isConcreteReviewerModel(model)) {
      return {
        status: 'degraded',
        framework: 'claude-code',
        model,
        reason: 'model-resolution-canary',
        flag: `clean-door-anthropic-review: claude-code:${model} (degraded: model-resolution-canary)`,
        crossFamily: false,
      };
    }

    // Runtime hardening preflight (§1.4) — fail-CLOSED on THIS machine's CLI, not
    // just CI. If the installed CLI does not accept the hardening flags, the
    // reviewer is NEVER run unhardened.
    const hardeningSupported =
      args.hardeningSupportedOverride !== undefined
        ? args.hardeningSupportedOverride
        : claudeSupportsReviewerHardening();
    if (!hardeningSupported) {
      return {
        status: 'degraded',
        framework: 'claude-code',
        model,
        reason: 'hardening-unsupported',
        flag: `clean-door-anthropic-review: claude-code:${model} (degraded: hardening-unsupported)`,
        crossFamily: false,
      };
    }

    // Build (or accept an injected) provider. Unlike codex/gemini,
    // ClaudeCliIntelligenceProvider's constructor THROWS on a claude-forbidden
    // agent — wrap construction so a throw maps to `degraded`, never escapes (§1.4).
    let provider: { evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> } | null;
    try {
      provider =
        args.providerOverride ??
        (args.claudeProviderFactory
          ? args.claudeProviderFactory()
          : buildIntelligenceProvider({ framework: 'claude-code' }));
    } catch (err) {
      const reason = err instanceof ClaudeForbiddenError ? 'claude-forbidden' : classifyReviewFailure(err);
      return {
        status: 'degraded',
        framework: 'claude-code',
        model,
        reason,
        flag: `clean-door-anthropic-review: claude-code:${model} (degraded: ${reason})`,
        crossFamily: false,
      };
    }
    if (!provider) {
      return {
        status: 'degraded',
        framework: 'claude-code',
        model,
        reason: 'provider-unavailable',
        flag: `clean-door-anthropic-review: claude-code:${model} (degraded: provider-unavailable)`,
        crossFamily: false,
      };
    }

    let raw: string;
    try {
      raw = await provider.evaluate(args.promptText, {
        // The CONCRETE pin travels via reviewerHardening.model (§1.4) — never
        // options.model (a tier word). reviewerHardening also flips the claude
        // provider into the inbound-safety lockdown.
        reviewerHardening: { model },
        timeoutMs: args.timeoutMs,
        attribution: { component: 'crossModelReviewer' },
      });
    } catch (err) {
      const reason = classifyReviewFailure(err);
      return {
        status: 'degraded',
        framework: 'claude-code',
        model,
        reason,
        flag: `clean-door-anthropic-review: claude-code:${model} (degraded: ${reason})`,
        crossFamily: false,
      };
    }

    const parsed = parseReviewerReply(raw, tag);
    return {
      status: 'ok',
      framework: 'claude-code',
      model,
      verdict: parsed.verdict,
      findings: [parsed],
      // A clean-door second read gets its OWN disclosure field — NEVER the
      // `cross-model-review:` flag (§5.5). A copy-paste of this into frontmatter
      // cannot forge the cross-model field.
      flag: `clean-door-anthropic-review: claude-code:${model}`,
      crossFamily: false,
    };
  },
};

/**
 * The grok reviewer entry (the THIRD cross-model family — grok-build spec §8:
 * xAI's model line is genuinely independent of GPT and Gemini). Detection
 * delegates to `detectGrokReviewer`. `review` deliberately routes through the
 * provider-registry adapter's OneShotCompletion — NOT
 * `buildIntelligenceProvider` — because grok-build is structurally excluded
 * from internal background routing (spec §6.1: unobservable weekly pool);
 * a review is an explicit, bounded, per-call use, which is exactly the lane
 * the adapter exists for. The adapter's transport enforces the billing gate
 * (no metered key, live session) and the confinement floor (tools denied,
 * web search off, prompt via file) on every call.
 */
const grokReviewer: SupportedReviewerFramework = {
  id: 'grok-build',
  crossFamily: true,
  detect: (inputs) => detectGrokReviewer(inputs),
  review: async (args) => {
    const detection = args.detectionOverride ?? detectGrokReviewer();
    const model = detection.model ?? GROK_REVIEWER_MODEL;
    const tag = `cross-model:grok-build:${model}`;

    // Fail-loud model canary: NEVER silently review with a tier-word model.
    if (!isConcreteReviewerModel(model)) {
      return {
        status: 'degraded',
        framework: 'grok-build',
        model,
        reason: 'model-resolution-canary',
        flag: `cross-model-review: grok-build:${model} (degraded: model-resolution-canary)`,
        crossFamily: true,
      };
    }

    if (!detection.available) {
      return {
        status: 'degraded',
        framework: 'grok-build',
        model,
        reason: 'provider-unavailable',
        flag: `cross-model-review: grok-build:${model} (degraded: provider-unavailable)`,
        crossFamily: true,
      };
    }

    // PER-DAY FAMILY BUDGET (ships WITH the first production use — codex
    // round-3 f.4): repeated convergence rounds must not accumulate
    // unbounded invisible burn on a pool no one can read. Ceiling hit ⇒
    // the family degrades loudly for the rest of the day.
    const budgetNow = new Date();
    // Round-17 (scalability): admission RESERVES its slot under the lock, so
    // the ceiling holds under concurrency. The read below is retained only for
    // the reporting numbers in the refusal flag — the authoritative decision is
    // the reservation's verdict.
    const reservation = reserveGrokBudgetSlot(budgetNow);
    const reservationId = reservation.verdict === 'ok' ? reservation.id : null;
    // ROUND-19: STOP PATCHING EXITS. Round-18 released on two of the three
    // paths between admission and settle; the third (the outer catch) still
    // leaked, and 24 systematic throws reproduced the exact round-18
    // signature — exhausted at `0 runs / 0 tokens`. A failure that throws
    // before the spawn throws the SAME way every call, so 24-in-a-row is the
    // expected shape, not a worst case.
    //
    // One `finally` covers every exit that exists and every exit anyone adds
    // later, which per-return releases structurally cannot. `settled` is set
    // only where a run is genuinely counted.
    let settled = false;
    const budget = readGrokBudget(budgetNow);
    if (reservation.verdict === 'corrupt' || budget === CORRUPT_BUDGET) {
      // Round-18: this early return held a reservation on the corrupt path.
      if (reservationId) releaseGrokReservation(reservationId);
      // Fail CLOSED: present-but-unreadable ledger degrades the family
      // loudly (an unbudgetable spend-bearing family must not run
      // unbudgeted against an invisible pool).
      return {
        status: 'degraded',
        framework: 'grok-build',
        model,
        reason: 'provider-unavailable',
        flag: `cross-model-review: grok-build:${model} (degraded: budget-ledger-corrupt)`,
        crossFamily: true,
      };
    }
    if (reservation.verdict === 'exhausted') {
      return {
        status: 'degraded',
        framework: 'grok-build',
        model,
        reason: 'daily-budget-exhausted',
        flag: `cross-model-review: grok-build:${model} (degraded: daily-budget-exhausted ${budget.runs} runs / ${budget.totalTokens} tokens)`,
        crossFamily: true,
      };
    }

    let raw: string;
    try {
      const { createGrokBuildAdapter } = await import('../providers/adapters/grok-build/index.js');
      const { CapabilityFlag: Cap } = await import('../providers/capabilities.js');
      // Rung 2 must reach the LIVE lane too (round-12): pass the configured
      // path through so the reviewer spawns the SAME binary every other lane
      // resolves.
      const adapter = createGrokBuildAdapter({
        model,
        // The DETECTED path is the one detection already resolved through the
        // §2.1 ladder (including rung 2 when the caller supplied it), so the
        // reviewer spawns exactly the binary detection approved — never a
        // second, independently-resolved one.
        ...(detection.binaryPath ? { grokPath: detection.binaryPath } : {}),
      });
      const oneShot = adapter.primitive(Cap.OneShotCompletion) as {
        evaluate: (
          prompt: string,
          options?: { model?: string; timeoutMs?: number },
        ) => Promise<{ text: string }>;
      };
      let result: { text: string };
      try {
        result = await oneShot.evaluate(args.promptText, {
          model,
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        });
      } catch (evalErr) {
        // EVERY run counts (adversarial/lessons round-6 HIGH): a throw after
        // a token-burning spawn (timeout, post-spawn quota/auth) must trip
        // the run-count ceiling even with no envelope to count tokens from —
        // otherwise a systematic failure loop does unbounded unledgered work.
        // EXCEPT provably-pre-spawn capacity sheds (scalability round-8):
        // a shed spawned no child and burned zero tokens; counting it would
        // let transient HOST load exhaust the grok family's day.
        // ROUND-19: the exemption is now a PROVABLY-PRE-SPAWN predicate, not a
        // single boolean. Round-8 exempted capacity sheds because "a shed
        // spawned no child and burned zero tokens; counting it would let
        // transient HOST load exhaust the grok family's day". Every auth
        // refusal has the identical property — no child, no tokens — and had
        // no exemption. Measured: 25 refusals from a session inside its expiry
        // margin produced `24 runs / 0 tokens` and closed the family for the
        // day having spent nothing. That band is the last ~2 minutes of every
        // session (the call gate uses a 60s margin while detection uses zero),
        // and it widens with any operator-set timeout, so this is a routine
        // state rather than an edge case.
        const preSpawnRefusal =
          (evalErr as { capacityUnavailable?: unknown }).capacityUnavailable === true
          || (evalErr instanceof Error
            && [
              'GrokApiKeyForbiddenError',
              // Round-21: refused at the same chokepoint, before any spawn, so
              // it belongs in the same class. Omitting it would settle a run
              // that never happened against the daily ceiling.
              'GrokConfigCredentialForbiddenError',
              'GrokLoginPolicyUnverifiedError',
              'GrokSessionExpiredError',
            ].includes(evalErr.constructor.name));
        if (!preSpawnRefusal) {
          recordGrokBudget(budget, 0, 0, ['run-threw: no envelope recovered'], reservationId ?? undefined);
          settled = true;
        } else if (reservationId) {
          // Pre-spawn refusals release rather than settle, for the same reason
          // capacity sheds do: nothing was spent, so nothing should be counted.
          // Round-18: the shed path deliberately does NOT record — and the
          // round-17 reservation it already wrote made that intent backwards,
          // because the slot stayed held for the full 15-minute TTL. Measured
          // by executing this path for the first time: 24 sheds with zero
          // settles closed the ceiling at `runs: 0`, and the resulting refusal
          // read "daily-budget-exhausted 0 runs / 0 tokens" — self-
          // contradicting, and exactly the wrong-diagnosis class round 17
          // fixed elsewhere. Sheds arrive in bursts (they ARE spawn-cap
          // saturation), so this silenced the family on transient host load,
          // which is the outcome the no-record rule exists to prevent.
          releaseGrokReservation(reservationId);
        }
        throw evalErr;
      }
      // Record BEFORE the stopReason gate (round-6 HIGH): the cancelled-
      // with-tokens-consumed mode (19/19 on large inputs) is the precise
      // failure lane the budget exists for — a degraded run that burned
      // tokens MUST count against the ceiling, and its anomalies MUST reach
      // the ledger's durable trail.
      const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } | null }).usage;
      const providerMeta = (result as {
        providerSpecific?: Record<string, { stopReason?: string | null; usageAnomalies?: string[] | null }>;
      }).providerSpecific?.['grok-build'];
      recordGrokBudget(
        budget,
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
        providerMeta?.usageAnomalies ?? null,
        reservationId ?? undefined,
      );
      settled = true;
      // A truncated review must NEVER pass as a complete external opinion
      // (adversarial round-3 f.4). FAIL CLOSED on absence too (lessons
      // round-4 / P20): unknown-completeness is not proof of completeness.
      if (providerMeta?.stopReason !== 'end_turn') {
        return {
          status: 'degraded',
          framework: 'grok-build',
          model,
          reason: 'provider-unavailable',
          flag: `cross-model-review: grok-build:${model} (degraded: stopReason=${classifyStopReason(providerMeta?.stopReason)})`,
          crossFamily: true,
        };
      }
      raw = result.text;
    } catch (err) {
      const reason = classifyReviewFailure(err);
      return {
        status: 'degraded',
        framework: 'grok-build',
        model,
        reason,
        flag: `cross-model-review: grok-build:${model} (degraded: ${reason})`,
        crossFamily: true,
      };
    } finally {
      // ROUND-19: the structural release. Any exit between admission and a
      // genuine settle returns its ceiling slot — including exits added by
      // someone who never reads this file. Round-18 released per-return and
      // missed the outer catch, which is the failure mode per-return handling
      // has by construction.
      //
      // `settled` is true ONLY where a run was actually counted, so this can
      // never double-count: release filters by id and never touches `runs`.
      if (reservationId && !settled) releaseGrokReservation(reservationId);
    }

    const parsed = parseReviewerReply(raw, tag);
    // Round-10 (external): route the version-drift canary's signal into the
    // ARTIFACT a human reads, not only the server log. Prepended so it cannot
    // be lost at the end of a long reply; SIGNAL-ONLY — the verdict, findings
    // and flag are untouched, so a drifted CLI never silently invalidates or
    // upgrades a review, it just tells the reader the evidence base moved.
    // Round-11 (security): the note embeds `grok --version` STDOUT, and the
    // binary is env/config-relocatable — so it is not vendor-trusted input.
    // Unclamped and unstripped, a multi-line version string would land as
    // top-level content in the artifact the converging agent folds into the
    // spec, bypassing §8's own "reviewer output is quoted untrusted data" rule
    // (the `> ` prefix applied to the first line only). First line, clamped,
    // control chars and backticks stripped, every line prefixed.
    const safeNote = sanitizeDriftAdvisory(getGrokVersionDriftNote());
    const finding = safeNote
      ? { ...parsed, body: `> ⚠ VERSION DRIFT ADVISORY: ${safeNote}\n\n${parsed.body}` }
      : parsed;
    return {
      status: 'ok',
      framework: 'grok-build',
      model,
      verdict: parsed.verdict,
      findings: [finding],
      flag: `cross-model-review: grok-build:${model}`,
      crossFamily: true,
    };
  },
};

/**
 * The supported-reviewer registry. codex first — the order IS the preference
 * order. gemini second (Piece 3). Further frameworks land here as later
 * registry entries. NOTE: the registry only ever carries first-party OAuth
 * CLI adapters — see `TRUSTED_REVIEWER_FRAMEWORKS` below.
 */
export const SUPPORTED_REVIEWER_FRAMEWORKS: SupportedReviewerFramework[] = [
  codexReviewer,
  geminiReviewer,
  // The grok family (grok-build spec §8) — third cross-model family. In the
  // registry unconditionally (classification), ACTIVE only when detection
  // passes (binary + live subscription session + no metered key).
  grokReviewer,
  // The Anthropic clean-door family (REVIEWER-DOOR-REWIRING §1). ALWAYS in the
  // registry (so `isCrossFamilyReviewerFramework` can classify its id), but the
  // ACTIVE set filters it by the developmentAgent config gate
  // (`resolveActiveReviewerFrameworks`) — dark on the fleet, live on a dev agent.
  claudeReviewer,
];

/**
 * Is the Anthropic clean-door reviewer family enabled on this agent
 * (REVIEWER-DOOR-REWIRING §1.5)? Resolves through the standard developmentAgent
 * gate: `specConverge.reviewers.anthropic.enabled` OMITTED ⇒ live on a
 * development agent, dark on the fleet; an explicit value always wins. Absent
 * config ⇒ fleet-dark (byte-identical `[codex, gemini]`).
 */
export function isAnthropicReviewerEnabled(config?: ReviewerConfig): boolean {
  return resolveDevAgentGate(config?.specConverge?.reviewers?.anthropic?.enabled, config);
}

/**
 * The reviewer frameworks ACTIVE for this agent, config-gated. codex + gemini
 * are always active; the claude clean-door family is active only when
 * `isAnthropicReviewerEnabled(config)`. This is the seam the detection paths
 * iterate — so a fleet agent (no dev flag, no explicit enable) never sees the
 * claude family, preserving today's exact `[codex, gemini]` behavior.
 */
export function resolveActiveReviewerFrameworks(
  config?: ReviewerConfig,
): SupportedReviewerFramework[] {
  return SUPPORTED_REVIEWER_FRAMEWORKS.filter((f) =>
    f.id === 'claude-code' ? isAnthropicReviewerEnabled(config) : true,
  );
}

/**
 * Is `id` a CROSS-MODEL (non-Claude) reviewer family (REVIEWER-DOOR-REWIRING §5)?
 * Resolves against the FULL registry (independent of the config gate — this is a
 * classification of the id, not an enablement check), returning the entry's
 * `crossFamily`. Fail-CLOSED: an unknown / unresolvable / undefined id resolves
 * `false` (it can NEVER gain cross-model status by a lookup miss). This is the
 * single predicate the aggregate flag, both detection paths, and the 7-day
 * baseline all key on — so the claude family can never launder any of them.
 */
export function isCrossFamilyReviewerFramework(id: string | undefined): boolean {
  if (!id) return false;
  const entry = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === id);
  return entry?.crossFamily === true;
}

/**
 * Trusted-provider allowlist (Piece 3 — no spec egress to untrusted
 * endpoints). The registry only ever carries FIRST-PARTY OAuth CLI adapters:
 * the full spec text is handed to the reviewer model, so it must NEVER be
 * sent to a custom/base-URL endpoint an operator (or attacker) pointed a
 * framework at. The pi-cli multi-provider case is deliberately EXCLUDED from
 * cross-model review for exactly this reason — its provider may be a custom
 * endpoint. A framework id outside this list is refused by the script
 * wrapper (`--family`) with reason `untrusted-framework`.
 *
 * The invariant is "the spec text goes ONLY to the endpoint the OPERATOR THEMSELVES
 * configured for that first-party CLI" (REVIEWER-DOOR-REWIRING §2.2) — NOT "no
 * base-URL endpoint ever": each first-party CLI honors the operator's OWN
 * `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`/`GEMINI_BASE_URL`, which is the operator's
 * own trusted proxy. A third-party aggregator (OpenRouter) inserted by ADDING an
 * adapter is categorically different and stays out — that is why OpenRouter is
 * declined (§2). `claude-code` is added here (the clean-door family needs the
 * `--family claude-code` egress check to pass) — COUPLED ATOMICALLY with swapping
 * the 7-day baseline predicate off `isTrustedReviewerFramework` and onto
 * `isCrossFamilyReviewerFramework` (§5.4), so this addition can NEVER let a
 * claude-only activation satisfy the externals-mandatory baseline.
 */
export const TRUSTED_REVIEWER_FRAMEWORKS: readonly string[] = [
  'codex-cli',
  'gemini-cli',
  'claude-code',
  // grok-build (grok-build spec §8): xAI's own first-party CLI, subscription
  // OAuth only (the adapter's billing gate refuses metered keys), reviews run
  // with tools denied + web search off + prompt via file. Same first-party
  // posture as the other three; no third-party aggregator involved.
  'grok-build',
];

/** Is `id` on the trusted first-party reviewer allowlist? */
export function isTrustedReviewerFramework(id: string): boolean {
  return TRUSTED_REVIEWER_FRAMEWORKS.includes(id);
}

/**
 * Walk the registry in preference order and return the FIRST available
 * framework's detection result (back-compat single-reviewer entry point —
 * the multi-family collection is `detectAllCrossModelReviewers`). If none is
 * available, returns the preference-leader's specific reason (codex today) so
 * the report can render a concrete remediation, rather than the generic
 * `no-supported-framework`.
 *
 * SIGNAL-ONLY: never throws, never blocks. A `false` simply routes the skill
 * to the internal-only fallback (spec §4).
 */
export function detectCrossModelReviewer(
  inputs: CrossModelDetectInputs = {},
  config?: ReviewerConfig,
): CrossModelDetectionResult {
  const active = resolveActiveReviewerFrameworks(config);
  for (const framework of active) {
    const result = framework.detect(inputs);
    if (result.available) return result;
  }
  // Nothing available. Surface the preference-leader's specific reason.
  const leader = active[0];
  if (leader) return leader.detect(inputs);
  return { available: false, reason: 'no-supported-framework' };
}

/**
 * Collect EVERY available reviewer framework, in registry preference order
 * (Piece 3 — family diversity: GPT and Gemini catch different failure
 * classes, so the externals pass runs one review PER available family, not
 * first-match-only). Returns an empty array when none is available.
 *
 * SIGNAL-ONLY: never throws, never blocks.
 */
export function detectAllCrossModelReviewers(
  inputs: CrossModelDetectInputs = {},
  config?: ReviewerConfig,
): CrossModelDetectionResult[] {
  const available: CrossModelDetectionResult[] = [];
  for (const framework of resolveActiveReviewerFrameworks(config)) {
    const result = framework.detect(inputs);
    if (result.available) available.push(result);
  }
  return available;
}

// ── Failure classification ──────────────────────────────────────────────

/**
 * Map a provider rejection into a coarse `degraded` reason. The provider
 * surfaces timeouts, non-zero exits, and (via the circuit breaker) rate
 * limits as thrown Errors; we classify on the message text the same way the
 * rate-limit classifier does.
 */
export function classifyReviewFailure(err: unknown): string {
  // ROUND-19: branch on the error TYPE before falling back to its message.
  //
  // The grok adapter already types weekly-pool exhaustion as a terminal
  // QuotaError, and this function then re-derived a class by string-matching
  // the message — throwing the type away. Measured: the two wordings grok's own
  // regex was written for ("weekly limit reached for your plan", "you are out
  // of usage for this week") both round-tripped to `error`, indistinguishable
  // from a crash or a missing binary, while "rate limit exceeded" correctly
  // gave `rate-limited` (the control proving this function CAN say something
  // else). So the one stall class the spec calls unique to grok — the invisible
  // weekly wall — reached the operator as a generic failure, and nothing marked
  // the family terminal, so the next review retried straight back into it.
  const name = err instanceof Error ? err.constructor.name : '';
  if (name === 'GrokQuotaError' || name === 'QuotaError') return 'weekly-pool-exhausted';
  if (name === 'GrokRateLimitError' || name === 'RateLimitError') return 'rate-limited';

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (/weekly.?limit|out of usage/.test(lower)) {
    // Message-shaped fallback, deliberately NARROW: only the two wordings grok
    // actually emits for a weekly-pool wall. The first draft also matched
    // `usage limit`, which reclassified a pre-existing documented behaviour
    // ("usage limit reached" → rate-limited) that an existing test pins. A
    // rate limit clears on its own and a weekly wall does not, so widening the
    // wall's net to swallow an ambiguous phrase trades one misdiagnosis for
    // another — the exact shape this fix exists to remove.
    return 'weekly-pool-exhausted';
  }
  // `usage limit` stays HERE, where it was: it is ambiguous, the pre-existing
  // behaviour classified it as rate-limited, and a documented behaviour should
  // not change as a side effect of adding a narrower class beside it.
  if (/circuit breaker|rate.?limit|usage limit|quota|429|too many requests/.test(lower)) {
    return 'rate-limited';
  }
  if (/timed out|timeout|etimedout|killed/.test(lower)) {
    return 'timeout';
  }
  return 'error';
}

// ── Reviewer reply parsing ──────────────────────────────────────────────

/**
 * Parse a reviewer reply into a structured finding. The prompt mandates a
 * `Verdict: CLEAN | MINOR ISSUES | SERIOUS ISSUES` line + a findings list. If
 * the verdict line is unparseable (or the reply is blank), the whole reply is
 * captured as one raw "unstructured external review — read manually" finding
 * (never dropped, never thrown, never zero).
 */
/**
 * Clamp the version-drift advisory before it is embedded in a reviewer FINDING
 * (round-11 security). The note carries `grok --version` stdout, and the binary
 * is env/config-relocatable, so it is NOT vendor-trusted input: unclamped and
 * unstripped, a multi-line version string lands as top-level content in the
 * artifact the converging agent folds into a spec (the `> ` quote prefix
 * applies to the first line only), bypassing §8's own "reviewer output is
 * quoted untrusted data" rule. First line only, control characters and
 * backticks neutralized, length-bounded.
 */
/**
 * Clamp the vendor `stopReason` before it lands in a flag string that is written
 * into the convergence report and the iteration log (round-12 security). It is
 * raw envelope JSON from the same untrusted source as the drift advisory, six
 * lines away from the clamp that one already gets. Closed set in, anything else
 * out as `unrecognized` — a tag is a machine-readable field, not a place for
 * arbitrary vendor text.
 */
export function classifyStopReason(raw: unknown): string {
  if (raw === undefined || raw === null) return 'missing';
  if (raw === 'end_turn' || raw === 'cancelled') return raw;
  return 'unrecognized';
}

export function sanitizeDriftAdvisory(note: string | null): string | null {
  if (!note) return null;
  const firstLine = note.split(/\r?\n/)[0] ?? '';
  const cleaned = firstLine.replace(/[\u0000-\u001f\u007f`]/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}

export function parseReviewerReply(raw: string, reviewerTag: string): ReviewFinding {
  const text = (raw ?? '').trim();
  if (!text) {
    return {
      reviewer: reviewerTag,
      verdict: 'UNKNOWN',
      body: '(empty reviewer reply — codex returned no output; read manually)',
      unstructured: true,
    };
  }

  const verdict = extractVerdict(text);
  if (verdict === 'UNKNOWN') {
    return {
      reviewer: reviewerTag,
      verdict: 'UNKNOWN',
      body: `unstructured external review — read manually:\n${text}`,
      unstructured: true,
    };
  }

  return {
    reviewer: reviewerTag,
    verdict,
    body: text,
  };
}

/**
 * Extract the verdict from a reviewer reply. Looks for a `Verdict:` line and
 * matches one of the three canonical values (case-insensitive, tolerant of
 * surrounding markdown like `**Verdict: SERIOUS ISSUES**`). Returns 'UNKNOWN'
 * when none is found.
 */
function extractVerdict(text: string): ReviewVerdict {
  // Find a line mentioning "Verdict" and inspect its content.
  const verdictLine = text
    .split('\n')
    .find((l) => /verdict/i.test(l));
  const haystack = (verdictLine ?? text).toUpperCase();
  // Order matters: check the most specific multi-word verdicts first.
  if (haystack.includes('SERIOUS ISSUES')) return 'SERIOUS ISSUES';
  if (haystack.includes('MINOR ISSUES')) return 'MINOR ISSUES';
  if (haystack.includes('CLEAN')) return 'CLEAN';
  return 'UNKNOWN';
}

// ── Prompt assembly ─────────────────────────────────────────────────────

export interface ReferencedContextDoc {
  /** Repo-relative path used as the `--- CONTEXT: <path> ---` header. */
  path: string;
  /** The doc's contents (already read by the caller). */
  content: string;
}

export interface AssemblePromptInputs {
  /** Contents of skills/spec-converge/templates/reviewer-cross-model.md. */
  reviewerTemplate: string;
  /** The full spec markdown. */
  specMarkdown: string;
  /** Repo-relative spec path, substituted for {SPEC_PATH} in the template. */
  specPath: string;
  /** Referenced architectural context docs (same set internal reviewers see). */
  context?: ReferencedContextDoc[];
  /** Total budget in bytes. Defaults to CONTEXT_BUDGET_BYTES. */
  budgetBytes?: number;
}

export interface AssembledPrompt {
  /** The final prompt string fed to the provider. */
  promptText: string;
  /** True when referenced context had to be truncated to fit the budget. */
  truncated: boolean;
  /** Byte size of the assembled prompt. */
  bytes: number;
  /**
   * Repo-relative paths of LOAD-BEARING context docs
   * (`LOAD_BEARING_CONTEXT_SUBSTRINGS`) that did not make it in whole — either
   * cut mid-document or dropped entirely. Non-empty means the reviewer cannot
   * do the job the review claims to do, and `runCrossModelReview` degrades
   * instead of returning a verdict.
   *
   * Always present (empty when nothing load-bearing was lost) so a consumer
   * that forgets to check reads `[]` rather than `undefined` — an absent field
   * must never be mistakable for "nothing was lost".
   */
  omittedLoadBearing: string[];
  /**
   * The subset of `omittedLoadBearing` that could NEVER have fitted — the doc's
   * own byte size alone exceeds the WHOLE budget, so no spec is small enough to
   * admit it and no amount of trimming elsewhere will ever change the outcome.
   *
   * Split out from `omittedLoadBearing` after the independent review of
   * 2026-08-22 (finding C2). Both refuse, but they call for OPPOSITE actions and
   * a single reason string sent the reader down the wrong one: an ordinary
   * omission says *make the spec smaller*, while this says *stop passing this
   * doc as raw context — nothing you do to the spec can help.* The live case is
   * the standards registry, which is larger than the entire budget on its own:
   * attaching it produced a refusal whose advice ("use a smaller spec") was
   * unfollowable, which is a limit hiding behind its own polite notice — the
   * exact defect *Never Silently Cut the Data a Decision Depends On* was earned
   * from, reproduced by that article's own implementation.
   */
  undeliverableLoadBearing: string[];
}

/**
 * Assemble the cross-model reviewer prompt: the reviewer template (with
 * `{SPEC_PATH}` substituted) + the full spec + as much referenced context as
 * fits the budget. codex runs with NO repo access, so context is inlined under
 * `--- CONTEXT: <path> ---` headers. The spec is ALWAYS included in full; if
 * referenced docs overflow the budget, they are truncated and a loud
 * truncation note is added so the reviewer knows its view was partial (a
 * silently-truncated review is a trap; a disclosed-partial one is still signal).
 *
 * Truncation is DETERMINISTIC (spec §2, F4): referenced docs are ordered by
 * `orderContextDeterministically` (constitutional/lessons docs first, then the
 * spec-declared link order) BEFORE the budget walk, so the same spec + docs
 * always drop the same docs. When a doc is fully or partially dropped, the
 * truncation note NAMES the affected docs (which were partial, which were fully
 * omitted) — a reviewer must know exactly which context it could not see, not
 * just that "something" was cut.
 */
export function assembleReviewerPrompt(inputs: AssemblePromptInputs): AssembledPrompt {
  const budget = inputs.budgetBytes ?? CONTEXT_BUDGET_BYTES;
  const template = inputs.reviewerTemplate.replace(/\{SPEC_PATH\}/g, inputs.specPath);

  const header = `${template}\n\n--- SPEC UNDER REVIEW: ${inputs.specPath} ---\n${inputs.specMarkdown}\n`;

  const parts: string[] = [header];
  let used = Buffer.byteLength(header, 'utf-8');
  let truncated = false;

  // Deterministic priority order: constitutional/lessons docs first, then the
  // spec-declared link order. Same inputs always drop the same docs.
  const context = orderContextDeterministically(inputs.context ?? []);

  // Track exactly which docs were partially included vs fully dropped so the
  // truncation note can NAME them (F4 — a named-partial review is signal; a
  // "something was cut" review is a trap).
  let partialDoc: string | null = null;
  const droppedDocs: string[] = [];

  for (let i = 0; i < context.length; i++) {
    const doc = context[i];
    const docHeader = `\n--- CONTEXT: ${doc.path} ---\n`;
    const docBlock = `${docHeader}${doc.content}\n`;
    const docBytes = Buffer.byteLength(docBlock, 'utf-8');

    if (!truncated && used + docBytes <= budget) {
      parts.push(docBlock);
      used += docBytes;
      continue;
    }

    // Budget exceeded at this doc. Include as much of THIS doc as the remaining
    // budget allows (header always; body sliced), record it as PARTIAL, then
    // mark every remaining doc as fully DROPPED. We do NOT break — we keep
    // walking so the note can name all the dropped docs, not just the first.
    if (!truncated) {
      const remaining = budget - used - Buffer.byteLength(docHeader, 'utf-8');
      if (remaining > 0) {
        // Slice by bytes safely (avoid splitting a multibyte char by slicing
        // the buffer then decoding with replacement tolerated).
        const sliced = Buffer.from(doc.content, 'utf-8').subarray(0, remaining).toString('utf-8');
        parts.push(`${docHeader}${sliced}`);
        partialDoc = doc.path;
      } else {
        // Not even the header fits — this doc is fully dropped too.
        droppedDocs.push(doc.path);
      }
      truncated = true;
      continue;
    }

    // Already truncated — every subsequent doc is fully omitted.
    droppedDocs.push(doc.path);
  }

  if (truncated) {
    const detail: string[] = [];
    if (partialDoc) detail.push(`PARTIAL (cut mid-document): ${partialDoc}`);
    if (droppedDocs.length > 0) detail.push(`FULLY OMITTED: ${droppedDocs.join(', ')}`);
    const named = detail.length > 0 ? ` ${detail.join('. ')}.` : '';
    parts.push(
      '\n\n--- NOTE: referenced context was TRUNCATED to fit the review budget.' +
        named +
        ' Your view of the supporting docs is PARTIAL — flag any finding that ' +
        'depends on context you could not see. ---\n',
    );
  }

  // Which LOAD-BEARING docs failed to arrive IN FULL? A partial one counts as
  // omitted (see LOAD_BEARING_CONTEXT_SUBSTRINGS) — half a constitution cannot
  // certify a spec against the constitution.
  const omittedLoadBearing = [
    ...(partialDoc && isLoadBearingContext(partialDoc) ? [partialDoc] : []),
    ...droppedDocs.filter(isLoadBearingContext),
  ];

  // Of those, which could never have fitted at ANY spec size? Measured against
  // the WHOLE budget, not the remainder: a doc bigger than the entire budget is
  // undeliverable by construction, and saying "use a smaller spec" about it is
  // advice that cannot be followed.
  const undeliverableLoadBearing = omittedLoadBearing.filter((docPath) => {
    const doc = context.find((d) => d.path === docPath);
    if (!doc) return false;
    const block = `\n--- CONTEXT: ${doc.path} ---\n${doc.content}\n`;
    return Buffer.byteLength(block, 'utf-8') > budget;
  });

  const promptText = parts.join('');
  return {
    promptText,
    truncated,
    bytes: Buffer.byteLength(promptText, 'utf-8'),
    omittedLoadBearing,
    undeliverableLoadBearing,
  };
}

// ── Fallback flag helpers ───────────────────────────────────────────────

/**
 * The discrete cross-model review outcome states the report + frontmatter
 * record. Distinct so "you have no cross-model reviewer" reads differently
 * from "your reviewer was rate-limited this round" from "you chose the fast
 * path" from "the framework was present but NOT ONE round ever succeeded".
 *
 * `degraded-all-rounds` (spec §2/§4, F2) is the SPEC-LEVEL aggregate: a single
 * round's `degraded` lives on a ReviewerResult, but convergence runs many
 * rounds and the spec gets ONE final `cross-model-review:` value. When a
 * framework was present every round but ZERO rounds produced a successful
 * external pass (all degraded), the final flag is `degraded-all-rounds` —
 * treated as loud as `unavailable`, because the spec converged having never
 * once received a real external opinion. This must surface at SPEC level, not
 * hide in per-round notes.
 */
export type CrossModelFlagStatus =
  | 'available'
  | 'unavailable'
  | 'degraded'
  | 'degraded-all-rounds'
  | 'skipped-abbreviated';

export interface CrossModelFlag {
  status: CrossModelFlagStatus;
  /** The `cross-model-review:` frontmatter value. */
  flag: string;
  /** Optional `cross-model-review-reason:` value. */
  reason?: string;
}

/**
 * Build the fallback flag for the unavailable / skipped / degraded-all-rounds
 * states. (The available and per-round degraded flags come back on the
 * ReviewerResult.) Centralizes the exact strings the frontmatter writer +
 * report banner consume.
 *
 * `degraded-all-rounds` is the spec-level aggregate the skill writes when a
 * framework was present but no round ever succeeded (see
 * `aggregateRoundOutcomes`).
 */
export function buildCrossModelFlag(
  status: 'unavailable' | 'skipped-abbreviated' | 'degraded-all-rounds',
  reason?: string,
): CrossModelFlag {
  if (status === 'unavailable') {
    return { status, flag: 'cross-model-review: unavailable', reason };
  }
  if (status === 'degraded-all-rounds') {
    return { status, flag: 'cross-model-review: degraded-all-rounds', reason };
  }
  return { status, flag: 'cross-model-review: skipped-abbreviated', reason };
}

/**
 * Aggregate per-round cross-model outcomes into the ONE final spec-level flag
 * (spec §2/§4, F2). Convergence runs multiple rounds; each round yields a
 * `ReviewerResult` (`ok` / `degraded` / `unavailable`). The skill collects the
 * per-round statuses and calls this to decide what `write-convergence-tag.mjs`
 * stamps:
 *
 *   - `skipped-abbreviated` if the author opted out (passed explicitly) — wins
 *     over everything, since no external pass was attempted by choice.
 *   - `codex-cli:<model>` (the LAST successful round's flag) if ANY round got a
 *     real external pass — one genuine outside opinion is enough to say the spec
 *     received cross-model review.
 *   - `degraded-all-rounds` if a framework was present every round but ZERO
 *     rounds succeeded (all degraded) — as loud as `unavailable`.
 *   - `unavailable` if no framework was ever available (all rounds unavailable).
 *
 * Returns the `{ flag, reason }` the tag writer + report banner consume.
 */
export function aggregateRoundOutcomes(
  rounds: ReviewerResult[],
  opts: { skippedAbbreviated?: boolean } = {},
): CrossModelFlag {
  if (opts.skippedAbbreviated) {
    return buildCrossModelFlag('skipped-abbreviated');
  }
  if (rounds.length === 0) {
    // No rounds recorded at all — treat as no external reviewer available.
    return buildCrossModelFlag('unavailable', 'no-rounds-recorded');
  }

  // Any successful CROSS-MODEL round → the spec received a real external opinion.
  // ONLY `crossFamily: true` successes count toward the cross-model flag
  // (REVIEWER-DOOR-REWIRING §5.2): a claude-only success (`crossFamily: false`)
  // can NEVER launder a clean `cross-model-review` flag — it aggregates to
  // `degraded-all-rounds`/`unavailable` exactly as today, and is disclosed
  // separately in `clean-door-anthropic-review`. Fail-CLOSED on an absent field.
  // Use the LAST successful round's flag (the freshest pass on the most-converged spec).
  const successful = rounds.filter((r) => r.status === 'ok' && r.crossFamily === true);
  if (successful.length > 0) {
    const last = successful[successful.length - 1];
    return { status: 'available', flag: last.flag, ...(last.reason ? { reason: last.reason } : {}) };
  }

  // No successes. Was a framework ever present? If ANY round degraded (vs
  // unavailable), the framework was there but never delivered → all-rounds.
  const anyDegraded = rounds.some((r) => r.status === 'degraded');
  if (anyDegraded) {
    // Surface the most recent degraded reason for the `-reason` field.
    const lastDegraded = [...rounds].reverse().find((r) => r.status === 'degraded');
    return buildCrossModelFlag('degraded-all-rounds', lastDegraded?.reason);
  }

  // Every round was unavailable (no framework, ever).
  const lastUnavailable = [...rounds].reverse().find((r) => r.status === 'unavailable');
  return buildCrossModelFlag('unavailable', lastUnavailable?.reason);
}

/**
 * Resolve the per-family reviewer call timeout (REVIEWER-DOOR-REWIRING §3.2 /
 * §7 / D6) for `frameworkId` from the `specConverge.reviewers.timeoutMs` knob:
 *
 *   - absent / non-finite   ⇒ `REVIEW_TIMEOUT_MS` (120s) — today's default for
 *                             EVERY family (byte-identical fleet behavior).
 *   - a single number       ⇒ that value applies to ALL families.
 *   - a `{ default, byFramework }` map ⇒ `byFramework[frameworkId]` if a finite
 *                             number, else `default` if a finite number, else
 *                             the 120s default.
 *
 * Every non-default resolved value is clamped to [30s, 900s]
 * (`REVIEWER_TIMEOUT_MIN_MS`..`REVIEWER_TIMEOUT_MAX_MS`). PURE, never throws.
 * inc2 only ADDS the knob — it changes no family's default value.
 */
export function resolveReviewerTimeoutMs(
  config: ReviewerConfig | undefined,
  frameworkId: string,
): number {
  const knob = config?.specConverge?.reviewers?.timeoutMs;
  let raw: number | undefined;
  if (typeof knob === 'number') {
    raw = knob;
  } else if (knob && typeof knob === 'object') {
    const byFw = knob.byFramework?.[frameworkId as IntelligenceFramework];
    if (typeof byFw === 'number') raw = byFw;
    else if (typeof knob.default === 'number') raw = knob.default;
  }
  // Absent / non-finite ⇒ today's 120s default for EVERY family.
  if (raw === undefined || !Number.isFinite(raw)) return REVIEW_TIMEOUT_MS;
  // Clamp 30–900s per family (a below-floor value clamps up; above-ceiling down).
  return Math.min(REVIEWER_TIMEOUT_MAX_MS, Math.max(REVIEWER_TIMEOUT_MIN_MS, raw));
}

/**
 * The high-level entry the skill driver calls: detect, and if available run
 * the first available framework's reviewer with the assembled prompt;
 * otherwise return the `unavailable` flag. NEVER throws, NEVER blocks.
 *
 * `assembled` is produced by `assembleReviewerPrompt`. `detectInputs` and
 * `providerOverride` exist for tests; production omits them.
 */
/**
 * THE single place a cross-model reviewer is invoked.
 *
 * Every path — the first-match default and the per-family `--family` path the
 * skill actually uses — enters here, so the load-bearing context refusal cannot
 * be routed around. That is the whole point of the function existing: before
 * 2026-08-22 the refusal lived inline in `runCrossModelReview` while the skill
 * driver called `family.review(...)` directly, so the guard was live only on the
 * path nothing used (independent review, finding C1). A guard reachable by one
 * of two callers is not a guard; it is a comment with a test attached.
 */
async function invokeReviewerWithContextGuard(
  framework: SupportedReviewerFramework,
  detection: CrossModelDetectionResult,
  args: {
    assembled: AssembledPrompt;
    timeoutMs?: number;
    providerOverride?: ReviewerInvokeArgs['providerOverride'];
    config?: ReviewerConfig;
  },
): Promise<ReviewerResult> {

  // We have a reviewer. Before spending it, check that the input it is about
  // to judge is one a review can actually be conducted on. If the budget walk
  // dropped (or cut) a doc the review is not valid without, this is NOT a
  // review with a caveat — the reviewer could only check the spec against
  // itself. Degrade, name exactly what was lost, and spend nothing.
  //
  // This is deliberately a REFUSAL rather than a louder disclosure. The
  // assembler already disclosed the loss correctly and in full, naming every
  // affected doc in the prompt — and six rounds of review were still conducted
  // and reported as review on top of it. Disclosure informs a reader who
  // reads; refusal does not depend on anyone reading.
  const omitted = args.assembled.omittedLoadBearing ?? [];
  if (omitted.length > 0) {
    // Two refusals, not one (independent review 2026-08-22, finding C2). Both
    // decline to review; they differ in what the reader must DO about it, and
    // an undeliverable doc reported as an ordinary omission hands the reader
    // advice ("make the spec smaller") that cannot work at any spec size.
    const undeliverable = args.assembled.undeliverableLoadBearing ?? [];
    const reason =
      undeliverable.length > 0
        ? `context-undeliverable: ${undeliverable.join(', ')} — larger than the whole ` +
          `${CONTEXT_BUDGET_BYTES}-byte budget on its own; no spec size admits it. ` +
          `Do not pass it as raw context (the standards-conformance gate reads the ` +
          `constitution in code).`
        : `context-incomplete: ${omitted.join(', ')}`;
    return {
      status: 'degraded',
      framework: framework.id,
      reason,
      flag: `cross-model-review: ${framework.id} (degraded: ${
        (args.assembled.undeliverableLoadBearing ?? []).length > 0
          ? 'context-undeliverable'
          : 'context-incomplete'
      })`,
      crossFamily: isCrossFamilyReviewerFramework(framework.id),
    };
  }

  return framework.review({
    promptText: args.assembled.promptText,
    // Per-family timeout (§3.2 / D6): an explicit caller value wins (e.g. the
    // script's `--timeout-ms` dev override); otherwise resolve the per-family
    // budget from the `specConverge.reviewers.timeoutMs` knob (absent ⇒ 120s).
    timeoutMs: args.timeoutMs ?? resolveReviewerTimeoutMs(args.config, framework.id),
    // Hand the already-computed detection down so the entry never re-probes
    // the host (and tests stay hermetic to the injected inputs).
    detectionOverride: detection,
    ...(args.config ? { reviewerConfig: args.config } : {}),
    ...(args.providerOverride ? { providerOverride: args.providerOverride } : {}),
  });
}

export async function runCrossModelReview(args: {
  assembled: AssembledPrompt;
  timeoutMs?: number;
  detectInputs?: CrossModelDetectInputs;
  providerOverride?: ReviewerInvokeArgs['providerOverride'];
  /** Agent config for the config-gated claude clean-door family (§1.5). */
  config?: ReviewerConfig;
  /**
   * Review through THIS family specifically, instead of the first framework
   * detection happens to name.
   *
   * Added 2026-08-22 after the independent review's finding C1: the per-family
   * path existed only in the skill driver, which called `family.review(...)`
   * DIRECTLY — bypassing this function and therefore bypassing the load-bearing
   * context refusal below. `ReviewerInvokeArgs` carries only `promptText`, so
   * that path could not have refused even if it wanted to: the omission signal
   * does not reach it. Since `SKILL.md` instructs `--family` on every call, the
   * refusal was live on a path nothing used and absent from the path everything
   * used — dead code wearing a passing test (the test called this function).
   *
   * The fix is one chokepoint rather than a check copied into four family
   * entries (*Structure beats Willpower*): every review, per-family or not,
   * enters here and meets the same guard.
   */
  family?: string;
  /**
   * A detection the caller already computed (the driver detects before
   * assembling). Skips re-probing the host; MUST still be `available`.
   */
  detectionOverride?: CrossModelDetectionResult;
}): Promise<ReviewerResult> {
  // Derive detect inputs from config when the caller omitted them
  // (round-8: every future caller inherits the enabledFrameworks plumb —
  // an omitted-inputs call must not silently dark the config-gated family).
  const effectiveDetectInputs: CrossModelDetectInputs | undefined =
    args.detectInputs ??
    (Array.isArray((args.config as { enabledFrameworks?: string[] } | undefined)?.enabledFrameworks)
      ? { enabledFrameworks: (args.config as { enabledFrameworks: string[] }).enabledFrameworks }
      : undefined);
  // Per-family selection (C1): resolve THIS family's entry and detection, then
  // fall through to exactly the same refusal + invoke below. A family the
  // active registry does not carry is `unavailable`, never a silent fallback to
  // some other model — a caller that asked for gemini must not be answered by
  // codex without being told.
  const requestedFamily = args.family;
  if (requestedFamily !== undefined) {
    const entry = resolveActiveReviewerFrameworks(args.config).find(
      (f) => f.id === requestedFamily,
    );
    if (!entry) {
      const flag = buildCrossModelFlag('unavailable', 'no-supported-framework');
      return {
        status: 'unavailable',
        reason: 'no-supported-framework',
        flag: flag.flag,
        crossFamily: isCrossFamilyReviewerFramework(requestedFamily),
      };
    }
    const famDetection = args.detectionOverride ?? entry.detect(effectiveDetectInputs);
    if (!famDetection.available) {
      const flag = buildCrossModelFlag('unavailable', famDetection.reason);
      return {
        status: 'unavailable',
        reason: famDetection.reason,
        flag: flag.flag,
        crossFamily: isCrossFamilyReviewerFramework(requestedFamily),
      };
    }
    return invokeReviewerWithContextGuard(entry, famDetection, args);
  }

  const detection = args.detectionOverride ?? detectCrossModelReviewer(effectiveDetectInputs, args.config);
  if (!detection.available) {
    const flag = buildCrossModelFlag('unavailable', detection.reason);
    return {
      status: 'unavailable',
      reason: detection.reason,
      flag: flag.flag,
      crossFamily: isCrossFamilyReviewerFramework(detection.framework),
    };
  }

  const framework = resolveActiveReviewerFrameworks(args.config).find(
    (f) => f.id === detection.framework,
  );
  if (!framework) {
    // Defensive: detection named a framework with no active registry entry.
    const flag = buildCrossModelFlag('unavailable', 'no-supported-framework');
    return {
      status: 'unavailable',
      reason: 'no-supported-framework',
      flag: flag.flag,
      crossFamily: false,
    };
  }

  return invokeReviewerWithContextGuard(framework, detection, args);
}

// ── Delta-gating (reviewable-body hash) ─────────────────────────────────

/**
 * Hash the spec's REVIEWABLE body (Piece 3 delta-gating): sha256 hex of the
 * spec text with the leading YAML frontmatter block stripped and line endings
 * normalized (\r\n → \n). Frontmatter is excluded so tag-writes
 * (`review-convergence`, `approved: true`, cross-model flags) and other
 * metadata edits do NOT change the hash — externals re-run only when the
 * content a reviewer would actually read changed. The skill runs externals on
 * round 1 and on any round where this hash differs from the last external
 * pass's hash; an unchanged round records a skip-with-logged-note.
 */
export function hashSpecReviewableBody(specText: string): string {
  const normalized = (specText ?? '').replace(/\r\n/g, '\n');
  // Strip ONE leading frontmatter block: `---\n ... \n---` at the very top,
  // where the close fence is a WHOLE line (anchored `(\n|$)`) — `\n---\n?`
  // could terminate mid-line on `--- text` / `----` inside the block
  // (second-pass finding, PR 3).
  const body = normalized.replace(/^---\n[\s\S]*?\n---(\n|$)/, '');
  return crypto.createHash('sha256').update(body, 'utf-8').digest('hex');
}

// ── Durable framework-activation history ────────────────────────────────

/**
 * One recorded observation of which reviewer frameworks were available at a
 * moment in time. Appended (JSONL) to
 * `<stateDir>/state/framework-activation-history.jsonl` by the script
 * wrapper's `--detect-only --state-dir` path on every detection.
 */
export interface FrameworkActivationObservation {
  /** ISO timestamp; defaults to now. */
  ts?: string;
  /** framework id → was it available/active at observation time. */
  frameworks: Record<string, boolean>;
}

/** Max JSONL lines retained in the activation-history file. */
const ACTIVATION_HISTORY_MAX_LINES = 2000;

function activationHistoryPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'framework-activation-history.jsonl');
}

/**
 * Append ONE observation line to the durable framework-activation history
 * (Piece 3 — the standing-framework baseline). The externals-mandatory check
 * is judged against this recorded history over a lookback window, NOT a
 * just-in-time reading — so deactivating a framework right before converging
 * cannot present the agent as "genuinely single-framework."
 *
 * mkdir -p's the state dir; caps the file at the most recent
 * `ACTIVATION_HISTORY_MAX_LINES` lines on every write. Filesystem errors
 * propagate — a silently-unrecorded baseline would quietly weaken the
 * mandatory check (fail-loud).
 */
export function recordFrameworkActivationObservation(
  stateDir: string,
  observation: FrameworkActivationObservation,
): void {
  const file = activationHistoryPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = JSON.stringify({
    ts: observation.ts ?? new Date().toISOString(),
    frameworks: observation.frameworks,
  });
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  } catch {
    // No file yet — first observation.
  }
  lines.push(entry);
  if (lines.length > ACTIVATION_HISTORY_MAX_LINES) {
    lines = lines.slice(-ACTIVATION_HISTORY_MAX_LINES);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Was ANY non-Claude reviewer framework active at ANY point within the
 * lookback window, per the durable activation history? This is the
 * externals-mandatory check (Piece 3): `true` means the cross-model pass is
 * NON-SKIPPABLE for the spec — including when a framework was deactivated
 * inside the window (a just-before-converge deactivation does not exempt the
 * spec). The advisory "externals unavailable" floor is legitimate only when
 * this returns `false` across the whole lookback.
 *
 * NEVER throws: a missing file → false; corrupt lines are skipped.
 */
export function wasNonClaudeFrameworkActiveWithin(
  stateDir: string,
  lookbackDays: number,
  now?: Date,
): boolean {
  try {
    const file = activationHistoryPath(stateDir);
    const raw = fs.readFileSync(file, 'utf-8');
    const cutoff = (now ?? new Date()).getTime() - lookbackDays * 24 * 60 * 60 * 1000;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { ts?: unknown; frameworks?: unknown };
        const ts = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : NaN;
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const frameworks = parsed.frameworks;
        if (frameworks && typeof frameworks === 'object') {
          // Only CROSS-MODEL (non-Claude) reviewer framework ids count toward the
          // baseline (REVIEWER-DOOR-REWIRING §5.4 — swapped off
          // `isTrustedReviewerFramework` ATOMICALLY with adding `claude-code` to
          // TRUSTED). Keying on `isCrossFamilyReviewerFramework` is load-bearing:
          // `claude-code` is now TRUSTED (its egress is allowed) but is NOT
          // cross-family, so a claude-only activation must NEVER satisfy the
          // externals-mandatory baseline. A stray/hand-written non-cross-family
          // key likewise can't flip the decision.
          const entries = Object.entries(frameworks as Record<string, unknown>);
          if (entries.some(([id, v]) => v === true && isCrossFamilyReviewerFramework(id))) {
            return true;
          }
        }
      } catch {
        // @silent-fallback-ok — a corrupt history line is skipped (never throws);
        // the read is a union-over-time, so a lost line can only UNDER-report
        // activation, which keeps externals mandatory-safe, never lies them off.
      }
    }
    return false;
  } catch {
    // @silent-fallback-ok — a missing/unreadable history file is the expected
    // pre-first-run state: no recorded activation is the correct answer.
    return false;
  }
}
