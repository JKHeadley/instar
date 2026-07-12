# Convergence Report — Duplicate-Build Guard

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in every round (rounds 1–5). The final external verdict was "MINOR ISSUES" (operational-polish only), and every material finding it raised across the rounds was resolved. This is the clean RAN state.

## ELI10 Overview

Sometimes the agent (or two of its sessions running at once) starts building a feature that is *already being built* somewhere else — under a different ticket — and nobody notices until the two collide at merge and a whole session of work is wasted. That happened on 2026-07-12 (ACT-562 duplicated the already-merged #1458). This spec is a small tool that catches that collision **at the start of a build, before the work is spent**, instead of at the end.

It works by asking three "is anyone else on this right now?" questions before the agent writes any code: is another session on this machine already building the same thing (a little on-disk "I'm building X" note), is an open pull request adding it, and did a pull request merge it very recently. If so, the agent has to stop and record *why* it's proceeding before it can write the first line of code — enforced by a hook, not a reminder. It never blocks your `git push`; the teeth are that the agent must look and record, and the check gets out of the way (proceeds) if it ever errors, so a broken guard can never wedge a build.

## Original vs Converged

The first draft was fundamentally broken in a way the review caught and the rewrite fixed:

1. **It checked the wrong thing.** v1 checked whether the work was "already finished on `main`." But in the real incident the substrate was being *created inside* the other pull request — so that check would have said "all clear" and the duplicate would have proceeded anyway. **Converged:** the primary signal is now *concurrency* — who is *building or just-built* this right now (a local sibling-session ledger + open PRs + a recently-merged lookback), not who has *finished* it on main.

2. **Its enforceable layer was too late.** v1's only structural gate ran at `git push` time — after the entire build was already spent, i.e. essentially the moment the incident already caught it. Its only *timely* layer (a build-start advisory) was skill-prose the agent could skip. **Converged:** the primary catch is now a `PreToolUse` hook that fires on the *first code-writing tool call* and blocks it until the agent records a disposition — so implementation literally cannot begin before the duplicate is confronted. Precommit is a presence-only backstop; pre-push is advisory-only.

3. **It could not catch its own incident geometry** (two same-machine sessions, neither PR open yet). **Converged:** a local sibling-session ledger (write-first-then-scan, liveness by pid+start-time+worktree, terminal cleanup) catches exactly that case; the honest residual (two *different* machines before either PR exists) is a stated known false-negative with a tracked follow-up.

Security hardening (argv-safe git/gh, type-based arg validation, untrusted-output clamping, byte caps against a push-path DoS, ledger path-jailing) and fail-open totality (any error → non-blocking + exit 0, reconciled with the precommit presence-gate via a visible `check-errored` stub) were added through the review. Every out-of-scope item was given its own durable tracked action (ACT-594/595/596/600), not filed under the parent, so nothing rots when this ships.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons, codex | ~20 (incl. the self-refuting "would have caught the incident" claim) | Full redesign → concurrency-first + structural early catch (v2) |
| 2 | adversarial, lessons, security, codex | ~10 (ledger TOCTOU, PID-reuse, precommit-too-late, fuzzy determinism, ledger lifecycle, byte-caps) | v3 — build-start stop-hook, ledger invariants, bounded Jaccard, ledger hardening, total ladder, separate tracked ACTs |
| 3 | adversarial, lessons, codex | 2 (§3.3/FD2 contradiction; stop-hook intercept boundary) | v4 — concrete PreToolUse gate, FD2 fix, exact gh calls, agent-home jail, cause precedence |
| 4 | codex | 5 (disposition schema, gate scope, fail-open/precommit contradiction, type-validation, ledger claim) | v5 — check-errored stub, broadened gate scope, disposition schema, type-based validation, narrowed claim |
| 5 | codex | 5 (test/spec inconsistency, phrasing, shell-mutation residual, check-errored surfacing, Jaccard calibration) | v6 — aligned §4, honest phrasing, shell residual, precommit check-errored warning, calibration test |
| 6 (convergence) | adversarial: CONVERGED (material: none); lessons: CONVERGED (all principle checks pass) | 0 | ACT-600 tracking-id repoint (the one non-blocking hygiene nit) |

## Full Findings Catalog

The load-bearing findings and their resolutions (severity: M = material):

- **[M, adversarial R1] The v1 detector would NOT have caught its own origin incident** (census born inside #1458's PR; "wired-on-main" yields `clear`). → Re-centered on concurrency signals; §0 carries the git-SHA correction; E2E fixture reproduces the real geometry.
- **[M, lessons R1/R2 + codex] The "structural" layer fired at pre-push/precommit, after the build was spent; the timely layer was willpower.** → §3.4 build-start `PreToolUse` gate on the first mutating write; precommit demoted to presence-only backstop; honest residual paragraph.
- **[M, adversarial R2] Ledger write/scan TOCTOU; PID-reuse staleness; unbounded/never-swept ledger; concurrent-read integrity.** → §3.2 write-first-then-scan (earliest-startedAt wins, lexicographic tiebreak); liveness = pid ∧ procStartToken ∧ worktree-exists; terminal removal + compaction/boot sweep; line-by-line parse, torn-line-on-substrate → verify.
- **[M, security R1/R2] Command/option-injection; untrusted gh/PR + ledger output; git-grep oracle; fuzzy DoS byte-caps; gh interactive-hang/stderr-leak.** → §3.2a: argv-safe SafeGitExecutor/spawnSync, type-based validation, pathspec-scoped grep + line clamp, untrusted-output clamping, byte caps before similarity, non-interactive gh + generic errors, ledger path-jail + mode-0600.
- **[M, decision-completeness R2] Open questions unresolved; hidden verdict-ladder decision; acknowledge mechanism; fail-open-on-error.** → All 3 open questions → FD1–FD6; the ladder is the frontloaded scoring rule; disposition schema `{decision,reason,acknowledgedEvidenceIds[]}`; FD5 fail-open invariant.
- **[M, adversarial/codex R3] §3.3-vs-FD2 WEAK-only contradiction; stop-hook intercept boundary fuzzy.** → FD2 corrected to silent `clear`; the gate is a concrete PreToolUse hook on the first implementation write (not turn-exit).
- **[M, codex R4] Fail-open vs precommit-presence contradiction; gate scope only src/tests; disposition-as-checkbox; over-broad leading-dash reject; ledger claim breadth.** → `check-errored` auto-stub reconciles fail-open with presence (precommit warns loudly); gate covers any tracked path except trace/state; required evidence for a likely-duplicate proceed; type-based validation; same-agent-home scope narrowed.
- **[polish, codex R5 / lessons] Test/spec language alignment; shell-mutation residual; Jaccard calibration corpus; Close-the-Loop tracking-id hygiene.** → §4 aligned; shell residual stated + ACT-600; calibration test in FD6/§4; each deferral on its own ACT (594/595/596/600).

Signal-vs-Authority was verified to hold end-to-end: no detector gains a stand-alone block path; the precommit gate is presence-only (accepts `disposition:"proceed"` on a likely-duplicate — a structural field-validator, never a meaning-authority); pre-push is `warnings[]`-only; the irreversible-action carve-out correctly does NOT apply (a duplicate build is recoverable).

## Convergence verdict

Converged at iteration 6. Both gating internal reviewers (adversarial, lessons) independently returned CONVERGED with zero material findings, having verified the five load-bearing invariants against real source (`SafeGitExecutor.readSync`, `PreToolUse` file-write matchers, the precommit trace-field validator, and the pre-push warnings/errors split all exist and behave as the spec assumes). The final external (codex/GPT-5.5) pass reached operational-polish-only ("MINOR ISSUES"), the asymptotic tail; all its material findings across the rounds were resolved. `## Open questions` is empty (`*(none)*`). The spec is ready for user review and approval.
