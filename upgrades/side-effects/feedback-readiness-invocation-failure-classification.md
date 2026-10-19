# Side-Effects Review — a provider failure never demotes the readiness authority; the error names its cause; a stall is announced once

**Version / slug:** `feedback-readiness-invocation-failure-classification`
**Date:** `2026-10-19`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (a brake on the readiness authority is modified) — see below`

## Summary of the change

Restores two rules of the governing spec (`docs/specs/feedback-factory-operating-drain.md`). Line 121 gives a closed list of what demotes the readiness authority to proposal-only; a provider invocation failure (timeout, error, HTTP 429, rejected answer) is not on it, and the PIN path "is never the default throughput chokepoint". Line 270 forbids a feature-local retry workflow in this landing and asks it to expose stalled state and progress age. The three-strike demotion introduced on 2026-10-01 (itself a narrowing of the earlier any-failure demotion) is removed; the consecutive-failure counter stays as exposure, a stall episode is dated, `GET /feedback-factory/drain/status` reports `readinessProgress`, and after six failed ticks in a row one attention item per episode is raised. Separately, `CodexCliIntelligenceProvider` carries the last `error`/`turn.failed` message of a failed exec --json run into its thrown Error. Live cause: 2026-10-14, eight 429s on the approved model's lane demoted the authority for four days with an error that read only "exit 1".

## Decision-point inventory

- `FeedbackDrainService.reviewReadinessInChunks` tail — **modify** — the transient-failure branch no longer calls `demoteAuthority`; it counts, and past the threshold raises a notice.
- `ReadinessContractViolation` demotion and the spend brake — **pass-through** — unchanged.
- `alarmIfStalled` — **add** — signal only (one deduped attention item).
- `tryParseCodexResultEvent` — **modify** — also recognises `error` / `turn.failed`; the result path (agent_message / turn.completed) is unchanged.

---

## 1. Over-block

Nothing new is blocked. The only removed block is the demotion on repeated invocation failures, which the spec never licensed. The stall notice could fire for a model that is genuinely broken rather than rate-limited; that is the intended surface for it (the operator reads the named failure), and it cannot fire more than once per episode.

## 2. Under-block

- A model that fails every call forever is now called every tick instead of being switched off after three. Cost is bounded by the existing spend brake (each chunk reserves spend against the daily cap, which still demotes when reached) and by the job cadence. Accepted: the spec's design, and far cheaper than a four-day silent stop.
- The stall notice counts ticks, not wall time; a drain that does not tick (job not scheduled) raises nothing here. That is the scheduler's failure class, covered by the job-health surfaces, not this one.
- The carried error message is the LAST event; a run that prints a warning after the real failure would carry the warning. Codex prints config warnings first and the failure last, so the live shape is covered; a future ordering change degrades to the old "exit 1" text, never to a wrong cause being asserted as the only cause (the stderr tail is still present).
- The parser's pre-filter now JSON-parses any stdout line containing `"error"` or `turn.failed` on every exec --json call (previously only `turn.completed` / `agent_message` lines). Bounded by the existing oversized-line guard; a parse widening, not a behaviour change on the result path.
- `lastReadinessDiagnosis()` is global, not per authority generation, so the stall notice names the latest readiness-call row of any generation. Harmless with the single authority id in use; noted so a second authority id does not inherit it silently.
- A store upgraded mid-episode holds a failure count from the old rule but no episode stamp. The next strike stamps the episode (not only count 1), so the first notice after an upgrade is dated from that strike rather than from the pre-upgrade failures. Accepted: it errs toward a later, not a missing, notice.

## 3. Level-of-abstraction fit

Right layers. The drain service owns the brakes, so the classification change lives where the brake was. Progress age lives in the drain store beside the counter it derives from, and the route only reads it. The error cause is captured in the provider that owns the event stream, not in the drain (which would otherwise have to parse rollouts). Kept out: any retry/backoff between ticks (line 270 reserves that for the shared SelfHealGate lane), any batch-size change (line 300 governs expansion; the live failures were 10- and 4-candidate chunks, so size was not the cause).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change removes a brittle blocking authority and adds a signal.

The removed rule gave a brittle, cheap detector (three non-contract errors) authority over an operator-approved decider. The replacement is a counter and one notice; the remaining demotions are the spec's enumerated integrity cases. The provider change only enriches an error message.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The threshold (6 ticks) gates a notice, not an action, and the state is enumerable (no usable answer in a tick).

## 5. Interactions

- **Shadowing:** the pause alarm (`alarmIfPaused`) still fires for the spend brake and contract violations; the stall notice covers the case the pause alarm can no longer see. Different ids, different source contexts.
- **Double-fire:** one stall id per (authority, generation, episode start); an in-process set plus the attention store's id idempotency keep it to one item. A success clears the episode, so the next outage is a new id by design.
- **Races:** none new; the counter and episode stamp are written in the same tick that already wrote the counter.
- **Feedback loops:** none; the notice feeds nothing back into the drain.
- **Existing postures:** a store already in `proposal-only` with reason `readiness-authority-repeated-invocation-failure` (the Studio today) is untouched; its plain-words text remains for that legacy reason, and one dashboard approval restores it as before.

## 6. External surfaces

- Operator: one new attention item class, NORMAL priority, through the existing attention funnel; the brake wording in CLAUDE.md changes.
- Operator surface (Mobile-Complete): no new operator action. Restore for the spec's brakes remains the dashboard Feedback Drain card.
- Other agents/install base: inert unless the operated drain runs; the Codex error text change applies to every exec --json call (longer, bounded, scrubbed error strings).
- Persistent state: two new `drain_meta` keys per authority generation; the old code ignores them.

## 6b. Operator-surface quality

No operator surface file changed. The attention text IS an operator surface read on a phone: it leads with what is failing, says in the first two sentences that nothing is paused and nothing needs approval, and names no path or command. Secrets: the carried cause is scrubbed over a 3,000-char window BEFORE it is cut (same order as `outputExcerpt`), in both the provider's thrown Error and the notice text.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the drain runs on its canonical owner only; the counter, episode stamp and notice are raised there. The attention item is visible pool-wide through the existing merged attention read. The provider change is per-process.

## 8. Rollback cost

Pure code change; revert and ship a patch. The two new `drain_meta` keys are ignored by the old code. The CLAUDE.md wording would stay narrowed on migrated agents (harmless text).

---

## Conclusion

Closes the mechanism behind the 2026-10-14 four-day silent stop without touching the PIN boundary for the spec's integrity brakes, and makes the next such failure diagnosable from its own error text. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only)
**Independent read of the artifact: concern raised** — one change required before merge, applied: both the provider's `boundedErrorEvent` and the notice's `cause` sliced the text BEFORE scrubbing, so a secret straddling the cut could escape the patterns; both now scrub a 3,000-char window first and cut after (the repo's `outputExcerpt` order). Advisory points, all acted on or recorded: the mid-episode upgrade edge (a pre-existing count with no episode stamp → the stamp is now written whenever it is missing, with a store test); the oldest-wording migration chain (a test now starts from the pre-2026-10-01 wording); the pre-filter widening, the global `lastReadinessDiagnosis()`, and the phone-read operator surface are recorded above. Confirmed without change: no retry/backoff/restart/config/tick re-run anywhere (spec line 270 holds); the PIN restore path for the spend brake and contract violations is untouched; the notice is once per episode across restarts (the durable attention store dedupes by id); the stderr tail and unknown-flag hint are still present ahead of the carried event; the tests drive the real store, service, spawn path, migration, HTTP route and job runner.

---

## Evidence pointers

Drain store `drain_audit` rows 2042–2052 (Mac Studio); Codex rollouts under `~/.codex/sessions/2026/10/13` (T21-30-49) and `2026/10/14`; ACT-114; tests listed in `upgrades/next/feedback-readiness-invocation-failure-classification.md`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. No self-triggered restart/swap/respawn/kill controller is added or modified: the removed branch was a demotion (a stop), the added branch is a once-per-episode notify bounded by the counter's reset on success — not applicable beyond that bound.
