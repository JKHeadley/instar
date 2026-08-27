---
title: "A crashed measurement must not read as a healthy zero — four shipped job templates parse JSON through `echo`, and every failure path defaults to the reassuring number"
slug: crashed-measurement-must-not-read-as-a-healthy-zero
author: "echo"
parent-principle: "Report the State I Can Evidence (a measurement that did not happen must report that it did not happen, never a number)"
sibling-principles: "Structure > Willpower (the producer is fixed, not the artifact — the same repair had already been made twice by hand and did not survive); Verify at the Consumer (every claim in §1 and §3 is read from a deployed agent or the scheduler's own shell, never from the template alone); Migration Parity Standard (a template-only fix reaches new agents and no existing one); Bounded Blast Radius (the render-order remedy in §4.3 cannot empty an agent's MEMORY.md the way the proposed threshold can)"
eli16-overview: crashed-measurement-must-not-read-as-a-healthy-zero.eli16.md
source-proposal: "EVO-017 (approved 2026-08-26). Scope re-graded against the tree and against a live deployed agent — see §3: the proposal's callsite count is low, one of its two remedies is refuted and replaced, and its premise that the fixes survive in an agent-local manifest is no longer true."
status: draft
review-convergence: pending
approved: false
depends-on: "src/commands/init.ts (the shipped job-manifest generator; measured at origin/main c0dc5a4d5); src/core/PostUpdateMigrator.ts (the deployed-agent path — note it already carries a legacy jobs.json → per-job-manifest migration at :4929-5059, which makes TWO substrates, not one); src/scheduler/JobScheduler.ts:1157 (execFileAsync('/bin/sh', ['-c', script]) — the consumer shell); src/memory/MemoryExporter.ts (render order and minConfidence); .instar/hooks/instar/compaction-recovery.sh:168 (head -50 — the read boundary)"
---

# A crashed measurement must not read as a healthy zero

## 0. One-paragraph summary

Four job templates that instar ships to every agent parse a JSON response by
piping a shell variable through `echo`. Under the scheduler's own shell
(`/bin/sh`), `echo` interprets backslash escapes, so any JSON carrying an
escaped quote or an escaped newline — routine in memory text and in drift
payloads — arrives at `python3` mangled. `python3` raises, and each callsite's
fallback supplies the number `0`. The job then prints a confident, reassuring
sentence: *no entities to export*, *nothing pending*, *no drift detected*. A
crashed measurement is byte-identical, to the only human who ever reads it, to a
healthy system. This spec fixes the parse (`printf %s`), replaces the reassuring
fallback with an explicit unknown, carries the fix to already-deployed agents
across both manifest substrates, adds a ratchet so the shape cannot return, and
— on the basis of a live measurement in §3.3 — refuses the second remedy the
source proposal asked for, replacing it with one that cannot empty an agent's
memory file.

## 1. What is shipped today, measured

All measurements read from `origin/main` at `c0dc5a4d5351204cc7c2bb82bfd2484e089be248`
(`git show origin/main:src/commands/init.ts`), 2026-08-27.

### 1.1 Nine callsites, four job templates

| line | job slug | `echo "$VAR" \| python3` | fallback `\|\| echo 0` |
|------|----------|--------------------------|------------------------|
| 3262 | `feedback-retry` | 1 | 1 |
| 3343 | `project-map-refresh` | 1 | 0 (falls back to the text `done`) |
| 3478 | `memory-export` | 2 | 2 |
| 3511 | `capability-audit` | 5 | 4 |

Nine pipes, seven of which default to the literal `0`. `printf %s` appears zero
times in the file. The source proposal named three templates and no callsite
count; `project-map-refresh` is a fourth instance of the same parse defect and
is included here.

### 1.2 The reporting sentence each false zero produces

- `memory-export` → `Memory export: no entities to export.`
- `feedback-retry` → `Feedback retry: nothing pending.`
- `capability-audit` → the drift branch is skipped entirely; the job reports no drift.
- `project-map-refresh` → `Project map refresh: done` (no false number, but the
  file and directory counts are silently dropped).

Every one of these reads in the direction that requires no action. That is the
defect this spec is named for: the failure mode and the healthy state are
rendered identically.

## 2. The mechanism, reproduced under the scheduler's own shell

`src/scheduler/JobScheduler.ts:1157` runs script jobs as
`execFileAsync('/bin/sh', ['-c', script])`. Run against that exact shell on
2026-08-27, with a JSON body containing one escaped quote and one escaped
newline — both ordinary in an entity's text:

```
input bytes : {"entityCount": 7, "note": "said \"hi\" then\nmoved on"}
via echo    : {"entityCount": 7, "note": "said "hi" then
moved on"}
COUNT via echo   : 0
COUNT via printf : 7
```

