# Convergence Report — Local Verify: a helper machine keeps working while the coordinator restarts

**Spec:** [docs/specs/local-verify-peer-works-through-restart.md](../local-verify-peer-works-through-restart.md)
**Slug:** `local-verify-peer-works-through-restart`
**Converged at:** 2026-11-18 (round cap, Tier 1)
**Iterations:** 3
**Final-round design findings:** 5, all small. All were applied in one edit at the Tier 1 round cap, without a fourth round. None concerns safety, security or data loss (see Convergence verdict).

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass ran through the codex CLI in all three rounds, on the exact text of each round. A clean-door Anthropic second read (`clean-door-anthropic-review: claude-code:claude-opus-5-5`) also ran each round. It is not counted as cross-model. Gemini was not available (`gemini-not-authed`).

## ELI10 Overview

Two computers test every change before it merges: the Studio, which is in charge, and the M5, which helps. When the Studio restarts for an update, two things waste the M5's time. First, while the Studio waits to restart, it stops handing the M5 work. Second, after the restart, it throws away the run the M5 was in the middle of, because a restarted Studio counts as a new "boss". Measured over 16 to 18 November, that is roughly 105 recoverable M5-minutes a day, about 2 merges a day.

The spec makes three changes, all behind one switch that starts off. While the Studio waits to restart, it may still hand work to the M5. That work does not hold up the restart. After the restart, the Studio keeps the M5's result if no other machine was in charge in between and nothing about the change moved. Whether "no other machine was in charge" is decided by a record the security work (PR 3451) already keeps on disk, not by anything that resets on restart.

The trade-off: the gain is modest, and the build waits for PR 3451 to merge. In return the rules are strict. Any doubt means the result is thrown away, exactly as today, and the switch turns everything off at once.

## Original vs Converged

- **The "no one else was in charge" proof.**
  - Originally: it relied on a `foreignHolder: false` flag plus a new chain of this machine's epochs.
  - After review: it relies on PR 3451's saved holding record, with a new `since` field, and on the fact that every lease acquisition raises the epoch by exactly 1.
  - Why: all six reviewers found that `foreignHolder` lives in memory and is false after every restart. The original proof would have accepted a result even if another machine had been in charge.
- **Right after a restart.**
  - Originally: the first check after boot could cancel the M5's run before adoption had a chance.
  - After review: the attempt waits (no cancel, no import) while the lease is unreadable, unheld or not yet caught up. A read naming another machine abandons it at once. The wait is bounded by the existing 60-minute run limit, which is also when the peer stops on its own.
- **Which restart an attempt is exempt from.**
  - Originally: the restart request's pending time identified the restart.
  - Then: a pause id.
  - Now: a restart-episode id held by the service, minted when an update or planned restart becomes pending and cleared when nothing is pending.
  - Why: the pending time changes partway through an install, and the pause itself flips off and on under one pending restart. That happened in 18 of 85 pauses.
- **Rollout.**
  - Originally: part C shipped live, and A was a one-day trial.
  - Now: one switch, off by default, for A, B and C, on the maturation ladder: throwaway pair, then Echo's two machines, then everyone. Graduation numbers come from a new `restart-episode-ended` log row.
- **The gain.**
  - Originally: 160 min/day and +3 merges.
  - Now: about 105 min/day and +2 merges, as an upper bound. Restarts that change the test tooling and the M5's own pauses are subtracted.
- **Refunds.**
  - Originally: none, so restarts spent half a change's two peer attempts.
  - Then: a refund on every restart abandon, which reviewers showed was unbounded.
  - Now: one refund per change, only when the restart changed the verifier.

## Experience fit

