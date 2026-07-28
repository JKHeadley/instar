# Side-Effects Review — Cross-Model Convergence Hardening (Autonomy Principles Enforcement, Piece 3)

**Version / slug:** `cross-model-hardening`
**Date:** `2026-06-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see appended verdict)`

## Summary of the change

Implements Piece 3 of `docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md`: cross-model convergence becomes **mandatory (with a durable activation baseline), dynamic (no pinning), family-diverse, delta-gated, allowlist-constrained, and fail-loud**. Honest scope note: the spec's headline "broken foundation" claim (`resolveModelForFramework` returning a dead tier string for gemini/pi) was **already fixed on main** before this build — recorded at PR #1055; this PR implements everything else.

- **gemini-cli reviewer registry entry** (`src/core/crossModelReviewer.ts`) — the registry seam's first extension beyond codex: injectable never-throws detection (binary + cached OAuth creds), provider via the existing factory (own circuit breaker), identical degraded semantics.
- **Family-diverse collection** — `detectAllCrossModelReviewers()` returns ALL available frameworks; the skill now runs one external pass per available family instead of first-match-only.
- **Delta-gating** — `hashSpecReviewableBody()` (sha256, frontmatter-stripped, CRLF-normalized); externals are mandatory on round 1 + any round where the reviewable body changed; an unchanged round records a skip-with-logged-note (≠ skipped-abbreviated).
- **Durable activation baseline** — `recordFrameworkActivationObservation()` / `wasNonClaudeFrameworkActiveWithin()` (JSONL at `state/framework-activation-history.jsonl`, 2000-line cap): externals are non-skippable whenever a non-Claude framework was active at any point in a 7-day lookback — a just-before-converge deactivation no longer exempts a spec (round-2 adversarial F-R2-3).
- **Trusted-provider allowlist** — `TRUSTED_REVIEWER_FRAMEWORKS = ['codex-cli','gemini-cli']`; the registry constructively carries only first-party OAuth CLIs; `--family pi-cli` (or any unlisted id) is refused (`untrusted-framework`) so the full spec text is never sent to a custom/base-URL endpoint.
- **Fail-loud canary** — `isConcreteReviewerModel()`: both entries degrade LOUDLY (`model-resolution-canary`) rather than silently reviewing with a bare tier word.

Files: `src/core/crossModelReviewer.ts`, `skills/spec-converge/scripts/cross-model-review.mjs`, `skills/spec-converge/SKILL.md`, `tests/unit/crossModelReviewer-piece3.test.ts` (new, 32 tests), hermeticity fixes in 2 existing test files.

## Decision-point inventory

- Cross-model framework detection/selection — **modify** — first-match → all-available (collection only; no blocking authority).
- `--family` allowlist guard — **add** — hard-invariant refusal of an untrusted framework id at the script edge (egress protection, enumerable set).
- Externals-mandatory check (SKILL.md + `wasNonClaudeFrameworkActiveWithin`) — **add** — a deterministic read over the durable history that decides whether the SKILL FLOW may skip an external pass. Process-gating inside spec review; blocks no agent action or message.
- Model canary — **add** — degrades a review pass; blocks nothing.

---

## 1. Over-block

The allowlist refusing `pi-cli` could be seen as over-blocking a legitimate reviewer — deliberate: pi is multi-provider by design (its model flag may resolve to a custom endpoint), and the cost of a wrongly-allowed egress (full spec text to an attacker-controlled model) dwarfs the cost of one fewer reviewer family. The activation lookback could keep externals mandatory for an agent that genuinely uninstalled a framework yesterday — accepted: the 7-day tail is the entire point (anti-gaming), and the pass degrades to advisory-unavailable rather than hard-failing when the framework is truly gone.

## 2. Under-block

The activation history only records when `--detect-only`/review runs execute — an agent that NEVER ran spec-converge in the lookback has an empty history and presents as single-framework. Acceptable: the first detect of the current convergence records the observation, so the gaming window is "deactivate before the FIRST round" — and a genuinely deactivated-everywhere agent degrades to the advisory floor exactly as specced. The history is also local-file mutable by the agent itself (not tamper-proof) — consistent with every other instar state file; the report banner + frontmatter flag remain the human-visible disclosure.

## 3. Level-of-abstraction fit

