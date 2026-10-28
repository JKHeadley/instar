# Side-Effects Review — Trustworthy machine load, P4 (model assessment of machine load)

**Version / slug:** `trustworthy-machine-load-p4`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `reviewer subagent (independent read, appended below)`
**Tier:** 2 (spec-driven; `docs/specs/trustworthy-machine-load-and-mesh-floor.md` Part B4, converged over 3 cross-model rounds, approved by Justin 2026-10-25 14:19 PDT). Size: 1 new source file (`MachineLoadAssessor.ts`, ~480 lines), 8 modified source files (server wiring, route, types, dev-gate registry, capability index, template + migrator awareness card, one message string in `SessionManager`) + 3 new test files + 2 touched test files. Effort: 0 further spec rounds, 1 commit attempt planned; in proportion.

## Summary of the change

Phase 4 of the spec. **B4:** `MachineLoadAssessor` runs once a minute on the serving-lease holder (single machine: always). For each machine in the pool view it looks for (a) a disagreement between the machine's OWN load verdict and the OUTSIDE view (`own-ok-but-unreachable`: verdict ok/elevated while direct pulls are failing as `struggling`/`refusing`; `own-impaired-but-answering`: verdict impaired while the last pull answered in under 2 s) or (b) a contradiction inside its own report (`memory-free-but-os-pressure`, `memory-short-but-os-normal`, `cpu-idle-but-load-high`). When one is present it sends Jev (TypeSafe, `jev-1.13.0`) a short text of load numbers, the machine nickname and fixed words, and asks it to choose `healthy_busy` / `overloaded` / `impaired` / `network_problem` / `cannot_tell`. When Jev's chosen probability is inside the shared cascade band (≤ 0.70), the shared `JevCascade` referee (GPT-6 Luna via the Codex fast tier) answers four true/false statements; exactly one true names the label, otherwise `cannot_tell`. Fifteen minutes later the same pass reads what happened to that machine (`recovered` / `still-overloaded` / `timed-out` / `restarted` / `unknown`) and grades the label `right` / `wrong` / `unknown`. Rows go to `logs/machine-load-assessment.jsonl`; `GET /load-assessment/summary` summarises labels, who decided, conflicts, outcomes, grades and accuracy.

**Memory-guard message:** the reroute spawn gate's refusal text now carries its numbers (`host memory pressure is high (81% used, i.e. 100 minus free+inactive+purgeable; thresholds high 75%, critical 90%)`). Investigation of the 2026-10-27 08:28 PDT refusal on the Mac Studio found the gate was right: the reaper audit at 15:25–15:28Z recorded 17.8–22.7% available, 40–47% of RAM in the compressor, 10–18k decompressions/s and kernel memory-pressure level 2 (warn). The "41% free" quoted at the time is a different macOS figure (`memory_pressure` free percentage / `kern.memorystatus_level`) that counts compressible memory as free. No threshold changed; only the message, so the next refusal can be checked against the right number.

## Decision-point inventory

- `MachineLoadAssessor.tick()` — **add**: an advisory labeller. It decides only WHICH machines to ask about and WHAT label to log. No other code reads its output.
- `SessionManager.evaluateRerouteGate()` — **modify (message text only)**: the refusal reason string gains the used-memory percentage and thresholds. The allow/refuse decision and its inputs are unchanged.

---

## 1. Over-block

Nothing is refused, delayed or moved by this change. The gate edit changes a string after the decision is made.

## 2. Under-block

- Conflicts outside the five named shapes are not asked about (for example a machine whose verdict is `saturated` and whose pulls time out — that is consistent, not a disagreement). The spec asks for a label when views disagree or signals conflict; consistent overload is already handled deterministically by P2/P3.
- A peer whose report is older than 10 minutes is not assessed (no current "own view" to compare). A machine that has gone fully silent is the stale-owner path's concern.
- **Grading location.** The spec says the labels are "graded by the decision-quality meter". The meter's grade path (`annotateDecisionOutcome`) grades decisions the `IntelligenceRouter` minted; a Jev call is a direct HTTP call with no router correlation id, so it has no row there to grade. The assessor therefore records each outcome and grade in its own log, with the same right/wrong/unknown vocabulary, and exposes accuracy on its summary route. The Luna referee call does go through the shared provider funnel, so it is metered and carries a breaker correlation id like every other `askReferee` call. This is a measured placement of the same grading, not a missing piece.
- The outcome reading is coarse (one look at +15 min). A machine that recovered and relapsed inside the window reads as its state at +15 min.

