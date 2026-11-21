# Convergence Report — Projection Calibration

**Spec:** [docs/specs/projection-calibration.md](../projection-calibration.md)
**Slug:** `projection-calibration`
**Stopped at:** 2026-11-17, round 5 (the round cap set for this spec)
**Iterations:** 5
**Final-round design findings:** 6 (5 written into the text as single rules, 1 accepted; none about safety, security or data loss)

---

## Cross-model review: codex-cli:gpt-6-astra

A GPT-family pass (GPT-6 Astra through the codex CLI) ran and returned findings in all five rounds. A Gemini-family pass (Gemini 4 Argon) also ran in all five rounds; it was called directly through the Gemini CLI with the metered key, because the skill's own `gemini-cli` family reports `gemini-not-authed` on this machine. The clean-door Claude family was not run.

**Read this before approving:** the review did not end on a quiet round. It stopped at the cap with the count of design findings flat at six for two rounds. Details under "Convergence verdict".

## ELI10 Overview

Instar agents tell people how long things will take, and nobody checks. This spec makes every estimate a record: what the task is, the one finish line a machine can check, the agent's own first guess, and the conditions it was made under (autonomous or not, which models, which machine, how many sessions, how many review rounds). When the finish line is crossed, the real time is filled in from GitHub or from a person's confirmation, never from the agent's memory. The next time the agent estimates a similar task, the server shows it how its past guesses ran before it says a number to anyone.

Waiting is kept apart from working. Time spent waiting for a person's answer is measured from approval cards. How long a pull request sat open is shown next to the result. A missing measurement reads "unknown", never zero.

Other agents learn from a small file of numbers shipped with each release. It starts with numbers from the maintainer's own agents and can later include numbers (no text) from other installs whose owners turn on a separate switch. Nothing in the design blocks a message, rewrites an estimate or alerts the operator.

## Original vs Converged

- **Originally** the spec measured "agent work time" by counting usage-log activity in five-minute buckets. **Now** there is no work-time meter. Why: usage rows are written at the end of a call, per machine, per conversation; they cannot tell a forty-minute call from a ten-second one and would count unrelated work. Time is now elapsed, person wait and PR-open time, all from clocks the agent does not write.
- **Originally** eight kinds of finish line counted, including the agent marking its own promise delivered. **Now** three: a pull request merged, a person confirming, and self-report, and only the first two feed the correction. Why: the agent could satisfy most of the others by itself.
- **Originally** the agent read its track record, then recorded an estimate. **Now** it records its own guess first and the track record is the reply. Why: otherwise the "raw" guess is already shaped by the correction and the correction ends up correcting itself.
- **Originally** a re-estimate replaced the old one. **Now** a re-estimate of the same finish line is scored against the first number, and a changed finish line is counted separately and not scored. Why: "4-6 weeks", then a day later "two more hours", would otherwise be recorded as accurate.
- **Originally** waits the agent declared were subtracted. **Now** only waits ended by a person's phone tap are, and PR-open time is never subtracted. Why: the agent could shorten its own result by declaring itself blocked, and a draft PR opened at the start would swallow the whole build.
- **Originally** the unrecorded-estimate reminder was an advisory. **Now** it travels in a separate field shown after sending. Why: the reply script holds any message that has an advisory, and repeated advisories page the operator.
- **Originally** averages were over everything forever, and three ways of catching unrecorded estimates existed. **Now** the read uses the 20 most recent finished rows with all-time beside it, and one reminder remains.
- **The fleet rule** ("at least three installs") is now described as what it is: a floor under a maintainer's judgment that stops direct read-back, not a privacy proof.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|---|---|---|---|---|
| 1 | all five reviewers | 49 | 13 | Full rewrite: activity meter, five check forms, document and sentinel capture, ranking removed |
| 2 | all five reviewers | 16 | 25 | Sections 2-7, decision table, limits, detectors, posture; page check removed |
| 3 | integration, decisions/lessons, GPT, Gemini | 9 (a tenth was checked against source and voided) | 19 | Sections 3, 4, 6, 7; net time and re-estimate rules; note moved out of advisories |
| 4 | decisions/lessons, GPT, Gemini | 6 | 16 | Sections 2-4, 7; Local Verify check removed; recency window; presence taps |
| 5 | decisions/lessons, GPT, Gemini | 6 | 17 | Single-rule edits only (see Left behind) |

Standards-Conformance Gate: ran (5 flags) in round 1; ran (5 flags) in round 2; ran (9 flags) in round 3; ran (6 flags) in round 4; ran (6 flags) in round 5; ran on the final text (3 flags, 100 standards checked, parent-principle fit: fit, not degraded).

Reviewer models, per round: the internal reviewers ran as subagents of the authoring session on `claude-fable-5-2` in all five rounds. The six internal lenses (security, scalability, adversarial, integration, decision-completeness, lessons-aware, with the multi-machine, self-heal, detector, decision-point and fixed-limit checks) were run as three reviewers carrying two lenses each, every round; no lens was skipped. GPT: `gpt-6-astra`, status ok, all five rounds. Gemini: `gemini-4-argon`, all five rounds.

External pass content hashes: round 1 `1a4d00f9`, round 2 `d0901a8a`, round 3 `72ffad0b`, round 4 `48f27a92`, round 5 `d6ad48f4`. The final text differs from the round 5 hash by the single-rule edits listed under Left behind; those edits were not re-read by any reviewer.

## Full Findings Catalog

