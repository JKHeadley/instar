# Convergence Report — Fix: stateSync memory stores never replicate — writer-agnostic reconciler

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra reviewed the spec through the agent's own Codex CLI in all six rounds (every round
`ok`, verdict "SERIOUS ISSUES" in each, findings folded in). Gemini was not authed on this machine
(`gemini-not-authed`), so the external pass was one family, not two. The Anthropic clean-door read
was not run.

## ELI10 Overview

When I run on several machines, some of my memory (people I know, my knowledge library, users,
preferences, lessons, action items) is supposed to copy itself between them. Four of those had never
copied anything. The live check showed why: they were empty everywhere. But it also showed a real
problem waiting: a record is only copied when it is written by one particular object inside my
server, and most writers (the command-line tools, some dashboard routes) are elsewhere. The knowledge
library can only be filled from the command line, so it could never have copied.

The fix is a small background job inside the server, the reconciler, that looks at those store files
on disk every ten minutes and copies anything new or changed, no matter who wrote it. Deletions are
copied too, for people and knowledge, but only when the store's own delete command left a written
note saying "I deleted this", never just because a row went missing (a missing row can be an
accident). It does nothing for stores that are switched off, which is every agent except my own
machines.

The main tradeoffs: copies it makes don't claim to have "seen" other machines' versions, so if two
machines really hold different versions of the same record, you get a flagged conflict rather than a
silent overwrite; and a few rare deletion paths (user, lesson and action removals from the command
line) still don't copy until a related producer bug is fixed.

## Original vs Converged

- **Size.** The inherited 2026-10-25 draft was 66 KB, with rotation-repair byte budgets, three churn
  classifiers, a self-clearing config switch and a mass-delete hold machine. The first rewrite cut it
  to the safety core; review then rebuilt only what real counterexamples required.
- **Deletions.** Originally a deletion was inferred when a row disappeared from disk, guarded by
  two-tick confirmation, mass-delete bounds, a near-whole-store hold, an operator release switch and a
  dry-run soak. Codex showed that a lost update (two command-line writers racing) looks exactly like
  a deletion, so no amount of waiting can tell them apart. Converged: a deletion replicates only from
  an explicit two-phase intent line (`pending` before removal, `done` after) written by the store's
  own delete method, ordered against the copy by the server's persisted clock, with no identity in it.
  All the inference machinery is gone.
- **The witness.** Originally copies used the normal "what I had seen" stamp, which could let a stale
  local write silently beat a newer version from another machine. Then no stamp at all, which made
  identical copies on two machines show up as conflicts that hide the record. Converged: no stamp, and
  the union reader now treats byte-identical versions as one value (and closes any such conflict
  already open, recorded as "identical content", never as an operator decision).
- **Git-synced agents.** Reviewers found that on agents using git-sync, these store files arrive from
  other machines through git, so copying them as "mine" would duplicate them and turn git deletions
  into copied deletions. Converged: the store is skipped, re-checked every tick, when its file is
  tracked by git or git-sync is active and the file is not ignored.
- **Smaller fixes.** A read-only user-file reader that never constructs the user manager (which writes
  a marker, backs up corrupt files and logs per row); the reconciler honours a store's own dry-run;
  failure backoff gives up after 24 hours with one attention item; the status route never carries a
  record key or error text; the preference hook now redacts credentials like its contract says.

## Iteration Summary

