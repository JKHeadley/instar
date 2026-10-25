# Convergence Report — Dashboard door + model controls (Sessions tab)

## Cross-model review: codex-cli:gpt-5.5

RAN. A real GPT-tier external pass ran through the agent's codex CLI in EVERY round (10/10,
status `ok` each time; `--family codex-cli`, context: TOPIC-PROFILE-SPEC.eli16.md). The
Standards-Conformance Gate ran every round (`POST /spec/conformance-check`, 92 standards, never
degraded). The clean-door Anthropic reviewer was not run (config-gated; not enabled here).
Internal reviewers ran as three subagent pairs per round (security+adversarial,
integration+scalability, decision-completeness+lessons-aware) on the authoring session's model
(Opus 5.5 for rounds 1–2; Fable 5.1 thereafter — the session escalated between rounds; recorded,
not assumed). Frameworks active in the 7-day window: codex-cli (GPT-tier) — externals were
therefore mandatory and were never skipped or delta-skipped (the body changed every round).

## Convergence verdict: CONVERGED on the retry run (6 rounds), after the first run hit its cap

The first run (10 rounds, below) ended `convergence-failed` at the cap. The operator approved the
cut scope on 2026-09-27 19:24 PDT with one change — remove the dashboard PIN requirement — and a
fresh run on the cut spec converged: rounds 5 and 6 of the retry had ZERO design-class findings from
all three internal reviewer pairs and from codex (GPT-5.5). Details in "Retry run" at the end.

### First run: NOT CONVERGED — cap reached (10/10), status `convergence-failed`

