/**
 * crossModelReviewer — Step B of the tiered development process.
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
 * codex is the FIRST supported framework; the registry
 * (`SUPPORTED_REVIEWER_FRAMEWORKS`) is the single seam for gemini-cli and
 * others to plug in later (Out of Scope here). Adding a framework is one
 * registry entry + one `id`-union extension — no skill change.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCodexPath } from './Config.js';
import { validateRule1 } from '../providers/adapters/openai-codex/credentials.js';
import { resolveCliModelFlag } from '../providers/adapters/openai-codex/models.js';
import {
  buildIntelligenceProvider,
  type IntelligenceFramework,
} from './intelligenceProviderFactory.js';

// ── Constants (tunable) ─────────────────────────────────────────────────

/**
 * Per-call timeout for a cross-model spec review. A reasoning review of a
 * full spec is far heavier than the provider's 30s judgment-call default, so
 * Step B bumps it to 120s (spec §2).
 */
export const REVIEW_TIMEOUT_MS = 120_000;

/**
 * Total context budget (spec + referenced docs) inlined into the reviewer
 * prompt. codex runs in an empty read-only scratch dir with no repo access,
 * so referenced context MUST be inlined; this bounds the prompt size (spec §2).
 * The spec is always included in full; referenced context fills the remainder
 * and is truncated (with a loud note) if it overflows.
 */
export const CONTEXT_BUDGET_BYTES = 60 * 1024;

/**
 * Deterministic priority ordering for referenced context (spec §2, F4).
 *
 * When the 60KB budget can't hold every referenced doc, truncation MUST be
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
  | 'no-supported-framework';

export interface CrossModelDetectionResult {
  available: boolean;
  /** Present when available; the framework id that will run the review. */
  framework?: IntelligenceFramework;
  /** Present when available; the concrete model the review resolves to. */
  model?: string;
  /** Present when unavailable; a specific machine-readable reason. */
  reason?: CrossModelUnavailableReason;
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
  };
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
   * Optional provider override — tests inject a stub so no real codex spawn
   * happens. Production passes nothing and the factory builds the real one.
   */
  providerOverride?: { evaluate(prompt: string, options?: { model?: 'fast' | 'balanced' | 'capable'; timeoutMs?: number }): Promise<string> };
}

/**
 * The codex reviewer entry. Detection delegates to `detectCodexReviewer`;
 * `review` routes through the factory-built `CodexCliIntelligenceProvider`.
 */
const codexReviewer: SupportedReviewerFramework = {
  id: 'codex-cli',
  detect: (inputs) => detectCodexReviewer(inputs),
  review: async (args) => {
    const detection = detectCodexReviewer();
    const model = detection.model ?? resolveCliModelFlag(REVIEW_MODEL_TIER);
    const tag = `cross-model:codex-cli:${model}`;

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
      };
    }

    let raw: string;
    try {
      raw = await provider.evaluate(args.promptText, {
        model: REVIEW_MODEL_TIER,
        timeoutMs: args.timeoutMs,
      });
    } catch (err) {
      const reason = classifyReviewFailure(err);
      return {
        status: 'degraded',
        framework: 'codex-cli',
        model,
        reason,
        flag: `cross-model-review: codex-cli:${model} (degraded: ${reason})`,
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
    };
  },
};

/**
 * The supported-reviewer registry. codex first — the order IS the preference
 * order. gemini-cli and others land here as later steps (Out of Scope).
 */
export const SUPPORTED_REVIEWER_FRAMEWORKS: SupportedReviewerFramework[] = [codexReviewer];

/**
 * Walk the registry in preference order and return the FIRST available
 * framework's detection result. If none is available, returns the codex
 * reason when there's exactly one entry (so the report can be specific), else
 * the generic `no-supported-framework`.
 *
 * SIGNAL-ONLY: never throws, never blocks. A `false` simply routes the skill
 * to the internal-only fallback (spec §4).
 */
export function detectCrossModelReviewer(
  inputs: CrossModelDetectInputs = {},
): CrossModelDetectionResult {
  for (const framework of SUPPORTED_REVIEWER_FRAMEWORKS) {
    const result = framework.detect(inputs);
    if (result.available) return result;
  }
  // Nothing available. Surface the single framework's specific reason when
  // there's only one entry (codex today); otherwise the generic reason.
  if (SUPPORTED_REVIEWER_FRAMEWORKS.length === 1) {
    return SUPPORTED_REVIEWER_FRAMEWORKS[0].detect(inputs);
  }
  return { available: false, reason: 'no-supported-framework' };
}

// ── Failure classification ──────────────────────────────────────────────

/**
 * Map a provider rejection into a coarse `degraded` reason. The provider
 * surfaces timeouts, non-zero exits, and (via the circuit breaker) rate
 * limits as thrown Errors; we classify on the message text the same way the
 * rate-limit classifier does.
 */
export function classifyReviewFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
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

  const promptText = parts.join('');
  return {
    promptText,
    truncated,
    bytes: Buffer.byteLength(promptText, 'utf-8'),
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

  // Any successful round → the spec received a real external opinion. Use the
  // LAST successful round's flag (the freshest pass on the most-converged spec).
  const successful = rounds.filter((r) => r.status === 'ok');
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
 * The high-level entry the skill driver calls: detect, and if available run
 * the first available framework's reviewer with the assembled prompt;
 * otherwise return the `unavailable` flag. NEVER throws, NEVER blocks.
 *
 * `assembled` is produced by `assembleReviewerPrompt`. `detectInputs` and
 * `providerOverride` exist for tests; production omits them.
 */
export async function runCrossModelReview(args: {
  assembled: AssembledPrompt;
  timeoutMs?: number;
  detectInputs?: CrossModelDetectInputs;
  providerOverride?: ReviewerInvokeArgs['providerOverride'];
}): Promise<ReviewerResult> {
  const detection = detectCrossModelReviewer(args.detectInputs);
  if (!detection.available) {
    const flag = buildCrossModelFlag('unavailable', detection.reason);
    return {
      status: 'unavailable',
      reason: detection.reason,
      flag: flag.flag,
    };
  }

  const framework = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === detection.framework);
  if (!framework) {
    // Defensive: detection named a framework with no registry entry.
    const flag = buildCrossModelFlag('unavailable', 'no-supported-framework');
    return { status: 'unavailable', reason: 'no-supported-framework', flag: flag.flag };
  }

  return framework.review({
    promptText: args.assembled.promptText,
    timeoutMs: args.timeoutMs ?? REVIEW_TIMEOUT_MS,
    ...(args.providerOverride ? { providerOverride: args.providerOverride } : {}),
  });
}
