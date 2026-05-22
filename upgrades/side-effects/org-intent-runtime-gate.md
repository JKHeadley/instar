# Side-effects review — org-intent runtime gate (Phase 1)

Spec: `docs/specs/ORG-INTENT-RUNTIME-GATE-SPEC.md`
ELI16: `docs/specs/ORG-INTENT-RUNTIME-GATE-SPEC.eli16.md`
Phase: 1 of 4 (this PR). Phases 2-4 (session-start injection, tradeoff helper, drift detection job) are queued.

## Surface map

| Change | File | Type |
|---|---|---|
| `OrgIntentReviewContext` interface + `ReviewContext.orgIntent` field | `src/core/CoherenceReviewer.ts` | Type extension (additive, optional field) |
| `OrgIntentManager.parse()` wired into `loadValueDocs()` | `src/core/CoherenceGate.ts` | Behavior change (structured parsing replaces flat extraction for `ORG-INTENT.md` only) |
| Reviewer prompt rewrite with three-rule contract | `src/core/reviewers/value-alignment.ts` | Behavior change (prompt content) |
| Criticality auto-promotion for value-alignment when ORG-INTENT has constraints | `src/core/CoherenceGate.ts` | Behavior change (failure-mode handling) |
| CLAUDE.md template: ORG-INTENT runtime subsection | `src/scaffold/templates.ts` | Doc change (fresh agents) |
| CLAUDE.md migration: ORG-INTENT runtime subsection patched into existing files | `src/core/PostUpdateMigrator.ts` | Migration parity (existing agents) |
| Tier 1 unit tests | `tests/unit/CoherenceGate.test.ts`, `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` | Test addition |
| Tier 2 integration test | `tests/integration/coherence-gate-org-intent.test.ts` | Test addition |
| Tier 3 E2E lifecycle test | `tests/e2e/org-intent-runtime-lifecycle.test.ts` | Test addition |

No new agent-installed config keys. No new hooks. No agent-installed code changes — the runtime wiring is entirely in instar source. Migration is to `CLAUDE.md` only.

## Over-block analysis

**Could the new wiring block messages that previously passed?**

Yes — that is exactly the intended effect for agents with an authored `ORG-INTENT.md`. The behavior change is: constraints written in `ORG-INTENT.md` now actually block outbound messages that violate them. Prior to this change, the same agent with the same file would have let those messages through.

For agents without an `ORG-INTENT.md`, behavior is unchanged. The structured-intent path is gated on `OrgIntentManager.parse()` returning non-null; absent, template-only, or unparseable files return null and fall back to the legacy flat-blob path (which itself is what shipped before).

**Could the criticality auto-promotion over-block?**

The promotion only affects timeout behavior. Specifically: when `value-alignment` reviewer TIMES OUT on an external-facing message AND `ORG-INTENT.md` has at least one constraint, the gate fails closed instead of falling open. Pre-change behavior: a timeout on `value-alignment` led to `ALL_ABSTAIN` or `WARN_ONLY`, which fell open for internal channels and queued/fail-closed for external depending on config. Post-change behavior: external timeout under this condition triggers `HIGH_CRIT_TIMEOUT` which fails closed.

Net effect on operator: slightly higher rate of "Review system unavailable" responses on external channels under reviewer-timeout stress, instead of unreviewed messages slipping through. Override available: explicit `config.reviewerCriticality['value-alignment'] = 'standard'` restores prior behavior.

**Could the migration over-write user-customized CLAUDE.md content?**

No. Both insertion paths use content-sniff guards (`!content.includes('ORG-INTENT.md (Organizational Intent at Runtime)') && !content.includes('Organizational Intent at Runtime')`). The migration is purely additive — it inserts before an anchor (`**Topic-Project Bindings**`) when present, falls back to appending when absent, and skips entirely when the subsection is already present. Re-runs are idempotent (verified by unit test).

## Under-block analysis

**What does the new wiring NOT catch?**

- **Semantic constraint violations the reviewer LLM does not detect.** The reviewer relies on the LLM (`sonnet` by default) to recognize when a draft message violates a written constraint. A subtle violation — say, hinting at internal pricing without quoting a specific number — may slip through if the LLM does not connect the constraint to the draft.
- **Constraint scoping**: the current model treats all constraints as universal. There is no way to say "this constraint applies only to external contacts." Phase 3 may add channel/recipient scoping.
- **Tradeoff hierarchy use outside the reviewer**: only the value-alignment reviewer consults it. Code paths that make decisions (research agents, planning) cannot ask the hierarchy for a tiebreaker yet. Phase 3 adds a tradeoff helper API.
- **Drift accumulation**: a stream of messages each individually passing review can collectively drift from organizational intent. Phase 4 adds periodic drift detection.

**What if ORG-INTENT.md is mutated after the gate boots?**

