# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**The Framework-Onboarding Mentor can now actively drive a mentee through a concrete onboarding agenda — instead of only passive "how's it going?" check-ins. Ships dark (opt-in).**

Grounded in the live Codey dogfooding run (topic 13435): the high-signal interactions were the ones where the human handed Codey concrete tasks (capability checks + real dev work); passive check-ins on an idle mentee were low-signal ("nothing to do"). Two gaps were found and fixed:

1. **The mentor's Stage-A surface builder (`getSurface`) was a stub** returning an empty surface, so the mentor was blind — it could only ever choose `observe-only` or emit a generic message, despite the `assign-next` action already in its repertoire.
2. **No backlog** of concrete onboarding tasks to assign.

The change adds an optional `onboardingAgenda` (the mentor's own ordered list of next tasks) to `MentorConfig` and the Stage-A surface, includes it in the leak-check surface (so assigning an agenda task is not flagged as peeking at internals), and replaces the stub with a real surface built from the mentee's recent replies (`mentor-replies.jsonl`, parsed defensively) plus the agenda. When the mentee is idle and the agenda has uncovered items, the mentor hands over the next concrete task; if the mentee is mid-task, blocked, or asked something, it still waits / unblocks / answers.

**Double-gated dark:** the mentor is off by default (`mentor.enabled:false`/`mode:'off'`), and the agenda is empty by default — so even an enabled mentor keeps today's passive behaviour until an operator sets `mentor.onboardingAgenda`. Shipped as a conservative patch (no major.minor boundary crossing → no lifeline-restart churn) because it is dormant until opted in. Known limitation, flagged for a follow-up: the surface feeds the mentee's replies but not the mentor's own prior prompts (their content isn't logged yet), so agenda rotation is inferred from the mentee's replies.

## What to Tell Your User

Nothing changes unless you turn it on. The optional onboarding mentor — the piece that can shepherd a newly-onboarded agent through learning the system — used to only manage vague check-ins, because it was effectively handed a blank page about what the new agent was doing. It now gets a real picture (the new agent's recent replies) and can be given an onboarding to-do list, so it hands over concrete next tasks instead of hollow check-ins. The mentor stays off by default, and even once enabled it behaves exactly as before until you give it a to-do list. If you want the mentor to proactively walk a new agent through specific capabilities, that is now possible — just ask and I can set it up.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mentor onboarding agenda (active task-driving) | Set `mentor.onboardingAgenda` to an ordered list of task descriptions in `.instar/config.json`. When the mentor is enabled and the mentee is idle, it assigns the next uncovered item via `assign-next` instead of `observe-only`. Empty/unset → unchanged passive behaviour. |

## Evidence

- Unit: `tests/unit/MentorStageA.test.ts` — agenda block present/absent in `buildStageAContext`; agenda counted as surface-legitimate so assigning it is not a leak; `buildConversationSurface` formats mentee replies into history, caps to most-recent N, computes time-since-last-contact, sets agenda only when non-empty; `parseMenteeReplies` skips blank/garbage/empty-message lines, coerces `ts`, filters to the named mentee, never throws. All 43 mentor unit tests (MentorStageA + Tick + Runner) pass; full build green.
- Live origin: the Codey dogfooding run — passive observe-only on an idle mentee was low-signal; active task-driving (the human assigning concrete tasks) was where every real issue surfaced.

Spec: `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (2026-05-29 amendment — in-scope; ships dark per the spec's graduated-rollout framing).