`echo` consumed the backslashes and turned `\n` into a real newline, producing a
string that is no longer JSON. `python3` exits non-zero, `|| echo 0` fires, and
the count that was really seven is reported as zero.

Two notes that matter for review:

- **This is not a shell-portability curiosity.** `/bin/sh` is what the scheduler
  actually uses. `zsh` behaves the same way; `bash` invoked as `bash` does not.
  An author who checks the line in a `bash` prompt sees it work.
- **`printf %s` is the correct verb, not a style preference.** It performs no
  escape interpretation and adds no trailing newline, so the bytes reaching
  `python3` are the bytes `curl` returned.

## 3. Three corrections to the source proposal, found while checking it

EVO-017 is right about the defect and right about the producer/artifact
distinction. Three of its supporting claims do not survive contact with the
tree and a live agent, and one of its two remedies must be replaced.

### 3.1 The fixes no longer live in an agent-local manifest — they live nowhere

EVO-017 states both fixes are *present in `.instar/jobs.json`* on this agent.
Measured 2026-08-27: this agent has **no `.instar/jobs.json`**. Its jobs are
per-job manifests under `.instar/jobs/instar/*.md`, and `GET /jobs` returns 33
slugs, none of which is `memory-export`, `feedback-retry`, or
`capability-audit`. No backup of the old file exists under `.instar/state/`.

So the hand-repair did not merely fail to reach the fleet. It evaporated when
the manifest layout changed underneath it. This strengthens the proposal's own
argument rather than weakening it: an artifact-level repair has no owner and no
migration, so a routine format change deletes it silently.

### 3.2 A deployed sibling agent carries the broken form, live and enabled

Read from another agent home on this machine
(`~/.instar/agents/groky/.instar/jobs.json`, 27 jobs), 2026-08-27:

| job | `echo "$VAR"` pipes | `printf %s` | `minConfidence` |
|-----|--------------------|-------------|-----------------|
| `feedback-retry` | 1 | 0 | — |
| `memory-export` | 2 | 0 | absent |
| `capability-audit` | 5 | 0 | — |

All three enabled. This is consumer-side evidence in the sense EVO-009 requires:
the fleet impact is read off a deployed agent, not inferred from the template.

It also establishes the migration surface precisely. `PostUpdateMigrator`
already carries a legacy `jobs.json` → per-job-manifest migration
(`src/core/PostUpdateMigrator.ts:4929-5059`), and the two agents on this machine
sit on opposite sides of it. A migration that patches only one substrate reaches
only half the install base.

### 3.3 The `minConfidence: 0.75` remedy is refused, and replaced

EVO-017 asks for `minConfidence: 0.75` in the `memory-export` payload, ported
from LRN-024's hand-repair, so that lessons render inside
`compaction-recovery.sh`'s `head -50` window.

Measured against this agent's live store (`.instar/semantic.db`, 2026-08-27):

```
entities: 59        expires_at NULL: 59 (100.0%)
confidence 0.7  -> 56
confidence 0.85 -> 1
confidence 0.9  -> 1
confidence 0.95 -> 1
>= 0.75: 3    >= 0.70: 59    >= 0.20 (shipped default): 59
```

A `0.75` threshold selects **3 of 59 entities**. EVO-011 measured the same shape
at a different scale on 2026-08-23: 1,475 of 1,491 entities sat at exactly 0.7.
The extractor writes 0.7 as its default, so confidence is very nearly a constant
column, and a threshold set just above a constant is not a ranking — it is an
erasure. Shipping `0.75` to the fleet would empty the semantic half of
`MEMORY.md` on every agent whose store looks like this one's, which is every
agent measured so far.

The hand-repair appeared to work for the reason that makes it dangerous to
generalise: removing the entities from the render window let an unrelated
section surface inside `head -50`. The improvement came from what left the
window, not from what was selected into it.

LRN-024's own governing sentence is the correct lever and points away from the
threshold: *a ranked artifact has two orderings — the one that SELECTS and the
one that RENDERS — and a truncating consumer makes the render order the only one
that matters.* The read boundary is real; the remedy belongs at the render
order. §4.3 specifies it there.

## 4. The change

### 4.1 Producer: byte-safe parse and an honest fallback

In `src/commands/init.ts`, at all nine callsites in §1.1:

1. `echo "$VAR" | python3` becomes `printf %s "$VAR" | python3`.
2. `|| echo 0` becomes `|| echo UNKNOWN`.
3. Each reporting branch tests the sentinel **before** any numeric comparison,
   because `[ "$C" -gt 0 ]` on a non-numeric value is itself a shell error:

