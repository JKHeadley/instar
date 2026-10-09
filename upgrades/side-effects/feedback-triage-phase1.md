# Side-Effects Review — Feedback triage, phase 1 (ranking, work/hold/ignore, operator surface)

**Version / slug:** `feedback-triage-phase1`
**Date:** `2026-10-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Implements phase 1 of `docs/specs/feedback-triage-and-execution.md`: a registered frontier-model triage authority (`feedback-triage`) that reads each feedback Initiative's scrubbed evidence and decides `work` / `hold` / `ignore`, wrapped in deterministic floors; triage tables in the existing `feedback-drain.db` (owner-epoch fenced); disposition → Initiative mapping (`work` keeps it active and closes `class-review`; `hold`/`ignore` pause it, never archive); re-queue on timer or new reports with throttles and backoff; ranked queue, summary, tick, authority proposal/approve, PIN plan/commit and action-list routes; a once-a-day operator action list; a self-heal ladder for triage outages; shadow mode for `ignore`; a dashboard Triage section; two built-in jobs; CLAUDE.md template + migration; registry enrolments. New code lives in `src/feedback-factory/triage/`; wiring touches `routes.ts`, `AgentServer.ts`, `FeedbackDrainStore.ts` (shared connection), `InitiativeTracker.ts` (digest exclusion), `PostUpdateMigrator.ts`, `templates.ts`, config defaults and registries. The executor (spec §4) is phase 2 and not in this change; its plan actions are refused with a clear "not available" reason.

## Decision-point inventory

- `feedback-triage` disposition/severity/priority — add — LLM arbiter within deterministic floors (judgment-candidate, declared in the spec).
- Never-ignore second opinion — add — second model family; disagreement or failure → hold.
- Re-queue on timer/new reports — add — deterministic invariant.
- Ignore-live switch — add — PIN-bound operator record only; config can turn it off but never on.
- Readiness authority / drain — pass-through — unchanged; triage reads Initiatives the drain already created.

---

## 1. Over-block

`hold` is the conservative default, so the system errs toward holding: low confidence, truncated evidence, security-shaped wording, a missing second family, or an unreadable quota all produce `hold` rather than `work`/`ignore`. A genuinely ignorable item can therefore sit in `hold` (it comes back on a timer and is graded). During shadow mode every would-ignore is applied as a hold by design. No user-facing message or action is blocked; holds only affect queue position.

## 2. Under-block

- The model can mark low-value work as `work`; that only queues it (phase 2 adds execution, whose output still needs operator review).
- Silence-based grading is weak evidence; it is reported separately and excluded from graduation thresholds.
- `already-fixed` only fires on exact-id PR matches; human fixes without ids fall to a short `possibly-fixed` hold rather than being closed.

## 3. Level-of-abstraction fit

Triage runs after the existing readiness authority, on Initiatives the drain already created, and reuses the drain's DB connection, owner fence, authority-record table, proposal pattern and stage-budget helper (moved into `drain/stageBudget.ts` so both share it). It does not write the legacy `Cluster.status` lifecycle or report statuses, which the parent spec reserves to the curator. It enrols in the existing decision-quality census rather than inventing a parallel meter; its finer evidence-strength grades live in its own table because the meter only knows right/wrong/unknown.

## 4. Signal vs authority compliance

- [x] Yes — but the logic is a smart gate with full context (LLM-backed).

The disposition is decided by the registered frontier-model authority reading the full scrubbed evidence. Deterministic floors only move decisions toward the conservative `hold` (never toward `ignore`), so no brittle check holds authority to dismiss feedback. The brief/length filter only truncates and flags; it never blocks.

## 4b. Judgment-point check

The competing-signals decision (is this item worth work?) is a judgment point with a declared floor and arbiter (spec `## Decision points touched`). The static rules added (timers, throttles, caps, quiet window) are invariants, not judgments of the item.

## 5. Interactions

