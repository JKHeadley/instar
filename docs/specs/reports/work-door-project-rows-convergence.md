# Convergence Report — Project rows that say something

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex CLI, gpt-6-astra) ran on every one of the six rounds, each on a changed spec body. The Standards-Conformance Gate ran every round. The internal reviews ran as Claude subagents (claude-opus-5-5): two lens-split reviewers in round 1, one all-lens reviewer in each later round.

## ELI10 Overview

The Projects list on the Work page shows each project the Chief of Staff tracks, but it said almost nothing: a goal, a list of requirements, and one link. The Chief of Staff already knows much more: a sentence about where each project stands, why it is waiting on the owner, which done items only the owner can judge, when it checks next and whether it gave up. This change puts all of that on the row, and adds four owner actions on the phone: Ask for an update (no Face ID; the Chief of Staff checks now, or on its next round), Pause / Resume (Face ID), Mark checked on an item only the owner can judge (Face ID), and Finish (Face ID, closes the project when everything is checked and every automatic check passes on fresh evidence).

The main tradeoffs: the owner's taps are the only way to pause, mark or finish from the phone (never the agent, never the dashboard PIN, which any session can read); an Ask for an update never runs more often than the loop itself ticks; and nothing closes a project except the owner's explicit Finish or Confirm-done.

## Original vs Converged

- Originally, marking the last judged item would close the project at some later check. After review, item checks never close anything: a separate Face ID "Finish" names the close in its signed line and runs the existing Confirm-done steps at the tap, with evidence gathered then and a re-check of the owner's checks and the binding version immediately before the close is written.
- Originally, an item check was bound to the item's text only and voided by any binding edit. Now it is bound to a hash of the goal, item id and text (JSON-encoded, unambiguous), voided by a change to that content or by a reopen, and the newest event per item is taken first so a withdrawn check can never come back after a wording revert. Items with a shared id cannot be checked alone; Finish confirms them.
- Originally, Ask for an update was refused on a standby or within a fixed 10-minute gap. Now it is never refused for timing: it runs at once on the machine that runs checks when the last check is a tick old, and otherwise writes a replicated, HLC-ordered request that the holder's next eligible tick honours. Restarts it may cause share one budget with the ticks, and a tick that fires during it runs right after.
- Originally, checks happened only after Face ID was spent. Now the challenge route prechecks every project action, so a known refusal never reaches Face ID.
- Originally, the read cut notes and item text and changed existing fields' meaning. Now nothing is cut by the read, existing fields keep their meaning, and new fields are additive (schema version unchanged).
- Done is the binding's close record, not a verdict. App taps count as check-ins, so Finish never sends the owner off to check in first.
- A judgment-only project the judge reads as claiming done now gets a Confirm-done in the Telegram note (the conversational counterpart of Finish).

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security/adversarial/scale, integration/decisions/lessons, codex, SCG (4 flags) | 14 | 9 | Finish split from item checks; precheck at challenge; queued requests; full text; agent-may-certify kind |
| 2 | all-lens, codex, SCG (3 flags) | 8 | 5 | duplicate ids; distinct Finish outcomes; judgment-only Finish; check-in on taps; reopen clears; HLC ordering |
| 3 | all-lens, codex, SCG (2 flags) | 6 | 4 | done = close record; shared restart budget; durable queued record; judgment-only note candidate |
| 4 | all-lens, codex, SCG (4 flags) | 2 | 6 | tick during check-now runs after it; per-item checks phone-only decision; wording |
| 5 | all-lens, codex, SCG (3 flags) | 3 | 5 | fold newest-first order; automatic-only Finish; kind read from the done list; durable check-event |
| 6 | all-lens (0 design), codex (2 design), SCG (3 flags) | 2 | 5 | (at cap) close re-check moved after the last wait; queued request shown in `checks` |

Standards-Conformance Gate: ran every round (4, 3, 2, 4, 3, 3 flags).

## Proportion

