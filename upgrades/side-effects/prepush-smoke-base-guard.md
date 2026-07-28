# Side-Effects Review — Pre-push smoke base resolver and breadth guard

**Version / slug:** `prepush-smoke-base-guard`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `instar-codey second-pass checklist`

## Summary of the change

This change moves the pre-push smoke selection logic into `scripts/pre-push-smoke.mjs` and `scripts/lib/pre-push-scope.mjs`, updates `.husky/pre-push` to use that runner, and adds focused unit tests in `tests/unit/scripts/pre-push-scope.test.ts`. The smoke runner now resolves a branch-appropriate base, logs that base plus changed-file count, lists the affected Vitest set, and skips local smoke when the selected set is too broad. CI remains the authoritative merge gate.

## Decision-point inventory

- `scripts/lib/pre-push-scope.mjs#resolvePrePushBase` — add — chooses which git base local smoke uses for changed-test selection.
- `scripts/lib/pre-push-scope.mjs#evaluateSmokeBreadth` — add — decides whether local smoke is small enough to run locally.
- `scripts/pre-push-smoke.mjs` — add — applies the local-only smoke skip decision before invoking Vitest run.
- `.husky/pre-push` — modify — delegates smoke execution to the runner after best-effort remote fetches.

---

## 1. Over-block

The broad-set guard can skip local smoke for a legitimate branch that changes many files or maps to many tests. That does not block the push or merge; it only declines to run a local smoke subset. The hook prints that CI is the authority, and the PR test matrix still runs before merge.

The resolver can choose a branch upstream or push remote whose `main` is missing or stale. It falls back through canonical remotes, and the hook performs best-effort fetches for those remotes before running the resolver.

## 2. Under-block

This change does not guarantee a local smoke run catches every failure. A branch under the caps may still have failures outside Vitest's changed-test selection. That is an accepted limitation of local smoke; CI remains the full authority.

The runner also skips local smoke if changed-file calculation or affected-test listing fails due to local git/Vitest state. This avoids pathological local blocking but leaves the real failure detection to CI.

## 3. Level-of-abstraction fit

The resolver is a local git-scope helper. The broad-set guard is a deterministic local ergonomics check, not a product or conversational authority. It operates at the pre-push developer-tooling layer where the question is only whether the optional local smoke run is small enough to be useful.

The implementation uses existing git configuration and Vitest changed-test listing rather than adding a new cross-system state source.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Not applicable to conversational/product judgment — this is a local developer-tooling guard that fails open to CI.

This change does hold local skip authority over an optional smoke run, but it does not block user messages, external operations, information flow, or product behavior. It is a fail-open performance guard: when the local set is too broad, it avoids running the local subset and explicitly defers to CI.

## 5. Interactions

- **Shadowing:** The broad-set guard runs before `vitest run`. It can shadow local smoke execution, but it cannot shadow CI because CI is separate and unchanged.
- **Double-fire:** `.husky/pre-push` still wraps `npm run test:smoke` in the existing retry loop. When the runner skips broad smoke, it exits successfully and the retry loop does not repeat.
- **Races:** The runner reads git refs after the hook performs best-effort fetches. Concurrent branch updates could change remote refs during a push, but that risk already exists for local changed-test selection.
- **Feedback loops:** No persistent state is written. The hook does not feed its skip decision back into future runs.

## 6. External surfaces

This affects developers and agents pushing branches from this repository. It changes local terminal output and can reduce local pre-push runtime for broad affected sets. It does not change CI, GitHub PR checks, Telegram messaging, dashboard behavior, persisted ledgers, or external service APIs.

## 7. Rollback cost

Rollback is a pure code revert of `.husky/pre-push`, `package.json`, the new smoke runner/helper files, and tests. No migration, persistent state repair, or user notification is required. The only user-visible regression during rollback would be returning to the older hard-coded local smoke base behavior.

## Conclusion

The review found the main risk is local under-testing when a broad affected set is skipped. That is acceptable because local smoke is not the merge authority, and the skip message makes the authority boundary explicit. The change is clear to ship with focused tests and the instar-dev gate.

---

## Second-pass review (if required)

**Reviewer:** instar-codey second-pass checklist
**Independent read of the artifact:** concur

The second pass agrees that the guard is local-only, fail-open, and does not introduce a brittle product/message blocking authority. The main risk is documented as reliance on CI for broad changes.

---

## Evidence pointers

- `tests/unit/scripts/pre-push-scope.test.ts`
- `scripts/pre-push-smoke.mjs`
- `scripts/lib/pre-push-scope.mjs`
