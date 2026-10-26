# ELI16 — Model registry cadence review, 2026-10-25

## The problem

Instar keeps a small, hand-reviewed list of which AI models each "door" (Claude Code, Codex, Gemini, …) should use. A check makes sure that list cannot quietly rot: it must be re-reviewed at least every 45 days, and every model the code points at must still be on the list. The last review was on September 10. On October 25 that review turned 46 days old, so the check started failing — for every single pull request, because the Studio's own verification run (which every merge now needs) runs this check on the merged code. Two unrelated PRs (#2355 and #2356) failed on it within an hour. Nothing was actually wrong with the models; the list was simply overdue for its review.

## What this change does

It performs the overdue review and records it in the one file the check reads:

- The review date moves to 2026-10-25, with a note saying what was checked and how.
- Each pinned model was re-checked against what we actually know: the Codex model was live-probed in September and still answers; the Gemini model is unchanged; the Claude defaults still work.
- One genuinely new fact is recorded: the Claude 5.5 family is live on the Claude Code door — this agent's own sessions ran on `claude-opus-5-5` and `claude-fable-5-1` today — so those two ids are added to the recognized list.

What it deliberately does NOT do: it does not change which model any agent uses. Moving the default or escalated tier onto the 5.5 family would change routing and cost for every agent, which is the operator's decision; that is filed separately as feedback. Because the ids are now recognized, that future promotion would be a one-line pin edit, not a drift failure.

## Why it is safe to ship

It edits one data file and no code. The strict check that was red is green again on the merged tree. Routing behaviour is identical before and after. The only risk is the usual one with any review: if a pin is wrong, the next cadence review (or a live probe) catches it — and the recorded note says exactly what evidence each conclusion rests on, so the next reviewer does not have to trust it blind.

## Parent principle

Keep the Doorway/Model Map Current — the review is the mechanism that standard ratified its teeth with; this change is that mechanism being used, on time, with evidence.