Internal reviewers each round: security, scalability, adversarial, integration,
decision-completeness, lessons-aware (Claude subagents on this session's model, opus-class). Codex
GPT-6 Astra every round. Standards-Conformance Gate: round 1 ran (3 flags), round 2 ran (1 flag),
round 3 ran (3 flags); rounds 4–6 not re-run (body edits confined to §4 step 4 / §2, gate findings
already engaged).

| Iteration | Reviewers who flagged DESIGN | Design findings | Left behind | Spec changes |
|-----------|------------------------------|-----------------|-------------|--------------|
| 1 | all six + codex + gate | ~24 | 14 | rewrite: git-carried skip, resurrection guard, dry-run tombstones, quiet user reader, single-flight, park, P20/decision tables |
| 2 | codex, adversarial, security, integration, lessons, decision | 9 | 8 | no-witness emits, unified latest map, wall-time confirmation, near-whole hold, episode-bound release |
| 3 | codex, adversarial, security, integration, lessons, decision, scalability | 9 | 6 | deletion inference replaced by deletion intents; identical-version collapse in the union reader |
| 4 | codex, integration, lessons | 5 | 6 | intents without identity under `state/`; no ack file; identical-conflict auto-close as its own resolution |
| 5 | codex, lessons | 3 | 4 | two-phase `pending`/`done` intents; sourceFp-keyed invalid rows; key-only tombstone builders |
| 6 (cap) | codex (2), integration (1) | 3 | 3 | floor read after removal; retirement only for `done`; exact clock file via a server-written pointer — applied at the cap, see Left behind |

## Proportion

Tier 2 (fleet-wide replication semantics, deletion propagation). Spec ≈ 640 lines. Six of six rounds
used — at the cap. ⚠ The effort is high for a change whose immediate live effect is small (four empty
stores); it reflects the deletion path, which went through three designs before one survived
counterexamples. The simplification from the 66 KB draft held: the converged design has fewer moving
parts than round 1's.

## Left behind

- **Fixed at the cap without a further review round (DESIGN, all fail toward "peers keep the
  record", none can erase or leak):** (1) the HLC floor is read when the `done` line is written, so a
  reconciler copy emitted between `pending` and the removal cannot invalidate the deletion; (2) only
  `done` intents are retired by a later sighting of the row; (3) the deleting process finds the live
  clock file through a pointer the server writes, instead of refusing when an abandoned clock file
  sits beside it. Each is a one-rule change that the reviewer who raised it proposed.
- Foundation scalar-witness limit (codex r4/r5): another writer's witness can still order around a
  reconciler record it never saw; inherited from foundation §7.2, true of every emitter, stated in §2.1.
- Tombstone rotated out of the journal window loses the resurrection guard (codex r5): stated in
  §5.10; same as an in-process hook re-save today; needs a 20 MB own stream.
- Byte-identical collapse only: the same URL ingested independently on two machines still conflicts
  (different `ingestedAt`) — stated in §5.10, unchanged from in-process behaviour.
- Free-text credential scrubbing in all WS2 builders → feedback `fb-c06f0a53-0fb`.
- Peer union reads for knowledge / evolutionActions / userRegistry / relationships → feedback
  `fb-007f5082-161` (with the userRegistry-tombstone ordering condition).
- CLI/per-request removals of users, learnings and actions don't replicate; producer clobber →
  feedback `fb-9ac43374-07b`.
- PRECISION, not iterated: rate-bucket sharing note; snapshot size expectation; spawn cost of the git
  probe; `intentNoFloor`/`intentNoClock` naming (kept `intentNoClock`); "foundation spec §3.5"
  reference wording (fixed in passing); test lists for existing union suites; a pseudonymous-key
  sentence in §5.2.

## Full Findings Catalog

Round 1 (v2 spec): security — local-writes-only false under git-sync (fixed §5.5), resurrection after
own tombstone (guard), CLI-removal gap (stated), free-text scrub (filed), fixture refusal for
relationships (added), builder-throw loop (content failure), lastError leak (fixed codes), user
reader side effects (static reader). Scalability — witness full-scan cost (no witness), deduped
unreachable (defensive), timeout releasing lock (keeps lock), rotation churn (no periodic re-seed),
snapshot cost (yields + timing), double user read (static reader). Adversarial — git-sync, witness
resurrection, corrupt-catalog erase, duplicate-key loop (skip), relationships stale-map clobber
(guard), single-flight overlap, deduped. Integration — git-sync via the hourly job, user reader,
deduped, alive e2e, store dryRun ignored by emitter (honoured), wiring names. Decision — tombstones
live without dry-run, mobile release, scrub frontload, P20 coverage, rotation-lost delete. Lessons —
rotation trigger (rejected with reasoning, accepted by reviewer), sticky release, mobile, capacity
safety (park + registry), union-read gap (declared), CLI user removal ordering. Codex — witness
manufactures causality, delete-during-seed race, rotation re-authoring.

Round 2 (v3): codex — put staleness during yields (fence), release not episode-bound, absence ≠
intent (→ round 3 redesign). Adversarial — no-witness conflicts hide records, duplicate key creates a
delete candidate. Security — unknown fpAtDelete fails open (hold), gitCarried once-only (per tick).
Integration — git-sync job not a GitSyncManager. Lessons — no-witness conflict cost. Decision — flip
criterion uncheckable. Scalability — boot rotation churn.

Round 3 (v5): codex — scalar witness vs delayed origin (→ identical collapse), wall vs HLC clocks,
trimming drops intents. Security/decision — intent log keeps identities forever. Adversarial —
re-add during yields tombstoned, intent write ordering, ack before fsync. Integration — logs outside
`state/`, open identical conflicts never close. Lessons — ack file load-bearing; fp binding.
Scalability — non-repo agents read as carried.

Round 4 (v6): codex — reverse-direction scalar witness (stated), builder-throw marker (sourceFp),
delete/intent crash window (two-phase). Integration — auto-close recorded as operator decision (own
resolution kind). Lessons — edit-then-delete lost (time binding).

Round 5 (v6b): codex — clock bound vs foundation (persisted-HLC floor), interrupted delete armed
(two-phase), rotation removes guard (stated). Lessons — inert-line claim false (two-phase).

Round 6 (v7): codex — reconciler put between pending and removal invalidates delete (floor after
removal), retirement of an unfinished delete (done-only). Integration — multiple clock files
(pointer). All three applied at the cap.

## Convergence verdict

Converged at the round cap (6 of 6, Tier 2). The final round's internal reviewers found no DESIGN
issue except one (fixed); the cross-model reviewer's two final DESIGN findings were narrow ordering
fixes in the deletion-intent protocol, applied at the cap and listed above — none of them in the
harmful direction (each failure mode keeps a record on peers; none erases or leaks). No open
questions remain. Spec is ready to build.
