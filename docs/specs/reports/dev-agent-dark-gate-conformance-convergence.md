# Convergence Report — Dev-Agent Dark-Gate Conformance Guard

## ELI10 Overview

Instar runs some features "dark" (off for everybody) except on development agents
like Echo, where they run live so we can try them out before flipping them on for
everyone. The rule for doing that is simple: don't bake an on/off value into the
defaults — let the code decide at startup ("on for a dev agent, off otherwise,
unless an operator says otherwise"). A recent feature broke that rule by hardcoding
"off," which accidentally turned it off *everywhere* — even on dev agents. A human
caught it in review; no automated check did.

This change adds that missing automated check. It introduces one shared helper that
every dev-gated feature uses to decide on/off, and a CI lint that fails the build if
someone hand-writes that decision instead of using the helper, or hardcodes "off" in
a config block that's clearly meant to be dev-gated. It does NOT change how anything
behaves at runtime — it's a safety net for developers. It also can't catch the case
where a developer forgets the gate entirely with no hint of intent; that's left to a
tracked follow-up (a feature registry + a both-sides startup test).

## Original vs Converged

The original spec proposed the helper + a two-part lint and claimed assertion B
"catches the #1001 shape directly." Review proved that was false in a dangerous way:
the lint's first implementation scanned only 8 lines after a marker comment, but the
real feature that caused the bug (the growth analyst) has a ~10-line comment — so a
re-introduced "off" on that exact block was **silently missed**. The guard would have
no-op'd on its own origin case. The converged version replaces the fixed window with
proper brace-matching (it scans the whole config block regardless of comment length),
and an empirical test now confirms it catches a regressed "off" on the real growth-
analyst block. Review also found an 11th hand-written gate site (using `Boolean(...)`
instead of `!!`) that the first pass missed and the lint's regex didn't catch — both
fixed. Finally, the spec's overclaiming language was softened to match what the guard
honestly does and does not catch (it catches the bug shape only when the block carries
a dev-gate marker; a markerless forgotten gate is explicitly a later layer's job).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec/impl changes |
|-----------|-----------------------|-------------------|-------------------|
| 1 | lessons-aware, adversarial, integration | 3 | (a) Assertion B fixed-window missed the real growthAnalyst block → brace-matched scan; (b) 11th un-migrated site `routes.ts` `Boolean(...)` form → migrated + regex broadened to `!!`/`Boolean(`/bracket; (c) spec overclaims ("catches #1001 directly", "only legal path") → softened; added regression self-tests |
| 2 | lessons-aware, adversarial | 0 | minor disclosure clause added (marked-but-non-literal `?? false` → Layer 3/4) |
| (converged) | — | 0 | none |

Security and scalability reviewers reported no material findings in round 1 (the
guard fails safe — every gap errs toward dark-on-fleet, never wrongly-live; the lint
scan is ~0.3s with no regex-backtracking risk).

## Full Findings Catalog

### Iteration 1

- **[HIGH · lessons-aware + adversarial, empirically confirmed] Assertion B fixed 8-line window missed the origin case.** Injecting `enabled: false` into the real growthAnalyst block reported "clean" because its ~10-line marker comment pushed the field past the window. P1/P14/L7 violation (a guard that no-ops on its own origin incident). **Resolution:** replaced the fixed window with brace-matched block scanning (`BLOCK_OPEN_SEARCH` + depth tracking, `BLOCK_MAX_LINES` bound); added a ≥10-line-comment regression self-test; re-test now catches it; real tree stays clean.
- **[HIGH · integration] 11th un-migrated site + regex blind spot.** `src/server/routes.ts` used `?? Boolean(ctx.config.developmentAgent)` (the self-knowledge route) — missed by the `!!`-only first-pass grep and not matched by the lint. **Resolution:** migrated to `resolveDevAgentGate`; broadened assertion A's regex to also match `Boolean(...)` and `['developmentAgent']` bracket access; added a `Boolean(...)` self-test.
- **[HIGH/LOW · adversarial] Spec oversold the guard.** "Catches the #1001 shape directly" (the literal bug had no marker → not caught) and "the funnel is the only legal path" (A bans spellings, not arbitrary aliases). **Resolution:** softened to "catches the #1001 shape *when the block is gate-marked*" and "the only sanctioned path *for the realistic spellings*"; Layer-1 misses now name alias/wrapper, Layer-2 misses name the markerless default.
- **[none · security]** No exposure risk — every lint gap fails toward dark-on-fleet; shipping live still requires explicit `enabled: true`/`developmentAgent: true`, which the lint never suppresses. The helper is a behavior-identical extraction. Note: `developmentAgent` is a convenience gate, not a security boundary (pre-existing; relevant to the Slice-2 registry).
- **[none · scalability]** Full-tree scan ~0.3s over ~1150 files; all regexes backtracking-safe; `--staged` correctly scopes pre-commit; helper is O(1).
- **[LOW · lessons-aware] CMT-1253 should enumerate the deferred Slices 2/3** rather than a generic "build a guard." Non-blocking honesty note (Close-the-Loop).

### Iteration 2

- **[none material] Both reviewers returned CONVERGED.** F1 empirically confirmed fixed (brace-match catches the growthAnalyst injection; real tree clean; nested-brace and sibling-block edge cases handled without false positives). Assertion A now catches `Boolean(...)`/bracket forms; bare alias still (correctly, by disclosure) not caught. Spec language honest.
- **[non-material, disclosed] `enabled: <expr> ?? false` under a marker** and `\bgate\b` not matching `gated` — both within the disclosed Layer-2 boundary. Added a Layer-2 misses clause for the non-literal `?? false` case.

## Convergence verdict

Converged at iteration 2. No material findings in the final round (both the
mandatory lessons-aware reviewer and the adversarial reviewer returned "CONVERGED",
each with empirical re-tests). The spec is honest about what each layer catches and
misses, the implementation is verified (tsc clean, full `npm run lint` clean, 15
unit tests incl. the F1 regression), and the deferred layers are tracked (CMT-1253).
Ready for user review and approval.
