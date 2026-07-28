# Convergence Report — Autonomous Scope-Accretion Completion Discipline

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in rounds 1, 2, 4,
5, 6, and 7 (round 3's external batch degraded on a launcher error and the round is
covered by its three internal panels); gemini-2.5-pro passes succeeded in rounds 1,
2, 5, 6, and 7 (two mid-ceremony timeouts recorded as degraded). The spec received
real cross-model review in six of seven rounds — the clean RAN state.

## ELI10 Overview

When one of the agent's long autonomous work sessions invents new deliverable work
that clearly belongs to its mission — a spec, an audit, a runbook, a script — that
work can no longer be quietly shelved. The server (not the session) watches what
deliverable files actually appear in the run's repositories via git, checks at
"done" time whether each was genuinely built or delivered, and refuses completion
until each one is built, explicitly deferred by the operator, or abandoned LOUDLY
with a notice naming exactly what was left undone. Deferral requires the real
operator: a reply to a server-authored message listing the exact artifacts, or one
tap on the PIN-gated dashboard.

The design's central discipline: nothing the session itself writes is trusted. Not
its transcript (it authors it), not its tool events (shell writes bypass them), not
its state file or config (it edits them), not any message file on disk (it could
append to it). The two trusted inputs are git history/status in the run's
repositories, and the server's own records of messages it received live from
Telegram.

## Original vs Converged

Originally, the design read the session's transcript for evidence of new work and
for quoted operator approval. Review killed that twice over: artifacts created
early scroll out of the visible window, and a session can print a fake approval.
The second design tracked file-write tool events into a local ledger with the
config snapshot in the run's state file. Review broke every piece of that: shell
heredocs never produce Write events (and the deployed event stream doesn't even
carry file paths), the ledger/state file/hook are all session-writable, and the
"operator ratified" flag traveled as a client-supplied boolean.

The converged design moved everything load-bearing server-side: a new run
registration route snapshots the mission, deadline, work roots, and declared
deliverables; a git-truth sweep at the completion chokepoint (SHA-anchored, live
worktree enumeration, porcelain-mapped) computes what accreted; corroboration is
typed attestations (ceremony report backed by server-recorded conformance-gate
invocations, or a merged PR with real non-docs implementation — never a
self-writable stamp); ratification is matched only at the server's live Telegram
receive path (no file a session could forge a "yes" into) with reply-anchored,
set-exact confirmations; and EVERY exit surface — including duration expiry and
the emergency stop — enumerates unbuilt accreted work loudly. A persisted breaker
(K=3) plus the untouched duration ceiling guarantee no run can ever be wedged.

The honest guarantee, named precisely in the spec: silent deferral is structurally
impossible; loud abandonment after three blocks remains possible — the ceiling for
a machine that cannot compel work.

## Iteration Summary

| Round | Reviewers | Material findings | Spec changes |
|---|---|---|---|
| 1 | 6 internal + codex(MINOR) + gemini(CLEAN) + conformance gate (3 flags) | ~10 | Deterministic core rewrite: tool-event ledger + verified-operator ratification; transcript layers demoted (R1-R10) |
| 2 | 6 internal + codex(MINOR) + gemini(MINOR) + gate (3 flags) | 23 deduped | Server-side git-truth core; no client-transported blocking inputs; display-integral ratification; per-class corroboration; deletion-never-clears; deterministic pre-judge gate; breaker K=3 (R11-R29) |
| 3 | 3 combined panels + externals (degraded batch) + gate (0 flags, fit) | 10 deduped | POST /autonomous/register defined; live root derivation + worktree enumeration; server-resolved arming; registered-condition authority; reply-anchored confirmation; server-recorded ceremony evidence; exact merged-PR predicate; every-exit-loud (R30-R40) |
| 4 | combined panel + codex(SERIOUS) + gemini(degraded) | 4 | Run lifecycle normative (endAt/terminality); run-end trigger wired incl. emergency stop; receive-path ratification declared; honest guarantee rename; evidence-source separation (R41-R47) |
| 5 | panel + codex(SERIOUS) + gemini(MINOR) | 1 | R45 completed at all five stale sites; attribution scope R48; typed-attestation framing; honest tagline |
| 6 | panel + codex(SERIOUS) + gemini(SERIOUS) | 0 (panel CONVERGED) | Round-7 polish: register authority boundary R49; depends-on descriptor; dashboard link; commits-not-branches |
| 7 | confirm panel + codex(SERIOUS) + gemini(MINOR) | 0 — CONVERGED | none |

Standards-Conformance Gate: ran in rounds 1, 2 (3 possible-violations each, all
resolved by round 3) and round 3 (zero findings, parent-principle fit). Rounds 4-7
rode the round-3 clean result plus the panels' explicit standards checks.

## External re-litigations, dispositioned (read this before approving)

The round 6-7 external SERIOUS verdicts contain no unaddressed defects; they
re-argue design decisions the ceremony made deliberately. Recorded here so the
approval is informed:

- **"Use a workflow engine / message queue" (gemini):** contradicts instar's
  file-based, no-database design decision #1. Standing architecture, not a defect.
- **"Merged-PR predicate is a weak proxy" (codex, rounds 4-7):** true and NAMED —
  the spec frames it as a deterrence bound (§6), with the ceremony-record arm and
  operator ratification as the stronger attestations. Accepted trade.
- **"All-branches attribution over-attributes" (codex):** narrowed in R48
  (run-owned roots only; commits not branches; shared root HEAD-only); the residual
  false-hold direction is breaker-bounded and safe. Accepted trade.
- **"Taxonomy too narrow for 'scope accretion'" (codex/gemini):** accepted
  explicitly in R47 — v1 is a deliverable-document/script discipline; the title
  was renamed to the honest guarantee.
- **"Make PIN/dashboard the only ratification path" (codex):** the conversational
  path was kept because Telegram IS this operator's real approval channel; the
  receive-path-only mechanism (R45) removed the forgery surface, and the
  enumeration carries the one-tap dashboard link as the ergonomic alternative.
- **"A session that never registers is ungated" (codex):** registration runs in
  the operator-side setup flow before the session exists; a process that skips the
  entire autonomous discipline has no stop hook or state file either — that bound
  belongs to the foundation (the CD apparatus is opt-in structure), not this spec.

## Full findings catalog

The complete per-round findings with resolutions live in the ceremony's commit
trail on branch `echo/u4-mesh-self-healing`: d98295a29 (round-1 fold), 32163b141
(round-2 fold), ba45b16cf (round-3 fold), 7f61f5b67 (round-4 fold), 9dc19f012
(round-5 fold), ca05e2ec8 (round-7 polish) — each commit message summarizes the
findings it folds, and the R-markers (R1-R49) in the spec body trace every
resolution to its round.

## Convergence verdict

Converged at iteration 7. The round-6 panel found no material findings; the
round-7 confirm panel verified the polish edits and found no material findings; the
round-7 externals raised only dispositioned re-litigations. Zero open questions.
Spec is ready for approval.

Decision-completeness evidence: frontloaded-decisions 12 · cheap-to-change-after
tags 0 · contested-then-cleared 1 (default-ON, cleared in round 1 and re-affirmed
with the R14 operator lever).