```sh
COUNT=$(printf %s "$RESULT" | python3 -c '...' 2>/dev/null || echo UNKNOWN)
if [ "$COUNT" = "UNKNOWN" ]; then
  echo "Memory export: could not read the export response — count unknown."
elif [ "$COUNT" -gt 0 ]; then
  echo "Memory export: $COUNT entities written to MEMORY.md ($EXCLUDED excluded below threshold)."
else
  echo "Memory export: no entities to export."
fi
```

An empty response body takes the same path as a mangled one, which is correct:
a request that returned nothing is an unknown, not a zero.

`project-map-refresh` keeps its text fallback but gains the same `printf %s`
parse and reports `counts unavailable` rather than `done` when parsing fails.

### 4.2 Deployed agents: one migration, two substrates

Per the Migration Parity Standard, `PostUpdateMigrator` gains an idempotent step
that rewrites the affected `execute.value` strings for already-installed agents:

- **Substrate A — legacy `.instar/jobs.json`** (the `groky` shape): patch each
  affected job's `execute.value` in place.
- **Substrate B — per-job manifests `.instar/jobs/instar/<slug>.md`** (the
  `echo` shape): patch the same strings where those manifests exist.

The step is a string rewrite matched on the exact shipped shapes, applied only
to the four `origin: 'instar'` slugs, and it is a no-op on any manifest already
carrying `printf %s`. Custom and user-namespace jobs are never touched. Running
it twice changes nothing the second time.

### 4.3 The read boundary: render order, not selection threshold

`MemoryExporter` renders grouped by domain and then by type
(`src/memory/MemoryExporter.ts:239,259`), so type order decides what lands in a
truncating consumer's window. The change is to make that order explicit and to
place the durable kinds (`lesson`, then `fact`) ahead of the rest, so that
`compaction-recovery.sh`'s `head -50` (`:168`) receives durable content by
construction rather than by threshold accident.

`minConfidence` keeps its shipped default of `0.2`
(`src/memory/MemoryExporter.ts:108`). No confidence threshold is changed by this
spec, and §3.3 is the reason.

### 4.4 A ratchet, so the shape cannot come back

A test asserts that no job template in `src/commands/init.ts` contains
`echo "$VAR" | python3` or `|| echo 0`. This is the structural half: the same
repair has now been made by hand twice at the artifact and lost both times, so
the guarantee has to live somewhere that fails a build.

## 5. Tests — all three tiers

**Tier 1, unit.** (a) Each patched template string, executed under `/bin/sh`
against a JSON fixture containing an escaped quote and an escaped newline,
yields the true count. (b) The same string against a mangled or empty body
yields the `UNKNOWN` branch and its sentence, and never a numeral. (c) The
migrator rewrites both substrates and is a proven no-op on a second run and on a
custom job. (d) `MemoryExporter` renders `lesson` before `fact` within a domain.

**Tier 2, integration.** A generated manifest is installed into a scratch agent
home, the job is executed through the scheduler's own `/bin/sh` path, and the
run ledger records the true count for a healthy response and the unknown
sentence for a broken one.

**Tier 3, E2E.** After a simulated update, an agent seeded with the legacy
`jobs.json` shape and an agent seeded with per-job manifests both end with
`printf %s` in all four jobs, and both still schedule and run them.

## 6. Consumer-side verification, per EVO-009

The manifest is not the consumer, and a grep over manifests is what failed to
settle LRN-025. Acceptance is read from the run ledger:

1. `GET /jobs/memory-export/history` on an updated agent shows a non-zero
   entity count where the response was parseable.
2. A deliberately broken response produces the `count unknown` sentence in the
   ledger — the failure is legible as a failure.
3. `head -50 .instar/MEMORY.md` on an updated agent contains lesson content,
   with `minConfidence` still at its shipped default.
4. Re-read `groky`'s manifest after the update: `printf %s` present, `echo "$VAR"`
   absent.

## 7. Multi-machine posture

Machine-local by design. Job manifests are per-agent files on one machine's
disk, the migrator runs per install, and nothing here writes replicated state or
emits a user-facing notice. On a multi-machine agent each machine runs its own
migration and converges independently; there is no cross-machine ordering to get
wrong and no notice needing one-voice gating.

## 8. Rollback

The template change is a string edit with no data migration; reverting the
commit restores the previous manifests for new agents. The migrator step is
additive and idempotent, so reverting it simply stops future rewrites — already
patched manifests keep working, because `printf %s` is correct under every shell
the scheduler uses. The render-order change alters only the order of sections
inside a generated file that is regenerated on every run.

## 9. What this spec deliberately leaves alone

`expires_at` being 100% NULL (EVO-011) and the export cap and per-item size
question (EVO-007) both touch the same subsystem and are each governed by their
own approved proposal. This spec changes no filter, no cap and no threshold, so
it neither blocks nor prejudges either of them. §3.3 records the measurement
those proposals will need — that confidence is effectively a constant column —
rather than acting on it here.
