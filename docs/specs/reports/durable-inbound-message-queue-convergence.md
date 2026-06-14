# Convergence Report — Durable Inbound Message Queue + Hold-for-Stability Policy

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in **all ten
rounds** (10/10 successful). The Gemini-tier pass (gemini-cli:gemini-2.5-pro)
ran successfully in rounds 1–5, 7, 9 and 10, and degraded (timeout) in rounds 6
and 8 — the spec-level aggregate is the clean RAN flag because every round had
at least one successful external read, and most had two.

## ELI16 Overview

See the companion: `docs/specs/durable-inbound-message-queue.eli16.md` — the
plain-English entry point. One paragraph of it here: when a message can't be
delivered right now (conversation mid-move between machines, or the owning
machine briefly wobbly), it goes into a small crash-proof on-disk queue instead
of being injected into the wrong place or silently dropped — and with a safe
place to wait, a wobbly machine gets up to 90 seconds to recover before the
conversation is moved off it. Fewer machine swaps, no lost messages, every
retry braked per the P19 standard. Ships dark behind
`multiMachine.sessionPool.inboundQueue`, then dry-run on dev agents, then
staged rollout per the frontmatter criteria.

## Original vs Converged

The core shape — SQLite custody store + drain loop + hold-for-stability verdict
— is unchanged since round 2. What review actually changed:

- **Round 1 (~30 findings, 5 fatal):** The draft leaned on an ACK protocol that
  exists only in docstrings — the shipped code acks nothing and falls through to
  local dispatch, so the draft's queue would have double-delivered every held
  message. Three reviewers independently found the retry path eating its own
  entries and reporting them delivered. The problem statement was re-grounded
  against the shipped wiring (the real failure is wrong-place delivery, not
  "hot replay").
- **Round 2 (~50 findings):** Reviewers broke three round-1 fixes: the hold
  timer could be reset forever by a machine that blips just right (fixed:
  per-entry cumulative hold clock); a crash-recovery handshake still had a
  double-delivery window (fixed: receipt written at the ownership-handover
  point); the rollout config used an unparseable format. The heartbeat-depth
  mitigation gained a per-session top-K list so the survivor arm was actually
  implementable.
- **Round 3 (26 findings):** Receipt-store mechanics pinned (receipts live in
  the queue DB, class-tagged, with a retention floor that must outlive every
  redispatch); per-dispatch deadline replaced an under-bounded retry formula;
  planned lease handoff became three ordered steps after a 60-second message
  capture window was found; SQLite schema legality fixed (AUTOINCREMENT).
- **Round 4 (13 findings):** Quarantine deletion re-homed to the unconditional
  boot path (the backstop tick belongs to a component that is unconstructed in
  exactly the gate states that produce quarantines); storage assumptions named;
  NACK transport for sender-deauthorization given a real wire vocabulary.
- **Round 5 (externals + fold):** Minimal-correctness-core section (what cannot
  be compromised vs droppable policy); ENOSPC/WAL-checkpoint handling; the
  message state map disambiguating "delivered" vs "receipt written" vs
  "actually injected"; config-seam validation consolidated; both open questions
  resolved (clamp defaults stand; flap item observation-only).
- **Round 6 (5 material):** **The best catch of the gauntlet:** the design
  stamped entries with the pool's lease epoch to detect custody changes — but
  the pool advances that epoch on EVERY renewal (seconds), so virtually every
  queued message would have been clamped to a 2-minute shelf life, silently
  gutting the timing model. Tenure was redefined as holder + acquisition
  generation. Also: a transient inject error after receipt-write would have
  recorded silent loss as `delivered` (now reported at error time +
  `possiblyNotInjected` counter); the emergency-stop TOCTOU closed
  transactionally (receipt write conditional on the row still being `claimed`);
  `pauseMaxMs` added to the receipt-retention floor; the PendingInjectStore's
  documented at-least-once replay enumerated honestly as duplicate window 5.
- **Round 7 (7 material):** Reviewers broke three round-6 fixes: "same
  transaction as the PIS record" was unimplementable across two stores
  (ordering pinned: receipt first); the pause cap was per-episode and could be
  reset forever by a flapping pause source (made cumulative — the same bug
  class round 2 killed for holds); the tenure definition had no workable source
  of truth (pinned: queue-owned counter, bumped on observed holder change).
  Plus: stop-between-receipt-and-inject window closed; survivor episode-key
  vocabulary fixed; restore-to-new-machine honesty.
