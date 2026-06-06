# Convergence Report — Coherence Journal (P1 of multi-machine coherence)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in **every
round** (rounds 2, 3, and 4 — round 1 ran before the worktree dist was
built, internal-only). Final spec-level flag: `codex-cli:gpt-5.5` (clean
RAN). The external reviewer's final verdict was MINOR ISSUES; all four of
its substantive notes were folded into the spec as honesty clarifications
(best-effort completeness classification, first-hop topology assumption,
wrapper-vs-CAS-param rationale, lint annotation ergonomics).

## ELI10 Overview

Right now, each of the agent's machines only knows what happened on
itself. If a conversation moves from the laptop to the mini, or an
overnight job writes files on one machine, the other machines have no
record — questions like "where did this conversation live last night?" or
"which machine has those files?" can only be answered by logging into the
right machine and grepping logs that eventually rotate away.

This spec gives every machine a set of cheap, append-only diaries: one
line whenever a conversation is placed or moved, whenever a work session
opens or closes, whenever an autonomous run starts or stops (with the
paths to the files it wrote). Machines swap copies of each other's diaries
over the secure line they already use, so ANY machine can answer those
questions from its own disk. The diaries are strictly logistics — typed,
size-capped fields only; message contents and secrets structurally cannot
enter. And the diary system is forbidden (by tests, not promises) from
ever DRIVING actions — it answers questions; the live systems make
decisions.

The main tradeoffs: diary writes are deliberately "fire and forget" (a
crash can lose the last quarter-second of entries) because the one thing a
diary must never do is slow down or break the work it describes — this
machine has a documented history of freezing under disk pressure, so
nothing in this design ever waits on a disk inside a hot path. And
replication is deliberately first-hop-only (a machine only hands out its
OWN diary) because that makes forgery structurally impossible without
per-entry cryptographic signatures.

## Original vs Converged

The review process changed the design substantially. The headline changes:

- **Originally** the writer fsync'd every line at the moment of the event —
  inside the message-routing hot path. Review showed that reproduces the
  exact event-loop-starvation incident class this project was born from.
  **Now** emits are non-blocking memory enqueues; a background flusher
  batches disk writes; NO synchronous I/O ever runs in a caller's stack,
  and a fault-injection test proves an emit returns instantly even with a
  wedged disk.
- **Originally** all three event kinds shared one file per machine.
  Review showed noisy session events would rotate away the precious
  placement history first. **Now** each kind has its own file with its own
  retention — placement history is kept forever in bounded files
  (rotate-but-never-delete).
- **Originally** a peer's `journal-sync` batch was trusted to contain
  whatever streams it claimed. Review showed a buggy or compromised peer
  could forge any machine's history (and plant file paths a later phase
  would fetch). **Now** replication is first-hop-only — a machine only
  accepts entries authored by the authenticated sender, every entry is
  schema-validated before append, and file paths are jailed at WRITE time.
- **Originally** sequence numbers alone identified entries. Review showed
  restore-from-backup would make peers silently discard a machine's real
  new history forever. **Now** each stream carries an incarnation token
  with a crash-safe high-water-mark (data synced to disk BEFORE the mark
  advances, so an ordinary crash can never look like a restore), and a
  detected restore is quarantined LOUDLY — with bounds so a flapping
  machine can't flood disk or signals.
- **Originally** the spec said "the journal is observational" in prose.
  **Now** §3.9 makes it structural: no actuating code path may consume
  journal data, enforced by a wiring test — because acting on stale
  replicas would re-create the duplicate-session bugs this project exists
  to kill.
- **Originally** the spec named emission points that don't exist (a
  "can-start gate" that is actually a read-only preview; "three
  saveSession sites" when there are eleven; a "capacity heartbeat" that is
  actually a 30s presence pull). **Now** every emission point and
  transport seam is grounded in a real, code-verified symbol — including a
  new lifecycle funnel, a small bounded scanner for autonomous runs, and
  the advert riding the presence pull's response.
- **Originally** there was no migration story and no agent-awareness
  story. **Now** §3.8 ships config migration and CLAUDE.md template
  updates in the same PRs — existing agents get everything on update, and
  every agent learns the read API exists.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons | ~30 (2 critical: hot-path fsync; silent restore divergence) | Full rewrite: non-blocking writer, per-kind streams, first-hop trust model, incarnation fencing, §3.8 migration/awareness, §3.9 actuation ban, typed schemas, path jail |
| 2 | security, scalability, adversarial, integration (lessons: clean; codex: minor) | 10 | highWaterSeq + flap bounds, suspect self-clearing, restart-proof dedupe, session-status-response advert, autonomous scanner + observed-stopped, caller-supplied reason, guardJournalWrite seam, rotate-never-delete, read param hygiene, seq-at-enqueue semantics |
| 3 | adversarial (HIGH: meta ordering), integration (LOW), lessons (LOW advisory) (security: clean; codex: minor) | 4 | Pinned data-before-meta crash-safe ordering, durably-flushed-only adverts, answer-complete placement queries, placement cursor key, lint carve-outs, puller dep contract, scanner P19 declaration, lock-out surfacing, retention honesty |
| 4 | (converged) — all four internal reviewers clean; codex: minor honesty notes | 0 material | 4 one-line honesty clarifications folded in |

## Full Findings Catalog

The complete per-round findings (every reviewer, every finding, severity,
and resolution) are preserved in the convergence working record. Counts:
round 1 — security 7 (2 high), scalability 9 (1 critical), adversarial 12
(2 critical), integration 9 (2 high), lessons 9 (2 critical-class
standards gaps); round 2 — security 2, scalability 1, adversarial 5,
integration 4, lessons 0; round 3 — security 0, adversarial+scalability 2,
integration 1, lessons 1 advisory; round 4 — 0 material across all four,
codex MINOR (4 notes, folded). Every material finding's resolution is IN
the spec text — each fix is written at the section it governs, most with a
named §6 test pinning it.

## Convergence verdict

Converged at iteration 4. No material findings in the final round from any
of the four internal review perspectives; the external cross-model pass
(codex-cli:gpt-5.5) ran in every post-build round and its final notes were
non-material honesty clarifications, now folded in. Spec is ready for user
review and approval.
