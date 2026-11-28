# Side-Effects Review — gemini reviewer: trust flag and named failure reasons

**Version / slug:** gemini-reviewer-trust-and-tier
**Date:** 2026-11-07
**Author:** Dawn (instar-developing agent)
**Second-pass reviewer:** one independent general-purpose subagent (see below)

## Summary of the change
Tier 1 narrow fix. The gemini-cli family of the cross-model spec reviewer (`src/core/crossModelReviewer.ts`) had degraded on every run with the generic reason `error`. Measured 2026-11-07 on gemini CLI 0.67.0, two causes: (1) a headless run outside a trusted folder exits 55 ("Gemini CLI is not running in a trusted directory ... use `--skip-trust`"); (2) with `--skip-trust` the CLI then fails auth with exit 1 and `IneligibleTierError` / reasonCode `UNSUPPORTED_CLIENT` ("This client is no longer supported for Gemini Code Assist for individuals"). Changes: `GeminiCliIntelligenceProvider` gains an opt-in `skipTrust` option that prepends `--skip-trust` to its one-shot argv; `buildIntelligenceProvider` gains a gemini-only `geminiSkipTrust` option that forwards it; the gemini reviewer entry builds its provider with `geminiSkipTrust: true`; and a new `classifyGeminiReviewFailure` (used only by the gemini entry) maps exit 55 / the untrusted-folder message to `gemini-untrusted-folder` and `IneligibleTierError` / `UNSUPPORTED_CLIENT` to `gemini-tier-unsupported`, falling through to the unchanged `classifyReviewFailure` for everything else. One addition beyond the brief, driven by measurement: gemini 0.35.0 rejects the flag (`Unknown arguments: skip-trust, skipTrust`, exit 1, strict yargs) and has no trust gate, so on that exact refusal the provider retries once without the flag. Files: `src/core/GeminiCliIntelligenceProvider.ts`, `src/core/intelligenceProviderFactory.ts`, `src/core/crossModelReviewer.ts`, `tests/unit/gemini-reviewer-trust-and-tier.test.ts`. Size: 3 src files, ~70 added lines, plus one test file. Effort: one review round, commit attempts recorded in the PR.

## Decision-point inventory
- gemini reviewer degraded-reason classification — modify — two new named reasons ahead of the shared classifier, gemini entry only. It labels a failure; it does not block anything.
- `aggregateRoundOutcomes` (spec-level flag) — pass-through, not changed. A `gemini-tier-unsupported` round is still `degraded`, exactly as `error` was.

## 1. Over-block
No block/allow surface — over-block not applicable. The closest risk is mislabelling: a non-trust exit 55 would be called `gemini-untrusted-folder`. gemini 0.67.0 uses 55 for this refusal, and the label is only a reason string on a result that is degraded either way.

## 2. Under-block
No block/allow surface — under-block not applicable. Remaining miss: other gemini account/auth failures still read as `error` (or `rate-limited`/`timeout` via the shared classifier). The tier cut-off itself is NOT fixed: on this machine gemini will still degrade, now with the honest reason `gemini-tier-unsupported`. That needs an operator decision on auth/tier (tracked as aq-9849fe10), not code.

## 3. Level-of-abstraction fit
The flag lives in the provider (the one place that builds gemini argv for the alive path), but is opt-in and switched on only at the reviewer call site, so the shared canonical argv builder `buildGeminiOneShotArgv` and every other gemini caller (sentinels, reflect, routing) keep byte-identical argv. The new classifier wraps rather than edits `classifyReviewFailure`, so codex/grok/claude classification cannot move.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md.
- [x] No — this change has no block/allow surface.
The reason strings are signals recorded on a degraded result; nothing gates on their value.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. The mapping is enumerable: two documented CLI failure signatures.

## 5. Interactions
- Shadowing: exit 55 is checked before the tier signature on purpose — the measured exit-55 stderr carried the IneligibleTierError FIRST (the CLI authenticates before it checks trust) and the trust message after the provider's 600-char stderr slice, so the exit code is the reliable signal. With `--skip-trust` passed, exit 55 no longer occurs on a current CLI.
- Double-fire: the old-CLI retry runs inside one `evaluate()` call, before the capacity policy sees the result; it flips `skipTrust` to false so it can fire at most once per call and cannot interact with the capacity retry counter (it does not increment `attempt`).
- Circuit breaker: the tier/trust messages contain none of the rate-limit words, so the breaker re-throws them unchanged (verified end-to-end by the tests, which run through the factory's breaker + spawn-cap wrappers).
- Feedback loops: none.

## 6. External surfaces
- The gemini reviewer's `reason` / `flag` strings change from `error` to `gemini-untrusted-folder` or `gemini-tier-unsupported` for these two cases; these land in spec frontmatter `cross-model-review-reason` and convergence reports. Free-form reason strings; nothing parses them for these values.
- The gemini child process gets one extra argv element on the reviewer call. Spec text was already sent to gemini; `--skip-trust` only trusts the cwd for this session, and `--approval-mode default` stays pinned, so no tool/file action is enabled.
- Operator surface: no operator-facing actions.

## 6b. Operator-surface quality
No operator surface — not applicable.

## 7. Multi-machine posture
Machine-local BY DESIGN: each machine runs its own gemini CLI with its own version, login and tier, so the call and its failure reason are per-machine truths. No state, notices, or URLs are added. No status surfaces change.

## 8. Rollback cost
Pure code revert, no persistent state. Rollback returns the reviewer to exit-55 refusals reported as `error`.

## Validation
`tests/unit/gemini-reviewer-trust-and-tier.test.ts` (7 tests) drives the real chain: reviewer → factory (only binary detection redirected) → provider → a fake `gemini` script that logs argv and replays the measured stderr. On the original src: 5 of 7 fail (the two "unchanged" controls pass). Mutations, each restored after: removing the untrusted mapping fails the exit-55 test; removing the tier mapping fails the tier test; dropping `geminiSkipTrust` in the reviewer fails the invocation and old-CLI tests; making the provider ignore `skipTrust` fails the same two; removing the old-CLI retry fails the old-CLI test. Related suites (crossModelReviewer, piece3, factory, usage-contract, attribution and keyword ratchets, grok classification, gemini integration): all pass. `tsc --noEmit` exit 0.

## Class-Closure Declaration
No agent-authored-artifact defect — not applicable (TypeScript runtime code). Not a self-triggered controller either: the single retry is bounded within one call by a state flip (`skipTrust` → false), so its steady state is reached after at most one extra spawn.

## Second-pass review

**Reviewer:** independent general-purpose subagent (sonnet), read-only, final diff
**Independent read of the artifact: concur**

Concur with the review. Verified: `spawnGeminiAndWait` resolves on non-zero exit, so the old-CLI retry runs before the capacity policy and flips `skipTrust` before `continue` (cannot fire twice, `attempt` untouched); the only production site passing `geminiSkipTrust` is the gemini reviewer entry, and other gemini argv builders are untouched; the circuit breaker never rewrites `err.message`, and neither measured stderr contains a `classifyRateLimit` trigger; the exit-55 check matches the provider's own message prefix, so it is independent of the stderr slice; `classifyGeminiReviewFailure` is called only from the gemini entry and `aggregateRoundOutcomes` treats `reason` as opaque. Ran the 7 new tests (pass) and `tsc --noEmit` (exit 0). No defects found.