- **Goal and source:** Justin, topic 130715 (#130717, #143933, #143952): raise merges per day, use spare machines robustly, prefer intelligent assessment to fixed limits, tell hung from slow.
- **Ordinary journey:** the operator does nothing. The M5 simply loses less work around Studio restarts.
- **Contrasting cases:**
  - another machine takes the lease (abandon, as today);
  - the update changes the verifier (abandon, refund once);
  - two restarts in quick succession (adoption lost, safe).
- **Evidence limits:** the gain is computed from two days of logs and is an upper bound. The build's first step recomputes the baseline on qualifying windows.
- **Material findings:**
  - Hung versus slow is not addressed. An adopted run still ends at the fixed 60 minutes; this is disclosed in Risks.
  - No new asks of the operator. No trust or approval surface.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, adversarial, integration, scalability, decision-completeness, lessons-aware, clean-door (2) | 29 (heavily duplicated: ~9 distinct) | ~30 | C redesigned; Problem re-cut; posture; maturation plan; tests; parent-spec change |
| 2 | security, adversarial, integration, scalability, decision-completeness, lessons-aware, codex | 18 (~8 distinct) | ~40 | B identity; C.3 per-case table; C behind one switch; refunds; graduation numbers |
| 3 | codex (2), scalability (1), decision-completeness (1), clean-door (1, conditional) | 5 (3 distinct) | ~25 | restart episode; kill-switch ordering; dependency contract; log row; adverse-event rule |

Standards-Conformance Gate: round 1 ran (3 flags: Judgment Within Floors, multi-machine posture, Maturation Path). Round 2 ran (1 flag: pre-existing time bounds). Round 3 ran (3 flags: pre-existing time bounds, lease store without compare-and-swap, refund bound; the refund bound was fixed before the round's reviewers read it).

Models: the six internal reviewers ran on claude-opus-5-5 (this session's model). The cross-model pass was codex-cli gpt-6-astra. The clean-door pass was claude-code claude-opus-5-5.

## Full Findings Catalog

Each reviewer's full findings for every round are kept on the agent's machine at `.instar/state/scaling/converge/r{1,2,3}-{security,adversarial,integration,scalability,decision,lessons}.md` and `r{1,2,3}-{codex,claude}.json`. The distinct design findings and how each was resolved:

- R1 all six: `foreignHolder` resets at boot. Resolved by building on 3451's holding record plus `since`.
- R1 security/integration: a duplicate holding record. Resolved: reuse 3451's record.
- R1 decision/adversarial/scalability/integration/lessons: a boot race cancels the attempt. Resolved: a waiting state.
- R1 decision/adversarial/lessons: adopted epoch not used at every site. Resolved: the `markerCurrent` predicate plus a guard test.
- R1 adversarial/scalability: attempt budget spent by restarts. Resolved: one refund, verifier changes only.
- R1 adversarial: merge hold still delays a restart. Resolved: disclosed and kept on purpose.
- R1 scalability/lessons/clean-door: gain overstated. Resolved: re-cut to an upper bound of about 105 min/day.
- R1 integration/lessons: no maturation plan; wrong posture key. Resolved.
- R1 lessons: no test plan. Resolved.
- R1 decision: rollout and ordering left the builder waiting. Resolved with Frontloaded Decisions.
- R2 codex/security/scalability/adversarial/integration: `pendingSinceMs` is not a stable identity. Resolved: a service-owned episode, then a restart episode (R3).
- R2 security/adversarial/integration: waiting when another machine holds the lease. Resolved: abandon at once.
- R2 security/adversarial: a nonexistent `force` field. Resolved: removed.
- R2 codex/security: null `since` on records written before this change. Resolved: set on keep; safe-integer guards.
- R2 integration/lessons: C does not qualify for the ship-live exception. Resolved: on the ladder behind the switch.
- R2 adversarial/integration: unbounded refunds. Resolved: one per entry per head.
- R2 decision: no measurable graduation numbers; undefined window. Resolved.
- R2 lessons: an adverse-event signal that could never fire. Resolved: a main failure after an adopted-import merge.
- R3 codex: the disabled setting still entered the wait. Applied at cap: with the switch off, `markerCurrent` ignores `adoptedEpoch` and C.3 is skipped.
- R3 codex: the dependency contract was not pinned. Applied at cap: `holdingDecision` contract stated; the build stops if the merged 3451 differs.
- R3 scalability/clean-door: the episode ends when the pause flips. Applied at cap: a restart episode tied to pending update or restart.
- R3 decision: graduation metrics not in the log. Applied at cap: a `restart-episode-ended` row.

## Proportion

Tier 1. The spec is 188 lines, plus an ELI16 companion. 3 of 3 rounds were used. ⚠ That is heavy for a change worth about 2 merges a day, but each round found real design errors in the lease-trust logic, which is where a mistake would merge an unverified change.

## Left behind

- The clean-door reviewer suggested a per-epoch acquisition log in `FencedLease` instead of tick sampling. That is out of scope, for the lease layer; sampling loses adoptions only, never adds wrong ones.
- The clean-door reviewer suggested also comparing the pending update's verifier version at dispatch, where it is known. Accepted waste instead: it costs at most one idle peer run and its one refund.
- The guard-test allowlist must be kept current when 3451 merges (named sites listed).
- Recompute the baseline on qualifying windows before the dev-agent rung (stated in the plan).
- The 0.1% figure is an estimate under a Poisson model (labelled).
- The CLAUDE.md line rebases against 3451's neighbouring awareness edits.
- Lease store without compare-and-swap: a pre-existing lease-layer risk (MULTI-MACHINE-LEASE-ROBUSTNESS Problem A). With two machines, the peer's own cancel on taking the lease is a second guard.
- Possible later improvement (not this spec): a work-stealing file queue and more shards, from the scaling breakdown.

## Convergence Verdict

Converged at round 3, the Tier 1 cap. Round 3 raised 5 design findings (3 distinct). All are small, and none concerns safety, security or data loss. Two make the off switch and the restart identity behave as intended; one pins a dependency; one adds a log row for measurement. They were applied in one edit at the cap and were not re-reviewed by a fourth round. The reviewers who reported 0 design findings in round 3 were security, adversarial, integration and lessons-aware.

The spec is ready for review and approval by the Chief of Staff (session echo-chief-of-staff). The build starts only after PR 3451 merges.
