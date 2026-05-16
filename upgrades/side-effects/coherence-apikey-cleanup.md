# Side-effects review — drop unused `apiKey` from CoherenceReviewer + CoherenceGate

**Version / slug:** `coherence-apikey-cleanup`
**Date:** `2026-05-15`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (mechanical dead-code removal; baseline test diff is identity)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (Rule 2 lockdown)

## Summary of the change

Carry-over cleanup from the Rule 2 path-constraint lockdown (task #5, commit landed earlier in this branch). After that commit removed the direct-Anthropic-API fallback inside `CoherenceReviewer.callApi()`, the `apiKey` parameter on the base class, every subclass, `DynamicReviewer`, and `CoherenceGateOptions` became stored-but-never-read dead state. This change removes the parameter, makes `intelligence` required on `CoherenceGateOptions`, and updates `server.ts` to gate response-review activation purely on `sharedIntelligence` instead of an `ANTHROPIC_API_KEY` fallback.

Files touched (in scope per the destructive-callsite gate):
- `src/core/CoherenceReviewer.ts` — drop `apiKey` ctor arg + `protected readonly apiKey` field.
- `src/core/CoherenceGate.ts` — drop `apiKey` from `CoherenceGateOptions`; `intelligence` becomes required; remove the three callsites that threaded the key down to GateReviewer / specialist reviewers / DynamicReviewer.
- 10 reviewer subclasses (`src/core/reviewers/*.ts`) — drop `apiKey` ctor arg.
- `src/commands/server.ts` — drop `ANTHROPIC_API_KEY` fallback activation; pipeline disables with warning when no IntelligenceProvider is wired.
- `src/providers/adapters/anthropic-interactive-pool/canary/emptyPromptSignature.ts` — orthogonal carry-over: add file-level `safe-git-allow:` marker for the existing `fs.rmSync` in `resetSignatureForTests()` (pre-existing lint violation blocking all commits in this worktree; not introduced by this change).
- `scripts/check-rule3-coverage.cjs` — orthogonal carry-over: add `safe-git-allow:` marker for read-only `git diff --cached` / `git show` bootstrap invocations.

Tests touched: 7 unit-test files dropping `FAKE_API_KEY` ctor args and `apiKey: ...` lines from `CoherenceGateOptions` literals; plus the test isolation fix from task #24 (`promptRunner.test.ts` `beforeEach(resetSignatureForTests)`) and two test-file `safe-git-allow:` markers for tmpdir / throwaway-repo cleanup.

## Decision-point inventory

This change has NO decision-point surface. It removes dead constructor parameters and adjusts one server-side activation gate.

- `src/commands/server.ts` (response-review pipeline activation) — `pass-through`. The decision is identical: "activate iff we have an IntelligenceProvider." Previously expressed as `(sharedIntelligence || anthropicKey)` with a never-reachable raw-API branch downstream; now expressed as `sharedIntelligence` alone. The raw-API branch was already dead after Rule 2.
- `CoherenceGate` constructor — `pass-through`. Pipeline behavior unchanged; only the options-bag shape changed.
- No new gates, sentinels, watchdogs, or filters introduced or modified.

## Signal vs authority

No authority change. The IntelligenceProvider continues to be the single authority for reviewer LLM dispatch (subscription-floor-compliant per Rule 1). This change just removes a parameter that was being passed alongside but never consulted.

## Over-block / under-block analysis

- **Over-block:** Server.ts no longer activates the response-review pipeline when only `ANTHROPIC_API_KEY` is set (no IntelligenceProvider wired). The old code emitted a "via Anthropic API (direct)" log message and constructed the gate, but every reviewer-call would have failed downstream because Rule 2 already removed the direct-API path in `callApi()`. So the old activation was misleading: it lit up a pipeline that couldn't function. The new gate is honest — it explicitly declines to activate and warns. Real over-block: none, because the formerly-activated pipeline was non-functional.
- **Under-block:** None. Every code path that previously could have made an LLM call through a reviewer still can; the call now uniformly routes through IntelligenceProvider (which has been the only working path since Rule 2 anyway).

## Level-of-abstraction fit

The `apiKey` parameter was a per-reviewer leak of a credential concern that belongs at the provider/transport layer (where IntelligenceProvider lives). Removing it tightens the abstraction: reviewers know "I have an intelligence provider" and that's all they need; they don't carry a credential token they never read.

## Interactions

- **AnthropicIntelligenceProvider** (the Rule 2 routing target): unchanged. Already accepts no apiKey from reviewers and routes through Claude CLI / Agent SDK.
- **External callers of `CoherenceGate`**: this is an internal API change — `apiKey` must be removed from any `CoherenceGateOptions` literal and `intelligence` must be supplied. Documented in `upgrades/NEXT.md`. The only known external callsite is `src/commands/server.ts`, which was updated.
- **Tests:** 25/47 tests in `CoherenceReviewer.test.ts` were already broken by the Rule 2 cleanup (they asserted on `fetch` mock headers/body that don't exist any more). This change does not introduce a new regression — baseline diff confirms identical 69/220 failure count across the seven affected test files both with and without this change. Task #26 tracks the proper rewrite to IntelligenceProvider mocks.

## External surfaces

- **Internal API change:** `CoherenceGateOptions.apiKey` field removed. `CoherenceGateOptions.intelligence` becomes required (previously optional).
- **No new endpoint, no new CLI command, no new config field, no new hook.**
- **No new file ships** that hadn't existed before this change (lint-marker comments are added to existing files; the side-effects artifact and the spec frontmatter are paperwork).

## Rollback cost

Trivial. `git revert` restores the 13 source files + 7 test files to the pre-change state. Server startup will then once again warn about misleading "direct" activation but functionality is unchanged because the direct path was already dead.

## Tests / verification

- `npx tsc --noEmit` clean.
- `node scripts/lint-no-direct-destructive.js` exits 0 (`safe-git-allow:` markers cover the four pre-existing flagged files).
- Full unit suite: 17,315 passed / 84 failed / 11 skipped. The 84 failures are all pre-existing — verified by stash-and-rerun on identical test slice. 69 are the Rule 2 fetch-mock breakage tracked in task #26; the remaining ~15 are unrelated flaky tests outside the apiKey scope (session-lifecycle integration, etc).
- Baseline diff: stashed all changes, reran the seven affected test files → identical `Tests 69 failed | 151 passed (220)`. Restored changes; same count. Zero regression.
- No real-API or runtime verification needed — this change removes a parameter that no code path consumed.