- **Round 8 (5 material):** Operator stop/pause now reaches the
  PendingInjectStore (a surviving PIS record would have replayed a post-stop
  inject at boot); the peer-crash-after-receipt window on the forwarded path
  enumerated and closed peer-side (loss window 6, `injected` marker); the
  in-progress pause episode's start made durable (`frozen_since`); the
  episode key given a real transport (tenure id on the capacity heartbeat); the
  cross-machine receipt floor anchored to a protocol constant so any two
  legally-tuned machines compose safely.
- **Round 9 (2 material, found independently by both reviewers):** Pause
  semantics pinned to `queued` rows only — in-flight dispatches complete — which
  kills two silent-loss chains by construction (a pause colliding with the
  round-8 stop machinery could have settled a promised-for-resume message as
  `delivered` without injecting it, unreported); peer-side caught inject errors
  now report at error time with a prune-time backstop, completing the
  loss-over-duplicate symmetry on both paths. Plus external pins: durable
  `delivered_unconfirmed` row flag, `custodyDurability` posture field,
  failClosedReport resolved as a named post-v1 knob, complexity budget with
  data-driven replace-triggers.
- **Round 10 (confirmation):** The adversarial reviewer — source of every
  material finding since round 6 — returned CONVERGED. The whole-spec
  consistency sweep found one stale citation (§3.4 still quoting the
  pre-round-6 horizon formula; the enforced §Config inequality was already
  correct) and five one-line hygiene items; all corrected in-round. Externals
  returned advisory commentary only.

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Spec changes |
|-------|----------------------|-------------------|--------------|
| 1 | all 8 | ~30 (5 fatal) | re-grounded problem statement; custody handshake |
| 2 | all 8 | ~50 | cumulative hold clock; receipt-at-handover; rollout format |
| 3 | 6 of 8 | 26 | receipt mechanics; dispatch deadline; ordered handoff |
| 4 | 5 of 8 | 13 | quarantine re-home; storage assumptions; NACK wire |
| 5 | externals only | 0 fatal (advisory) | minimal core; ENOSPC; state map; questions resolved |
| 6 | adversarial, integration, lessons | 5 | tenure redefinition; error-time reporting; stop TOCTOU; pause floor; window 5 |
| 7 | adversarial, integration | 7 | receipt-first ordering; cumulative pause; tenure source; episode key; halt re-check |
| 8 | adversarial | 5 | halt-reaches-PIS; loss window 6; frozen_since; heartbeat tenure; protocol constant |
| 9 | adversarial, fresh-eyes (same 2) | 2 | pause scope pin; peer error-time symmetry |
| 10 | consistency sweep | 1 (stale citation) | one-clause correction + 5 hygiene lines |

## Full Findings Catalog

Per-round detail lives in three places, disclosed honestly:

- **Rounds 1–4 internal findings:** the session running those rounds was
  respawned mid-round-5; the per-reviewer artifacts lived in that session and
  were lost. The findings themselves are durably recorded as the spec's inline
  `(round-N)` annotations (the spec carries its own audit trail — every
  round-stamped passage names what was found and how it resolved) and in the
  contemporaneous Telegram narration. External (cross-model) results for ALL
  rounds survive as JSON artifacts, preserved in-repo at
  `docs/specs/reports/durable-inbound-message-queue-xrev/` (all 20 files,
  rounds 1–10 × both families, including the two degraded gemini rounds).
- **Rounds 6–10 internal findings:** reproduced in full in this report's
  Original-vs-Converged section; the complete reviewer outputs are in the
  convergence session's transcript.
- **Standards-Conformance Gate:** invoked in round 6; returned degraded
  (`degradeReason: 'error'`, 0 findings) — per the skill this is fail-open and
  noted: the constitutional pass was NOT authoritative for this convergence.
  The lessons-aware reviewer's manual sweep (P1–P19, L1–L17, B1–B39, rounds 6
  and 7) stands in as the lessons/constitution coverage.

## Convergence verdict

**Converged at iteration 10 (the cap), with one disclosed judgment call.**
Criterion 2 (zero unresolved user decisions) is met structurally — `## Open
questions` reads None, six decisions frontloaded into `## Resolved questions`
(two resolved under the operator's standing design-fork directive, named as
such). Criterion 1 (no material new issues in the final round) is met for
design findings: the round-10 adversarial pass and both externals produced
zero new material design findings. The consistency sweep's single
material-classed item was a stale cross-reference to a fix already adopted in
round 6 (the enforced invariant was correct; one citation lagged) — corrected
in-round along with five non-material hygiene lines. Judgment: a stale citation
of an adopted fix is editorial residue, not a new design issue; declaring
convergence-failed over it would misrepresent the spec's actual state. This
call is disclosed here rather than buried.

Spec is ready for user review. `approved: true` is the user's step, after
reading this report and the ELI16 companion.