## 3. Level-of-abstraction fit

Right layer. It reads the one pool view (`MachinePoolRegistry.getCapacities()`) that `GET /pool`, placement and the shed planner already read, reuses the existing Jev pattern (dev gate, vault key, daily cap seeded from the log, metering) and the shared `JevCascade` referee, and adds no new transport or report field. It does not feed placement/admission: the spec says the model "informs reports and attention wording; it never triggers an action", and this phase ships the shadow half only — nothing consumes the label yet, so the soak can show whether it is worth showing.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No authority. It is a signal producer whose signal is, for now, consumed only by a read route. No gate, placement, admission, shed, attention or messaging path imports it.

## 5. Interactions

- **Overload admission / shed (P2/P3):** none. They read `loadVerdict` and liveness directly; the assessor never writes them.
- **Lease handover:** only the lease holder asks. Outcomes are read on whichever machine made the label (even after it lost the lease), so a handover does not orphan a grade; a restart re-seeds ungraded labels from the log (up to 2 h old).
- **Jev budget:** its own daily cap (default 200) and its own metrics feature key (`jev-load-assessment`); it does not share the other shadows' caps. One call at a time; per machine at most every 10 min, the same conflict at most every 30 min.
- **Referee budget:** at most one Codex fast call per unsure label; uses its own breaker (built separately in server wiring) so a referee trip cannot pause another component.
- **CLAUDE.md:** the new card's heading ("Machine Load Second Opinion") deliberately avoids the phrase "Machine Load Assessment", which the older load-assess.sh card's migrator sniffs on; the E2E test pins that both cards land.

## 6. External surfaces

- Egress: load numbers, a machine nickname, the platform and fixed words to TypeSafe, secret-scrubbed; the same text to the Codex referee when Jev is unsure. No user or conversation content.
- Route: `GET /load-assessment/summary` (Bearer, read-only; 503 when not constructed). Internal prefix registered in `CapabilityIndex`.
- Config: `intelligence.jevLoadAssessment` (new, omitted by default ⇒ dev-gated). No ConfigDefaults block is written: code defaults apply, matching "omitted enabled" semantics.
- File: `logs/machine-load-assessment.jsonl`.
- Message text: the reroute gate's degradation report and `RerouteRefusedError` message gain numbers; nothing parses that text (checked with grep: only the sibling test matches on `memory pressure is critical`, which still matches).

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, lease-holder asks. The input is the lease holder's pool view, which already merges every machine's report and the holder's direct evidence. The log and summary are on the machine that asked; after a lease move the new holder starts its own log rows. A pooled read is not added because the instrument is a soak measurement read by the maintainer, and one machine (the holder) produces nearly all rows.

## 8. Rollback cost

`intelligence.jevLoadAssessment.enabled: false` (read live, next tick). Code: revert the PR; nothing else reads the log. The message change reverts with it.

---

## Second-pass review (independent reviewer subagent, 2026-10-27)

**Concern raised:** after a restart, `seed()` restored labels up to 2 h old and `settleOutcomes` graded them ~60 s after boot — against outcomes the restart itself caused: the assessor's own `bootId` changes (graded `restarted`, i.e. trouble), and a peer reads `stale` until the first direct pull lands (graded `timed-out`). Both bias the accuracy figure this soak exists to measure.

**Resolution:** a label made before this process started is now graded `unknown` (`settleOutcomes` compares the label time with the assessor's `startedAtMs`); the unit test for restart seeding pins `{ right: 0, wrong: 0, unknown: 1 }`. Two wording points were also taken: the orphaned JSDoc above `currentMemoryPressure` is restored to its method, and the evidence text reads "N% used, i.e. 100 minus free+inactive+purgeable, read just after the check" (it is a second reading, so it can differ slightly from the label it explains; nothing parses it). Everything else the reviewer checked (advisory-only, tick flow, cap seeding, referee path, server wiring, no decision change in `SessionManager`, the grading-location claim) was found correct.
