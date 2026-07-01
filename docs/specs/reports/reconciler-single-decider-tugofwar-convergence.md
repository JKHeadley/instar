# Convergence Report — Reconciler Anti-Oscillation (Cross-Machine Move Tug-of-War)

## Cross-model review: codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro

Both external (non-Claude) reviewers ran every round through the agent's own codex and gemini CLIs.
Final round: **Gemini-2.5-pro = CLEAN**; **GPT-5.5 = MINOR ISSUES** (one refinement — the re-evaluated
cap — folded directly from its suggested resolution). This is the clean cross-model pass.

## ELI10 Overview

The agent runs across more than one of your machines, and a conversation lives on one machine at a
time. You can move a conversation between machines. Last night's work fixed the move that got *stuck*;
this fixes the move that *thrashes* — if you start a second move while the first is still finishing,
the two machines could start yanking the conversation back and forth (a tug-of-war). Nothing was ever
corrupted (there's always exactly one owner — that guarantee is untouched), but the bouncing is a bad
experience.

The review process changed the design substantially. My first idea — a "one machine at a time" lock —
turned out to be the wrong tool: that kind of lock lives on a single machine, so each machine would
just grab its own copy and coordinate nothing (three reviewers plus both outside models caught this).
The converged design instead makes "one decider" *emerge* from a simpler, sturdier idea: **order the
moves by which one happened after which**, using a tamper-proof counter the system already keeps for
every conversation (it can't be faked by a wrong clock). Once both machines agree on that order, only
the current owner ever starts a move, so there's nothing to fight over. On top of that sits a plain
**safety brake**: if a conversation ever bounces too many times in a window, it stops driving that
conversation and flags it — it never freezes anything, it just refuses to keep fighting. Two smaller
fixes round it out: throw away a move-note once its move is truly done (so a stale note can't restart
a fight), and stop a buggy config-migration that was silently deleting operators' "off" settings.

The whole thing ships **dark** (off on the fleet, live only on a development agent) behind a rollback
flag, with a dry-run mode first. The one honest tradeoff: the brake prioritizes "never freeze" over
"perfectly serialize," so in a rare degraded moment you might see one extra small wobble — never a
stuck conversation.

## Original vs Converged

- **Originally:** a per-conversation "decider lock" (modeled on an existing host-local lease) +
  clear-the-pin-with-a-tombstone + stamp local pins with a timestamp + fix the migration.
- **After review:** the lock is **gone** (it couldn't serialize two machines and added failure modes).
  Single-decider behavior now emerges from a **total causal order** `(causalSeq, hlc, node)` where
  `causalSeq` is the conversation's ownership *epoch* (a fenced, monotonic counter — skew-proof).
  Pin-clearing moved to the machine that actually *wrote* the pin, and the risky mesh "tombstone" was
  replaced by **source-liveness retirement** (a note lives only while its move is pending) to avoid a
  freeze race and to never drop a slow-but-real move. A **fail-safe churn breaker** (P19) replaced the
  lock as the anti-oscillation backstop. The migration fix became **"retire the intent-erasing strip
  entirely"** (its cleanup job is long finished; keeping it only risked eating operators' settings).
  A forge-defense (a peer can't fabricate a higher counter), a full dead-handoff recovery state table,
  and honest scoping of the guarantee were all added under review.

## Iteration Summary

| Round | Reviewers who flagged material | Material findings | Spec changes |
|-------|-------------------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex, gemini, conformance | ~24 | Dropped the host-local lease; causal-epoch ordering; decay-not-tombstone; P19 breaker; recovery path; provenance-drop migration |
| 2 | all 8 + conformance | ~18 | causalSeq → schema home + forge-clamp + absent-rule; clear on writing machine; source-liveness decay (Deferral=Deletion); full F4 state table + N=2; retire-the-strip F5; honest F1 scoping |
| 3 | security, integration, adversarial, lessons-aware, codex, gemini, conformance | ~11 (all clarifications) | clamp-not-reject; F5 existing-test cleanup; re-emit semantics; breaker cardinality + one-CAS-attempt; zombie-advisory retirement; adopter selection; code-defaulted tunables |
| 4 | conformance (2), codex (1) | 3 (trivial completeness) | P19 re-emit ceiling; migrateClaudeMd parity; **re-evaluated cap** (removes re-emit dependency) |
| 4-confirm | — | 0 material | (converged) |

## Full Findings Catalog

Detailed per-round findings are preserved in the working notes (`round1-findings.md`,
`round2-findings.md`) alongside this report. Headline material findings and resolutions:

- **Host-local decider lease can't serialize two machines** (R1, security+scalability+integration+gemini)
  → dropped entirely; single-decider emerges from causal order + breaker.
- **Partition + clock skew still defeats HLC on heal** (R1 adversarial) → `causalSeq` = ownership epoch
  (fenced, causal), HLC only a tiebreak; honestly scoped (R2/R3).
- **Pin-clear cleared the wrong machine's store; tombstone could freeze a topic** (R1/R2, 4 reviewers)
  → clear on the writing machine; no tombstone, source-liveness retirement.
- **causalSeq had no home in the replicated schema / could be forged forward** (R2 security+adversarial)
  → added to the schema (additive-optional, ignore-not-reject); re-evaluated cap = `min(raw, observed
  epoch)` (forge-safe AND lag-safe, no re-emit dependency).
- **Provenance-marker migration not retroactively implementable** (R2 integration) → retire the strip
  loop; already-stripped intent is unrecoverable (honest); one-time heads-up + guard-posture surfacing.
- **Dead-owner + dead-target had no recovery; could snatch a slow target** (R2 adversarial) → full F4
  state table, both-provably-dead gate, N=2 fail-safe-stuck (never survivor-steal).
- **Deferral=Deletion: source-liveness decay could drop a pending move; re-emit unbounded** (R2/R4
  lessons-aware+conformance) → decay tied to source-pin liveness; P19 hard ceiling then surface.
- **Zero-Failure: retiring the strip breaks an existing test suite** (R3 integration) → §F5 directs the
  suite rewrite + call-site removal.

## Convergence verdict

Converged at round 4 (post-clarification confirming round). Round-4 confirming reviewers returned
**security / scalability / integration / decision-completeness / lessons-aware = converged**, external
**Gemini = CLEAN**, external **GPT-5.5 = minor** (its one refinement — the re-evaluated cap — folded
verbatim from its own suggested resolution). Zero unresolved user-decisions (`## Open questions` =
none; all frontloaded into §8). The spec is ready for user review and approval.