The 60-minute `ValueDocCache` TTL means edits do not take effect until cache expiry (or process restart). This is documented in the Phase 4 E2E test (`cache-stale` case) so a future refactor cannot silently break the invariant. A future improvement (Phase 2 or 3) may add fs.watch-based invalidation.

## Level-of-abstraction fit

The runtime wiring lives in `src/core/CoherenceGate.ts` and `src/core/reviewers/value-alignment.ts` — the right layer. The parser already lived at `src/core/OrgIntentManager.ts`; this change connects the two at the layer that actually evaluates outbound messages.

The migration lives in `src/core/PostUpdateMigrator.ts` — the right layer for changes that need to propagate to existing agents.

No new abstractions introduced. The change adds one new type (`OrgIntentReviewContext`), one new private method (`resolveCriticality`), and one new helper function (`formatOrgIntent`) — all minimal and proportional to the work.

## Signal-vs-authority compliance

This is the right place in the stack for ORG-INTENT enforcement. The Coherence Gate is the authoritative pre-delivery review for outbound messages. The reviewer prompt explicitly distinguishes:

- **Constraints** → AUTHORITY: severity MUST be `block`. The reviewer is told to block constraint violations.
- **Goals** → mixed: contradictions warn or block depending on severity. The reviewer has discretion.
- **Values** → SIGNAL: drift warns. Not authoritative.
- **Tradeoff hierarchy** → SIGNAL feeding AUTHORITY: it tells the reviewer how to resolve ties; the reviewer is still authoritative on the verdict.

Lower-precision signals (e.g. deterministic keyword scans in the PEL) could be added later for blatant constraint violations, but those would be signals; the reviewer remains the authority. Per `feedback_signal_vs_authority` from agent memory.

## Interactions with existing systems

| System | Interaction | Risk |
|---|---|---|
| `value-alignment` reviewer (existing) | Prompt rewritten; receives `orgIntent` field in context | Low — prompt change tested at all three tiers |
| Other reviewers (existing) | No change | None |
| `loadValueDocs` cache | Extended to include `orgIntent` field | Low — additive |
| `ValueDocCache` TTL | Unchanged (60 minutes) | Documented; locked in by E2E test |
| Legacy `orgValues` flat blob | Still loaded and passed to reviewers | None — backwards compatible |
| Custom reviewers reading `context.orgValues` | Still work as before | None |
| `instar intent` CLI surface (existing) | Unchanged | None |
| `/intent/org`, `/intent/validate` HTTP routes (existing) | Unchanged | None |
| PostUpdateMigrator other migrations | New migration is independent | None |
| Husky pre-push tone-gate / version-gate | Should pass — new content has Evidence section, version bump is minor | Verified by full-suite run before push |

No other instar systems consume `ORG-INTENT.md`. The structured parser was a one-purpose primitive used only by the offline analyzer CLI and now by the gate.

## Rollback cost

Low. The legacy flat-blob path (`extractValueSection` → `orgValues`) is retained and still passed to reviewers. Three options:

1. **Code revert**: `git revert <PR-merge-sha>` restores prior behavior. Tests will fail until the new test files are also removed, but production behavior reverts cleanly.
2. **Soft revert via reviewer config**: explicitly set `config.responseReview.reviewers['value-alignment'].mode = 'warn'` to demote constraint violations from `block` to `warn`. This restores most of the prior behavior without reverting code.
3. **Soft revert via criticality config**: explicitly set `config.responseReview.reviewerCriticality['value-alignment'] = 'standard'` to undo the timeout-fail-closed change without touching the rest.

No data migration to roll back. No file format changes. No agent-installed code changes.

## Test coverage summary

| Tier | File | Tests | Status |
|---|---|---|---|
| 1 (unit) | `tests/unit/CoherenceGate.test.ts` (new describe block) | 5 | ✓ passing |
| 1 (unit) | `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` | 5 | ✓ passing |
| 2 (integration) | `tests/integration/coherence-gate-org-intent.test.ts` | 4 | ✓ passing |
| 3 (E2E lifecycle) | `tests/e2e/org-intent-runtime-lifecycle.test.ts` | 4 | ✓ passing |

All three tiers exercise the same parser + gate + reviewer + HTTP route + production wiring, with each tier proving a different layer of the invariant.

## Open follow-ups (deferred to later phases, NOT this PR)

- Phase 2: Inject parsed intent at session-start (alongside identity/topic context).
- Phase 3: Standalone `POST /intent/tradeoff-resolve` helper consulted by non-reviewer code.
- Phase 4: Periodic drift detection job sampling recent outbound actions vs intent.
- Cache invalidation on `ORG-INTENT.md` mutation (fs.watch or signal-based).
- Per-channel constraint scoping (some constraints external-only, others universal).