**Round 1 (49 design).** Themes, with the resolution taken:
- Work time is not measured by counting usage events; pool scope has only hourly rollups; topic activity is not task activity (GPT, integration, adversarial, gate) → meter removed.
- "Measured" forms the agent controls: commitment delivery, autonomous-run met, agent-writable pages (GPT, adversarial) → provenance classes; only external and person feed the correction.
- Raw estimate contaminated by the session-start ratios (Gemini, adversarial, lessons) → two-step recording, no ratios at session start.
- Open-overdue rows mixed into medians with no rule (GPT, lessons, integration) → listed beside the medians.
- Start-of-clock ambiguity (GPT, integration, adversarial) → clock starts at recording.
- Range denominator undefined; multiple milestones per projection (Gemini, lessons) → geometric mean; one projection, one milestone.
- Event-only actuals can be missed (GPT) → reconcile pass over stored state.
- Done-check evaluator needs a bound project and returns no time; Local Verify has no request time (integration, lessons) → shared GitHub read helper; queue wait dropped.
- Advisory escalates to an operator notice; the sentinel sweep cannot do what was claimed (integration, lessons) → non-escalating note; sweep removed.
- Sweep without brakes; five-minute floor unsupported (gate, lessons, integration) → hourly pass, budget, backoff, breaker.
- Three-install rule does not hold against differencing or collusion; telemetry allow-list does not exist; person-wait data describes the operator (security, lessons, gate) → rule restated as a floor, explicit validator, own switch, no person-wait data.
- Prompt injection through condition strings; server-side fetch of agent URLs (security) → server-filled fields, pattern, later the page check removed.
- Fabricated person projections (adversarial) → marker must resolve to a human-authored message with a literal excerpt.
- Over-building relative to the request (lessons) → document seam, sentinel sweep, ranking, quiet-hours accounting cut.

**Round 2 (16 design).** Overlapping waits subtracted twice (GPT, Gemini, lessons, gate) → union, later person wait only. Kinds of time mixed across buckets (GPT) → kind is part of every bucket. Evidence dated before the estimate (GPT) → excluded. Completion bias and the false claim that closing cannot help (GPT) → cohort counts. Person rows in agent history (GPT) → excluded. Re-estimate before the deadline erases a miss (adversarial) → chain scored from the first estimate. No write path for a person's confirmation by message; `uncheckable` not replicated; degradation report would alert the operator (integration) → confirm route, check-state records, internal-only report. Unbound PR treated as unreadable; missing decision rows; advisory flag read as off (lessons) → pending is not unknown; rows added; flag follows the main switch. DNS-rebinding on page fetch (Gemini) → page check removed.

**Round 3 (9 design, 1 voided).** Re-estimate versus changed milestone (GPT, lessons) → separated. Actual depends on which machine looked first (GPT) → earliest evidence, later moot when the Local Verify form was removed. Telemetry retry counted twice (GPT) → install-and-window key. Draft PR swallows net time (Gemini) → PR-open time never subtracted. Stated ratio counted once per successor (Gemini) → one row per chain. Reply script holds messages on any advisory; acknowledgement path still escalates (integration) → `notes[]` field outside the advisory paths. No-card treated as zero wait; one-minute floor invents a measurement (lessons) → unknown; floor deleted. Voided: "Local Verify outcome is `pass`" (security/adversarial); source line `record.ts:14` shows `'success' | 'failure' | 'error'`.

**Round 4 (6 design).** Chain evidence eligibility used the successor's clock (GPT) → the first projection's. Net estimates given wall-clock overdue bounds (GPT) → own kind, unknown when unmeasurable. Fleet prior promised fields it cannot carry (GPT) → medians, banded n and install count only. Local Verify first-head success dates a milestone too early and cannot be bound late (Gemini) → form removed. Old misses over-correct for ever (Gemini) → 20 most recent rows, all-time beside. PIN tap ended a "person" wait (lessons) → presence tap only.

**Round 5 (6 design).** PR set finalised by polling time (GPT) → accepted, see Left behind. Person and agent clocks start at different recording times (GPT) → a person's clock starts at their message. Fleet median undefined for out-of-range install medians (GPT) → such buckets left out. Bucket key declared or observed model (Gemini) → declared. `observed` trigger on peers undefined (Gemini) → defined, one scan per machine per projection. Approval waits scored as zero (lessons) → approval intervals added.

**Final constitution check (advisory, 3 flags).** Text caps borrowed from Work Board defaults; a bound PR's merge stands for the milestone; a rejected model name is stored as unknown (a "name rejected" flag was added). The final-round reviewer judged the same family of flags wording-level or not applicable: the caps and the credential refusal are the existing card door; the milestone is defined as the merge and `person-confirms` covers what a merge cannot prove; capture resting on the agent's call is the residue of auto-capture being cut by review.

## Proportion

Tier 2 (new replicated store, routes, hook change, telemetry section; spec about 330 lines). Five rounds used; the skill's Tier 2 cap is six and this spec's brief set about five. ⚠ The two outside reviewers returned three and two new design findings in every one of the last three rounds, each time on newly exposed edge rules; that pattern is why review was stopped rather than extended.

## Left behind

See the spec's `## Left behind` section, which is the authoritative list: one design finding accepted at the cap, five single-rule edits written after the last review round and not re-read, and ten precision items with their queues.

## Convergence verdict

Stopped at round 5, the cap. This is **not** a quiet-round convergence: the final round still produced six design findings. None concerns safety, security or data loss; five were single rule choices that are now in the text with a named unit test each, and one is accepted with its reason. The design itself has been stable since round 3: one ledger, three finish lines, evidence only from GitHub or a person, the read as the reply to recording, nothing blocking. Rounds 4 and 5 changed edge rules, not structure, and the internal security, adversarial, scalability and integration lenses were clean in both.

The spec is ready for the operator's review. To approve: set `approved: true` in the spec's frontmatter. Stage 1 is then built through `/instar-dev`, where the left-behind rules are carried into code review.