- Shares `feedback-drain.db` and its owner-epoch fence with the drain; new tables only, no changes to drain tables' semantics. Drain tests pass after the stage-budget helper move.
- InitiativeTracker digest: feedback-linked Initiatives are summarized in one line instead of per-item flags, so the 426-item backlog does not flood the digest.
- Attention queue: only self-heal exhaustion and authority mismatch raise items, deduped by key.
- Decision-quality meter: triage enrolled like readiness; the second opinion is listed as pending enrolment in the census.

## 6. External surfaces

- New authenticated routes under `/feedback-factory/triage/*` (dev-gated; 503 on the fleet).
- One Telegram action-list message per day at most, at 08:00 host time, never 23:00–07:30, only when something new needs the operator, at most 10 items.
- Model calls to the readiness `capable` routing (Codex on Echo), capped per day and paused when the serving account's quota is high or unreadable.
- Dashboard: new Triage section on the Feedback Drain tab.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: the section opens with a plain-sentence status, then the authority approval card (when awaiting approval) and the ranked work list; the ignore-live button appears only when evidence recommends it.
2. **Zero raw internals as primary content?** Yes: all values are written as plain text via `textContent`; ids appear only as small supporting text next to titles.
3. **Destructive actions de-emphasized?** There is no destructive action in phase 1; turning ignores live is reversible and requires a rendered plan plus PIN confirmation.
4. **Plain language + phone width?** Labels are plain sentences mirroring the existing readiness card; it reuses the existing Spend-tab button and card classes, which already lay out at phone width.

## 7. Multi-machine posture

**proxied-on-read.** Triage state is single-writer on the drain's canonical owner (owner-epoch fenced). Ticks on a non-owner answer 409 naming the owner (jobs treat that as a healthy no-op). GET routes on a non-owner fetch the owner's response, fall back to the last copy tagged `stale`, then 503 naming the owner. The daily action list is sent only by the owner (one voice). No URLs are generated; durable state is not topic-bound, so nothing strands on topic transfer.

## 8. Rollback cost

`feedbackFactory.triage.enabled: false` stops all ticks and routes; no records are deleted. Paused Initiatives stay paused and can be reactivated through the existing Initiative API. A revert of the code is a normal patch release; the new tables are inert without the code.

## Conclusion

Phase 1 adds decision-making that only re-ranks and parks work items, never deletes or closes product state, and holds by default when unsure. Safe to ship dev-gated with ignore in shadow.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact:** concur

First pass raised one high and six medium concerns (non-owner proxy header, withheld-evidence floor, action-list notified stamp, tick deadline on second-opinion and sample calls, duplicate-bonus accumulation, action-list stamping, stale Codex quota) plus four low ones. All eleven were fixed with regression tests; the reviewer re-read the diff and concurred on each. Non-blocking note: a weekly-sample decision whose packet is missing stays ungraded and may be re-picked in a later window (bounded).

## Evidence pointers

- Unit: `tests/unit/feedback-factory/triage-*.test.ts`, `tests/unit/feedback-triage-ui.test.ts` (106 passed).
- Integration: `tests/integration/feedback-triage-routes.test.ts` (7 passed).
- E2E: `tests/e2e/feedback-triage-lifecycle.test.ts` (with the drain lifecycle test, 7 passed).
- `tests/unit/self-action-convergence.test.ts` (213 passed).

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` (this change adds self-triggered controllers; no agent-authored-artifact defect is fixed).
- **`closure`:** `guard`
- **`guardEvidence`:** enforcement `ratchet`, citation `tests/unit/self-action-convergence.test.ts`. How it is caught: `feedback-triage-tick` re-triages an item at most once per 24 h (persisted stamp) under the daily call cap of 150 with sub-caps 50/30; `feedback-triage-action-list` notifies each item once ever (persisted `notifiedAt`), one message per day, quiet window; `feedback-triage-self-heal-probe` makes at most 3 probes per episode with a flapping breaker at 3 episodes in 7 days, persisted. All three are registered in `SELF_ACTION_CONTROLLERS`, and the ratchet proves the action count is horizon-independent, including across restarts.
