# Convergence report — Periodic Goal Re-Alignment

**Spec:** `docs/specs/periodic-goal-realignment.md`
**Rounds:** 7
**Reviewer:** cross-model, `codex-cli` / `gpt-5.5` (cross-family — a non-Claude read, which
is the point: it does not share this author's blind spots)
**Standards-Conformance Gate:** **unavailable** — `POST /spec/conformance-check` returns
`spec not found` for a spec that exists on disk in an unmerged worktree; the route resolves
only within its own jailed specs directory. Recorded honestly rather than skipped. It is
signal-only and never blocks convergence, but its absence means the per-standard flags did
not feed these rounds. <!-- tracked: ACT-1388 -->
**Internal reviewers:** run sequentially by the authoring session rather than as parallel
subagents (this session operates under an explicit no-subagent constraint). Stated plainly
because it is a real reduction in review diversity versus the skill's default shape — the
cross-family pass is what carried the independent-perspective load here.

## Why this spec exists at all

The operator has manually re-grounded this topic on **2026-07-23**, **2026-07-26** and
**2026-07-27**. On the 27th, verbatim: *"I'm going to continue to ask you to do this
periodically until the infra is robust enough that I DON'T HAVE TO."*

The spec was authored 2026-07-24 from the 07-23 directive and then sat as an unconverged
draft for three days while the failure it prevents recurred twice more. That is the
strongest argument in the document and it is not a hypothetical.

## Round-by-round

| Round | Verdict | What it caught |
|---|---|---|
| 1 | MINOR | 7-day lookback erases standing goals; LLM digest is a lossy authority; fail-toward-silence hides a broken checker; no alternatives considered; logs leak intent; **no acceptance case proving the signal is acted on** |
| 2 | **SERIOUS** | The round-1 fixes contradicted each other — Goals promised age-independent persistence while the builder was still lookback-bounded. Also: "addressed" too load-bearing to leave open; signal-only vs required acknowledgement is a gate unless monitored; prompt-injection via pasted operator content; provenance links deferred prematurely |
| 3 | MINOR | Ledger keying would merge restatements; extraction is the hidden authority; reviewer input too narrow; event/concurrency model implicit; **false alignment** uncovered; internal jargon |
| 4 | MINOR | A merged PR proves work happened, not intent met; builder implied a second write path; idempotence underspecified across the LLM step; sampled audit shares model bias |
| 5 | MINOR | Missed extraction invisible forever; `needs-operator-confirmation` used but never defined; LLM-authored completion predicates re-open self-closure; supersession ambiguity deletes live priorities |
| 6 | MINOR | Candidate-priority inbox needed for immediate visibility; escalation path for repeatedly ignored briefs; ambiguous acknowledgements ("ok", "ship it", silence); four checks risk becoming four alarms |
| 7 | MINOR | **`single-run-completable: true` was no longer honest** — split into three phases; cache key must include the classification cursor; planner contract should be structured fields |

Round 2 escalating to SERIOUS is the most useful thing in this table: fixing round 1
introduced a contradiction, which is exactly what a second independent read is for.

## The findings that changed the design most

1. **A goal persists until superseded, not until it is old.** A recency window alone would
   have begun dropping the operative directives in this topic — 2 to 4 days old — precisely
   as they became load-bearing. Replaced by a durable ledger that recency never trims.
2. **A signal that changes nothing is indistinguishable from no signal.** Acceptance now
   requires the next plan update to carry `servesPriorityId` / `rejectsPriorityId`, as a
   *monitored invariant* rather than a gate.
3. **The compass that always says north.** Silence and a steady stream of `aligned` fail
   identically. Answered with a deterministic canary and a model-diverse sampled audit —
   the canary deliberately involves no model, because the judgement layer is exactly what
   may have failed.
4. **A merged PR is not a satisfied priority.** Artifact-presence as closure would hand the
   agent self-closure through a side door.
5. **Phasing.** The spec grew from 8 KB to 38 KB across convergence. Shipping it in one run
   would be unreviewed momentum — the failure this spec is about.

## What remains open (deliberately)

Three open questions are carried into Phase 1 rather than resolved on paper: the cadence
default (60 min is a guess), whether the reviewer should see prior verdicts (risks
anchoring), and whether a `diverged` verdict should annotate the run's state file. All
three are empirical and Phase 1's dry-run soak answers them better than another review
round would.

## Honest convergence assessment

Verdicts went MINOR → SERIOUS → MINOR × 5, with each round's findings narrower than the
last. Rounds 6 and 7 produced tuning-level concerns and one real structural catch (phasing).
**This is not "the reviewer ran out of objections"** — a capable reviewer will always
produce findings against a 38 KB spec. The claim is narrower: the findings stopped being
load-bearing, and the remaining ones are better answered by Phase 1's measurements than by
more argument.

The single largest residual risk is stated in the spec and worth repeating here: this design
puts an LLM extraction step underneath something called a ledger. The candidate inbox, the
deterministic canary and the missed-extraction audit exist because of that, and Phase 1
ships *only* the observable half precisely so that risk is measured before anything depends
on it.