Tier 2 (new owner-authority routes on the phone, a new store event, ~600 lines across 9 source files plus tests); 6 of 6 rounds used. The round count reflects real design findings each round, mostly in the multi-machine and close paths.

## Left behind

- SCG, Judgment Within Floors (rounds 1–6): the eligibility gap (one tick less a minute) delays a recheck right after evidence changed. Accepted: it is the loop's own configured fastest rate, nothing is refused (the request is queued), and a check with unchanged evidence costs no judge call.
- SCG, Never Silently Cut: the loop stores at most 500 characters per check note. Accepted: an existing store bound, the read no longer cuts anything, and the store-time cut now ends at a word with an ellipsis.
- SCG, Canonical Pipeline / No Manual Work: agent-may-certify items still wait for the owner until the delegated judge (chief-of-staff-topic's PR 3b) exists. Accepted: unchanged from today, Finish confirms them in the same tap, and they are not required to be checked one by one.
- Round 6 codex, two design findings, fixed after the cap without another review round: the Finish re-check now runs after the last wait, immediately before the close; a queued request is shown in `checks.requested` and moves `checks.next`. Both covered by unit tests; the second-pass reviewer reads them.
- The stale Telegram pause ask compares two machines' wall clocks. Accepted with a decision row: both sides are the owner's own acts and every outcome is visible on the row.
- The restart budget lives in the holder's process memory and resets on a restart or handoff. Accepted: the per-tick count already does; the durable backoff and weekly breaker still hold.
- Per-item checks have no Telegram flow; the whole-project Confirm-done is their conversational counterpart (Frontloaded Decision 8).
- Precision items fixed in passing: status codes, the awareness file name, the shared `owner-presence` bucket, `who` = "owner", the route precheck hook name, the integration test's queued case.

## Full Findings Catalog

Round 1 (design): F1 refusals reached Face ID → challenge precheck. F2 owner-done predicate vs judge path → kept separate (then removed: item checks never close). F3 PIN confirm-done gap → stated, fb-0ac4fffb-148. F4 records carry no signature → proof is the gate's audit trail, stated. F5 bearer loop drains the judge → tick-based gap, shared rule. F6/B-F1 non-holder refusal → replicated queued request. F7 dirty mark lost off-holder → request folded from the union. F8/B-F2 auto-close surprise → Finish. B-F3 floored reasons shown as facts → `latestReport.confirmed`. B-F4 existing field meaning changed → kept. B-F5 any edit voids → per-item content hash. B-F7 stale Telegram ask → newest decision outlives it. B-F8/B-F9 fixed limits and cuts → reused config values, no cuts. B-F10 agent-may-certify → own kind. B-F11 `checking` refusal → queued. Codex: mixed-version loss (refuted: the applier stores raw entries; stated), no-op discards (every tap recorded), binding revision not signed (Finish signs `bindingRef`), clients (§3.7).
Round 2: item ids outside the line alphabet → item named by checkRef; Finish outcomes indistinct → shared core returns reasons, close durable; judgment-only projects → defined; lapsed lease dead end → taps are check-ins; checks survive reopen → cleared; wall-clock requests → HLC. Codex: queued bypass of the gap → same eligibility; Finish commit-time consistency → re-verify; stale ask overclaim → accepted race.
Round 3: duplicate ids block Finish → Finish confirms them; done read from a verdict → close record; restart cap bypass → shared budget. Codex: same duplicate-id issue, eligibility predicate, conversational parity → note Confirm-done candidate.
Round 4: a check-now skips the tick → deferred tick. Codex: per-item conversational parity → Frontloaded Decision 8.
Round 5: withdrawn check resurrected on revert → newest-first fold. Codex: automatic-only Finish under a lapsed lease → allowed; A→B→A restore → defined.
Round 6: internal reviewer found no design issue. Codex: Finish wait after re-check → moved; next-check display vs queued request → `checks.requested`.

## Convergence verdict

Converged at the round cap (6). The final internal review found nothing that changes what gets built; the final external review's two design findings were fixed and are listed above; no remaining item concerns safety, security or data loss. Ready for approval.