Correct: detection/selection/hash/history are cheap structural helpers in the existing crossModelReviewer module (the registry's documented extension point); the SKILL owns the flow policy; nothing re-implements the provider factory, circuit breaker, or aggregation (`aggregateRoundOutcomes` unchanged and still computes the spec-level flag).

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — no block/allow surface over agent behavior or messages. The two refusal points (allowlist, canary) are **hard-invariant validation** over enumerable sets (the principle's explicitly-allowed class — egress protection is the "safety guards on irreversible actions" case). Review outcomes only ever DEGRADE with logged reasons; judgment stays with the reviewers and the convergence process.

## 5. Interactions

- **Back-compat:** `detectCrossModelReviewer` (first-match) and the script's default single-pass mode are unchanged; existing callers/tests pass (hermeticity fixes only — the suite previously assumed gemini absent, false on hosts with gemini installed).
- **Aggregation:** per-family results feed the existing per-round → spec-level aggregation unchanged; a delta-skip is recorded as a logged note, not a round outcome, so `degraded-all-rounds` semantics are preserved.
- **Double-fire/races:** the activation JSONL is append-with-cap from a single skill flow; worst case under concurrent convergences is a lost observation line (history is a union-over-time read, so this cannot flip mandatory→optional within the lookback).
- **Circuit breakers:** each framework keeps its own breaker via the factory — a rate-limited codex degrades that pass; gemini still runs (the family-diversity goal).

## 6. External surfaces

- **LLM egress:** spec text now also flows to gemini (first-party Google OAuth CLI) when available — the same egress class as the existing codex pass, now explicitly allowlist-bounded. No new third-party endpoints; pi/custom endpoints structurally excluded.
- **Persistent state:** `state/framework-activation-history.jsonl` (capped). No fleet surface: spec-converge remains agent-private (decision recorded in the Piece-2 artifact); no `src/` runtime route/config change — `crossModelReviewer.ts` is library code consumed by the skill script.

## 7. Rollback cost

Revert the commit. The history file is inert if orphaned. No migration, no API, no fleet propagation.

## Conclusion

Piece 3 closes the spec: externals can no longer be quietly skipped (durable 7-day baseline + delta-gating with logged notes), selection is dynamic and family-diverse with zero pinned model names, and the two real security findings from convergence (spec egress to untrusted endpoints; silent dead-model reviews) are structurally closed (allowlist + canary). Verified: tsc clean, full lint clean, 77 unit (45 existing + 32 new) + 3 integration green, live smoke on this host detected both codex + gemini and refused pi-cli. Clear to ship as the final PR of the spec.

---

## Scope disclosure (honest residual)

Two spec clauses are NOT implemented in this PR and are tracked, not orphaned <!-- tracked: CMT-1317 -->: (a) the Claude-only-agent floor reaching a *different-family* model via the subscription-path/provider-registry fallback — a single-framework agent currently gets the honest advisory `unavailable` flag (the pre-existing behavior, loudly disclosed in the report banner), and (b) surfacing "no external family reachable at all" as a HumanAsDetector-style tracked-gap signal rather than the advisory note. Both need provider-registry plumbing that doesn't belong in this hardening pass.

## Second-pass review

**Reviewer:** independent reviewer subagent (verified findings against the actually-installed gemini CLI v0.25.2).
**Independent read of the artifact: concern raised → all resolved this pass.**

- MUST-FIX (resolved): `GEMINI_HOME` is not a real gemini CLI env var (zero occurrences in the CLI dist; creds are unconditionally `~/.gemini/oauth_creds.json`). Honoring it made detection probe a path the CLI never reads — a false-unavailable would silently skip the gemini pass AND poison the activation baseline with `gemini-cli:false`, the exact suppression Piece 3 prevents. Fixed: env lookup dropped; injectable test seam kept.
- NICE-TO-HAVE (applied): frontmatter-strip close anchor tightened to a whole-line fence (`\n---(\n|$)`) so `--- text`/`----` inside the block can't terminate the strip mid-line.
- INFORMATIONAL (applied anyway): `wasNonClaudeFrameworkActiveWithin` now counts only TRUSTED reviewer framework ids, so a stray `{"claude-code":true}` line can't flip the externals-mandatory decision.
- HONESTY (applied): the scope disclosure above was added at the reviewer's prompting — the artifact previously implied full Piece-3 coverage.
- Confirmed clean: `--family` allowlist guard sits before any detect/provider call; no path (default, detect-all, or detectionOverride) can route spec text to a non-registry framework — the registry⊆allowlist invariant is itself unit-tested; `buildIntelligenceProvider({framework:'gemini-cli'})` cannot reach a custom base-URL (allowlisted child env); refresh-token-only IS authed for this CLI; the canary precedes provider construction in both entries; the 2000-line cap keeps the most recent lines; the reader never throws on corruption; the existing-test edits weaken no assertion.

After fixes: tsc exit 0, 77/77 unit + 3/3 integration green.

---

## Evidence pointers

- `tests/unit/crossModelReviewer-piece3.test.ts` (32): gemini detect triad, detect-all cardinality, canary accept/reject, hash frontmatter/CRLF stability, activation write/read/lookback/corrupt-line/cap, allowlist, gemini degraded paths.
- Live smoke: `--detect-only --state-dir` → codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro both detected + observation written; `--family pi-cli` → `untrusted-framework`; `--hash-only` → stable hash.
- `npx tsc --noEmit` exit 0; `npm run lint` exit 0.