The two-consecutive-design-quiet-rounds criterion was not met by the letter: rounds 8 and 9 each
carried design-class findings, and round 10 is the cap. Round 10's result is recorded below. What
happened is specific and worth reading before deciding: from round 3 onward EVERY design-class
finding was in ONE subsystem — the rule that decides whether a Telegram-created topic is "new" on
a two-machine pool — and in round 9 the reviewers showed that rule was timing-dependent (a
confirmed fresh placement is epoch 2, and the peer reads after a history fetch), which no static
rule closes. Per the standing 80/20 convergence bar, that subsystem was CUT from v1 in round 9 and
recorded as a named hold (issue #2085, expiry 2027-03-25). The rest of the design — the three
Sessions-tab controls, the options route, the creation-time seed on a single machine, dashboard
create with pool placement — has been design-quiet since round 6/7.

**Recommendation to the operator:** approve the CUT scope (asks #1, #2 fully; ask #3 as the default
for the New Session modal and every dashboard-created topic, on any machine; Telegram-created-topic
seeding held in #2085 with the cross-machine work). If you say go, I run a fresh, short convergence on the cut spec (expected
2 rounds) before `/instar-dev` touches source — the tag is never stamped on a failed run.

## ELI10 Overview

Echo can talk to you through different "doors" (Claude Code, Codex…) and each door can run
different models. Every conversation topic can already be pinned to a door and model, and switching
a live topic keeps its conversation. Today the only way to do that is to ask in chat. This adds the
same controls to the dashboard's Sessions tab, so you can do it from your phone: pick the door and
model when creating a topic; switch a running topic with one tap (it restarts on the new door with
its conversation intact); and set a "default for new topics".

The tradeoff the review kept returning to is the default. It is easy to say "new topics start on
X"; it is hard to say, on an agent spread over two machines, whether a topic is genuinely new or an
old topic arriving from the other machine — and getting that wrong would silently move an existing
conversation onto a different door. On one machine the answer is a simple durable ledger. On two
machines every rule tried had a hole, so that half is held for a follow-up where it is designed
together with "the default follows you across machines".

## Original vs Converged

- **Originally**, the default was a live layer every unpinned topic would follow, with a "freeze"
  pass to keep existing topics where they were. Review showed the freeze would have restarted every
  open session at once and posted a "profile changed" line into every topic, and that a brand-new
  topic cannot accept a normal pin write (no bound operator yet). **Now** the default is read only
  when a topic is created and written as that topic's own starting pin through a store-level seed
  with no restart and no disclosure storm. Existing topics never read it.
- **Originally**, `/sessions/create` would "write the pin and let the spawn resolve it". It never
  consulted the resolver. **Now** it resolves then spawns with the resolved profile, registers
  through the adapter (deleting a raw registry write that the adapter's next save clobbered), and
  on a pool places the topic on the creating machine so the first message routes back to it.
- **Originally**, "is this topic new" was inferred from a name ledger that is written before any
  spawn (so it would never have fired). **Now** it is a durable never-deleted `topicKnownAt`
  ledger, backfilled at every boot from all four local ledgers, failing closed on an unreadable or
  un-backfilled registry — on a single-machine agent. On a pool it is held (#2085).
- **Originally**, the default was PIN-gated and raised an attention item. **Now** PIN-gated and
  audited, no attention item (routine confirmation of the operator's own action — act, don't notify).
- **Originally**, availability was a boolean that could not distinguish "verified" from "the probe
  errored". **Now** a tri-state (`verified | assumed | unavailable`), with the dashboard writes
  refusing `unavailable` (a deliberate, tested divergence from the chat path, which stays fail-open).
- **Originally**, the default replicated across machines by an HLC rule that contradicted itself.
  **Now** v1 is honestly machine-local under a `migrating-to-unified` marker (lint-clean), with the
  destination design and the pool-seeding design recorded in #2085.

## Iteration Summary

| Round | Reviewers who flagged design-class | Design | Precision | Standards-Conformance Gate | Cross-model | Spec changes |
|---|---|---|---|---|---|---|
| 1 | codex, sec/adv, int/scal, dec/lessons | 14+ | 4 | ran (2 flags) | ok gpt-5.5 SERIOUS | Full rewrite: creation-time seed, no live layer, store-level `mutateIfAbsent`, regime parity, PIN-gated default |
| 2 | sec/adv, int/scal, dec/lessons, codex | 9 | 7 | ran (2 flags) | ok MINOR | Newness on `topicToSession`+journal, `/sessions/create` resolve→spawn, replication reduced to migrating-to-unified |
| 3 | int/scal, dec/lessons, sec/adv | 5 | 6 | ran (2 flags) | ok MINOR | Durable `topicKnownAt` ledger, epoch-1 self-placing rule, marker line fixed, tri-state availability |
| 4 | sec/adv, int/scal | 2 | 9 | ran (2 flags) | ok MINOR | Pool ownership on dashboard create (2b), backfill mechanism, attention item removed |
| 5 | sec/adv, int/scal, dec/lessons | 5 | 7 | ran (2 flags) | ok MINOR | Backfill via migrateAsync (registerStep has no caller), ctx seam, reuse skip, release on failure, pool-without-replication refusal |
| 6 | int/scal (1), sec/adv (2 borderline) | 3 | 6 | ran (1 flag) | ok MINOR | Seam `release`, marker round-trip, call-time thunk, canonical write predicate |
| 7 | int/scal (1), sec/adv (1) | 2 | 8 | ran (1 flag) | ok MINOR | Backfill unconditional at boot (init pre-stamps version), lease-holder gating of 2b, lifecycle table |
| 8 | dec/lessons (1) | 1 | 8 | ran (1 flag) | ok MINOR | Seed site 3 (owner-side bridge), (d) relaxed |
| 9 | codex (1), sec/adv (1), dec/lessons (1) — all the same pool predicate | 3 | 5 | ran (1 flag) | ok SERIOUS | **Structural cut**: pool Telegram seeding held (#2085); predicate reduced to 2 conditions on router-dark |
| 10 | codex (1 real), dec/lessons (2), int/scal (1), sec/adv (1) — all but one inside the single-machine ledger machinery | 5 | 6 | ran (1 flag) | ok SERIOUS | **Second structural cut (post-cap, unreviewed)**: Telegram-created-topic seeding removed from v1 entirely; explicit pick on create requires the operator session; typed seam return; failure-path claim made honest |

Standards-Conformance Gate flags, every round, were on two standards: "An Instar Agent Is Always a
Multi-Machine Entity" (the gate's LLM reads the v1 machine-local default as unjustified; the
deterministic marker lint — `scripts/lint-machine-local-justification.js` — reports the
`migrating-to-unified` marker well-formed with a ratified ref, tracking ref, since and expiry) and
"Verify the State, Not Its Symbol" (each time on the pool newness predicate, which is now cut).
Both are signal-only and are recorded here rather than argued away.

## Full Findings Catalog

Reviewer outputs per round are preserved verbatim in the session transcript; the material ones and
their resolutions:

**Round 1.** Stamps via `applyWrite` would respawn every unpinned session and post N disclosure lines
(sec, int) → store-level seed. No `system` principal; token writes to unbound topics refused (sec,
int, dec) → creation-time seed with `system:` attribution. Dry-run misstated (all) → regime table.
Stamp-vs-operator race (sec) → atomic `mutateIfAbsent`. Snapshot pass incomplete (sec, codex) →
removed. Default PIN-less (sec, dec) → operator session. `/sessions/create` never resolves (int) →
resolve→spawn. Over-engineering (dec, Occam) → creation-time-only design. Deferred ratification =
open question (dec) → replaced.

**Round 2.** `topicToName` is written before spawn so newness never fires (sec, int, dec) →
`topicToSession` then, later, `topicKnownAt`. Husks with `current:null` (sec) → `get(key)===null`.
Seed invisible (sec) → one disclosure line. Replication rule self-contradictory (sec, dec) →
migrating-to-unified with tracking issue. XSS at index.html:4583 (sec) → escaped. `unverified` has
no source (int, dec) → tri-state later. Maturation plan missing (dec) → added.

**Round 3.** Router places before the callsite, so a new topic already has an epoch-1 record (int) →
rule updated. Single-machine ownership store is in-memory; `topicToSession` cleared on reap/unlink
(dec, sec) → durable `topicKnownAt` ledger. Marker line malformed and expiry one day over (dec) →
fixed, lint clean. Options route key contested (dec) → `proxied-on-read` operational.

**Round 4.** Dashboard create places no ownership (sec) → step 2b. Backfill home unspecified (int)
→ migrator. Gate: attention item is notify-not-act → removed.

**Round 5.** `registerStep` has no production caller (sec, int) → migrateAsync; seam missing from
ctx and `cas` doesn't journal (sec, int) → one ctx seam; stranded `placing` on failure (sec, dec) →
release; readiness gate wider than the router's (dec) → router-live; reuse path 409s self-owned
topics (dec) → skip on reuse. Gate P20: pool without placement replication → refusal.

**Round 6.** Seam has no `release` (int) → added. Marker dropped by the adapter's save; thunk built
"inside the block" exists on pool-dark agents (sec) → round-trip both; call-time evaluation.

**Round 7.** Fresh install pre-stamps the migration version so a version-gated backfill never runs
(int) → unconditional boot routine on the registry-file marker. Placement authoritative only on the
lease holder (sec) → seam requires router-live ∧ replication ∧ holder; preferenced create refused
elsewhere.

**Round 8.** Peer-placed topics arrive via the owner-side bridge and never reach the callsite (dec)
→ site 3 added (then cut in round 9).

**Round 9.** "Absent record is never proof" contradicts "absent ∨ epoch-1" (codex). A confirmed
fresh placement is epoch 2, not 1, so the site-3 rule is timing-dependent (dec, sec) →
**structural cut**: pool Telegram seeding held in #2085; predicate reduced to two conditions on a
router-dark agent; corrupt-registry salvage added for the gate's P20 flag.

**Round 10.** Recorded below when the round completes.

## Round 10 (final, cap)

- codex: (1) explicit door/model on `/sessions/create` is a NEW privilege (no bound operator yet) —
  accepted → now requires the operator session; (2) the newness ledger is a hand-rolled event system
  over JSON files — recommended dashboard-only v1 → accepted (see below); (3) the "pin follows the
  topic through the carrier after a failed create" claim was unproven → replaced by an honest limit
  and an observable-contract test; (4) terminology → glossary added.
- decision+lessons: D1 the seam's `null` could not distinguish "dark" from "not authoritative" →
  typed return; D2 hold evaluation order → moot after the cut; precision: "graduation soak on Echo (a
  pool) cannot exercise the single-machine seed" — the observation that settled the second cut.
- integration: the boot-window router-live misread at the cold-spawn callsite → moot after the cut
  (the dashboard route is only reachable after both refs are assigned; noted).
- security: corrupt-registry salvage half-applied → moot after the cut; `_placementReplicationOn`
  does not exist (`_replicationOn` does) → fixed.

**What changed after the cap, and why it is honest to say so:** round 10's findings were folded
into the spec (they were small and the cut removed most of their subject), so the spec on disk is
one iteration AHEAD of the last full review. That is exactly why no convergence tag is written: the
text has not had two quiet rounds, and the post-cap edits have had none. A retry run on the cut spec
is the right next step and needs the operator's go (skill rule: human input before retry).

**The second cut, in one paragraph.** After round 9 held pool Telegram seeding, everything that
remained of the "is this topic new" machinery — the `topicKnownAt` ledger, the unconditional boot
backfill, the corrupt-registry quarantine and salvage — served ONLY single-machine Telegram seeding.
Echo, the dev-agent-live target, is a pool and would never run it, so it would have shipped unproven
on real use. Two independent reviewers said so in round 10. It is cut; ask #3 in v1 is "the default
used by the New Session modal and by every dashboard-created topic"; Telegram-created topics on any
machine are tracked in #2085 with the pool design and the replicated default.


## Retry run (operator-approved cut scope, PIN removed) — CONVERGED at round 6

Cross-model: codex-cli:gpt-5.5, status `ok` every round (6/6). Standards-Conformance Gate ran every
round, never degraded; its only recurring flag is the signal-only "Multi-Machine Entity" reading of
the v1 machine-local default, which the deterministic marker lint accepts
(`migrating-to-unified`, ratified `5a4efecc1`, tracking #2085, since 2026-09-27, expires 2027-03-25).

| Round | Design | Precision | What changed |
|---|---|---|---|
| 1 | 5 (codex 1, sec 3, int 2 overlapping) | 9 | PIN removed per operator; every create on a non-holder refused (no off-owner spawn); typed seam; failure-after-spawn confirms instead of releasing; issue #2085 re-scoped |
| 2 | 4 (sec 3, int 1) | 6 | Spawn through the `spawnSessionForTopic` chokepoint with claims corrected to what it actually does; `silentStart`; `spawningTopics` armed; guard drop-with-notice recorded as decision row 9 |
| 3 | 2 (int 1, sec 1) | 7 | Thunk seat; intent header on all three dashboard fetches |
| 4 | 1 (int + sec, same) | 5 | Thunk built at ctx construction via the late-bound `_spawningTopicsRegistryRef` |
| 5 | **0** | 6 | Precision only (disclosure helper, pre-checks, rejected-alternatives paragraph) |
| 6 | **0** | 4 | Precision only (line drift, §7 qualification, ELI16 PIN sentence removed) |

Decision-Completeness final counts: 9 frontloaded decisions, 1 cheap-to-change-after tag
(thinking/effort) that survived contest in every round, 0 contested-then-cleared.
