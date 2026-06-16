# Convergence Report — MergeRunner Auto-Arm Handoff

## ⚠ Cross-model review: DEGRADED — gemini-cli:gemini-2.5-pro (degraded: timeout)

The external (non-Claude) reviewer pass was ATTEMPTED via the agent's `gemini` CLI (gemini-2.5-pro) but **timed out** — so this spec converged on the six internal Claude reviewers + the constitutional conformance gate, **without a completed external opinion**. (codex is not installed on this machine; gemini is installed + authed but the call did not return within the timeout.) Read this before applying `approved: true`: the cross-model assurance is reduced. The internal review was unusually rigorous (3 rounds, 6 lenses, every finding ground-checked against real file:line), which partly offsets it, but a clean external pass was not obtained.

## ELI10 Overview

Echo has a background watcher that merges its own pull requests once they're green, so nobody has to click "merge." Today the watcher does this by running a merge command and *standing there watching it finish* inside a time-boxed helper process. This spec changes it to instead **flip on GitHub's built-in "auto-merge" switch and walk away** — GitHub then merges the PR itself the moment every required check passes, and the watcher checks back on a later tick to record that it landed.

The honest payoff turned out to be more modest than the first draft claimed (the original premise — "the watcher waits 25 minutes for slow CI and gets killed" — was simply wrong; the watcher only ever acts on already-green PRs). The real wins are: it frees the watcher's single-work slot in seconds instead of holding it for up to 25 minutes, and it survives the watcher's own merge triggering a server restart (GitHub owns the merge, so a restart can't kill it).

The tradeoff the review forced into the open: GitHub's auto-merge merges whatever is at the PR's head when checks go green, so a later push by someone with write access could merge code the watcher didn't vet — the spec now documents this residual race honestly and adds a post-merge check that flags a merge at an unexpected commit. And because GitHub now owns the merge, the operator's "stop everything" button has to actively *un-arm* each in-flight PR (the spec wires that in), since just pausing the watcher no longer stops a merge GitHub already promised to do.

## Original vs Converged

**Originally** the spec justified the change with a wrong diagnosis (the watcher being killed waiting on slow CI) and claimed GitHub auto-merge was "stricter than the old admin path" across the board. Review proved both false: the watcher only acts on green PRs (so it never waits on CI), and the head-pin that protected the old path does NOT carry through GitHub's auto-merge for write-capable pushes.

**After convergence** the spec: (1) states the real, modest value (lease-slot freeing + restart survival), grounded in the `classifyCandidate` settled-green gate; (2) splits the "stricter" claim honestly — stricter on *required-check enforcement* (GitHub enforces; admin bypassed), NOT on the *head-pin*, with a documented residual race + a post-hoc "merged at an unexpected head" detector; (3) makes the operator's kill switch actually reach in-flight merges by calling `gh pr merge --disable-auto` on armed PRs from the rollback/pause routes in-line; (4) makes GitHub's own `autoMergeRequest` field the cross-machine source of truth for "already armed" so a lease move doesn't re-arm or strand a PR; (5) replaces a silent 24-hour "give up watching" with an `armed-overdue` state that keeps reconciling and re-surfaces; and (6) bounds every new non-terminal state (the confirm-gap counter, the non-ladder retry classes) so nothing can spin invisibly. The B10 honesty invariant ("a merge is only recorded after an independent MERGED read") is preserved exactly, just moved to a later tick.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes | Cross-model |
|-----------|-----------------------|-------------------|--------------|-------------|
| 1 | lessons (premise), security, scalability, adversarial, integration | wrong premise + 5 blockers + materials | (initial findings captured) | unavailable (dist not built) |
| 2 | adversarial (2 "blocker"+3 mat), integration (2), lessons (2); security + decision-completeness CONVERGED | 5 material (wiring-precision) | full rewrite: disarm-reach, armed-exclusion, autoMergeRequest-source-of-truth, armed-overdue, fail-open, field-state, head-pin honesty + mismatch detection | gemini attempted → **degraded (timeout)**; conformance 0 flags |
| 3 | adversarial (1 mat: auto-merge-unavailable discriminator); integration/lessons CONVERGED | 1 material | precise round-3: in-route `disarmAllArmed`, B10-line protection, `listOpenPrs` projection widening, `unconfirmedArmAttempts` bound, bulk-disarm honest-failure, squash-precision head compare, content-sniff migration, config-threading, #539-guard doc | conformance 0 flags |
| 3-final | adversarial re-check of the one fix → RESOLVED | 0 | safe-merge emits distinct `refused:auto-arm-unavailable` slug; orchestrator keys terminal-non-ladder on it; fail-open preserved | — |

## Full Findings Catalog

**Round 1** (captured in `mergerunner-auto-arm-handoff-round1-findings.md`): wrong premise (the MergeRunner only acts on settled-green PRs) + 5 blockers (head-pin binding, re-arm thrash, disarm reach, multi-machine stranding, ceiling silent-drop) + materials (UNKNOWN fail-open, armTimeoutMs, episode field-state, config defaults, observability).

**Round 2** (all Round-1 blockers verified resolved by the rewrite): A — disarm execution path unwired (routes set a latch, tick is latch-gated); B — B10 line `:452` would corrupt `armed`; C — `autoMergeRequest` belt had no `gather()` projection; D — `auto-arm-unconfirmed` could spin untracked; E — bulk-disarm `--disable-auto` failure = silent strand; M1 — CLAUDE.md awareness migration skips existing agents; M2 — config-threading not enumerated; #539-guard not named; squash `mergeCommitOid` comparison would false-fire on every clean squash.

**Round 3** (all Round-2 findings verified resolved): one new material — `auto-merge-unavailable` terminal-non-ladder relied on a discriminator absent from safe-merge's structured output (repo-disabled and transient both emit `error:merge-command-failed`).

**Round 3-final**: the discriminator made real — safe-merge emits a distinct `refused:auto-arm-unavailable` slug on a stderr match (regex verified against the real gh GraphQL error string); orchestrator keys terminal-non-ladder only on that slug; all other refusals stay normal-refusal-backoff (fail-open preserved). RESOLVED, 0 new material.

## Convergence verdict

**Converged at iteration 3 (final re-check).** No material findings remain in the final round across all six internal lenses + the constitutional conformance gate (0 flags). The external (gemini) pass degraded on timeout — recorded loudly above; convergence rests on the internal rounds. The spec is design-sound, every decision is frontloaded (`## Open questions` = `*(none)*`), and it is ready for `/instar-dev` build (reaper/merge-class — Phase-5 second-pass REQUIRED at build time). The change is honest about its modest value and its one accepted residual risk (the write-capable-push head race, surfaced via post-hoc detection).
