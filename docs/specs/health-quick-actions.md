---
title: "Quick actions on a health problem: hide for a while, hide from me, ignore completely"
slug: "health-quick-actions"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "health-quick-actions.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-05 13:43 PST: quick options on an issue to hide it, ignore it so the agent stops tracking it, or hide it for a set time, in a few taps) and the standard he approved at 13:31 PST. No constitution change."
review-convergence: "2026-11-05T22:30:00.000Z"
review-iterations: 1
review-completed-at: "2026-11-05T22:30:00.000Z"
review-report: "one security-and-adversarial review round, recorded in upgrades/side-effects/health-quick-actions.md."
---

- **ladder:** not applicable: no off-by-default switch. A person has to tap for anything to change, and an agent with no choices saved behaves exactly as before.

## 1. Problem

`GET /mobile/health-issues` shows each problem with a fix and a way to ask. Justin (2026-11-05 13:43 PST) wants quick options on a problem: hide it, ignore it so the agent stops tracking it, or hide it for a set time, a few taps each. A problem that is real but not worth his attention today has no way off his screen.

## 2. The three choices

- **Hide for a while** (`snooze`): 1 hour, 1 day or 1 week. It shows again at the end if it's still happening.
- **Hide from me** (`hide`): it stops showing and counting for the person. The agent keeps recording it.
- **Ignore completely** (`ignore`): the agent stops tracking it. One confirmation with one sentence: no typed input, no PIN.

All are undoable from a Hidden list on the Health page and on Machines and health.

## 3. What "tracking" means, and what Ignore does per kind of item

A row comes from one of three places, and Ignore can only be as true as the place allows.

| Kind | Example | Ignore does | Offered |
|---|---|---|---|
| A reported event | `Slack`, `SessionManager.verifyInjection` | `DegradationReporter.report()` returns at the door: no record in memory or on disk, no feedback filed, no alert, no remediation, no digest. `/health` stops counting it. One log line per run is all that's left. Events already recorded are filtered from every read, so undo brings a recent one back. | all three |
| An LLM component's reliability | `health:llm:PeerUserMeantJudge` | `/health` leaves it out of `llmReliability`, so it can't make the agent say degraded. The call ledger keeps counting: cost and quality views use it. | all three, worded for this |
| A live reading | `health:sessions-full`, `health:job-failures`, `health:claude-key`, `health:whatsapp`, `health:system-review`, `health:llm-unavailable` | Not offered. `/health` works it out fresh, and the scheduler and session cap act on the same numbers, so "stop tracking" wouldn't be true. | hide for a while, hide from me |

Two rows can't be chosen at all: `health:unnamed` and `health:unnamed-event` have no identity, so a choice on one could hide a different problem. They say so and offer Ask.

**Security and data-loss ids** get Hide for a while only, and say so on screen. They are a declared list read from each `report()` site, plus families and a word floor on the id for anything added later. The list also covers LLM components that decide what may happen (a gate, guard or sentinel failing often is a security item), and messages that may not have arrived. The floor only narrows the choices. A false match means a person can only hide it for a week at a time.

**Ignore's undo is partial, and says so:** anything that happened while ignored was never recorded.

Hide and snooze also quiet the reporter's Telegram alert, and `/health/degradations` serves a hidden event as already reported so the daily digest doesn't raise it; that is read-time, so it is raised normally once a snooze ends. The record, the feedback filing, the self-healer and the remediator all carry on: that is the agent tracking it. Attention items already open for a problem are separate and unchanged. With the remediator switched on (off by default), anything it says about a hidden problem still reaches the person.

## 4. Scope: one exact id

A row's `keys` are the exact ids behind it. A choice is bound to what was on the person's screen and is still happening: the client sends the row's id and its `keys`, and the server takes the ids that are behind that row in a fresh read AND in the request (404 `issue-gone` if none are). A member of the family that arrived after they looked stays showing. Filtering happens per signal before grouping, so hiding `unjustifiedStopGate.db` leaves `unjustifiedStopGate.route` showing under the same family row. Different failures reported under one feature name share a choice: the id is the finest name that exists.

## 5. The honest reading

Hidden rows never raise a count, and never reach Home or the Fleet badge. But a hidden problem that's happening, or an ignored one nobody can see, is never "healthy": the verdict is `running` with the headline "Running, with one thing you've hidden." and the app's word is "Running". A hidden problem that has been absent for 30 minutes lets the agent read healthy again; until then it counts as happening, since right after a restart a real problem hasn't re-reported yet. While something is hidden and showing nothing else, a further reason `/health` can't name reads "Running, with one thing you've hidden" rather than its own unnamed row: never healthy, and the same limit any other showing row already has. `/health` is unchanged except where Ignore says it changes.

A snooze that stopped and came back stays hidden until the time the person chose, says "It stopped, and then it came back" on the Hidden list, and says so again when it shows. It counts as stopped after 30 minutes absent (the window `/health` uses), so a restart emptying the in-memory events isn't reported as a return. A timer reads every 5 minutes while anything is hidden, so this is noticed when nobody is looking.

If the saved file can't be read, nothing is hidden: everything shows, and the page says so.

## 6. Multi-machine posture: replicated

`state/health-choices.json` on each machine. `/mobile/health-issues` reads the machine that answers, so a choice has to reach whichever machine holds the problem. It is saved locally, then pushed to each online peer (`POST /mobile/health-issues/choices/merge`, bearer only). Every 5 minutes each machine pulls from the others (`GET /mobile/health-issues/choices?scope=local`), so one that was offline catches up. Later stamp wins per id; ties break on the machine name; undo is a stamped removal, with no time limit and only the oldest dropped past 500, so a machine offline for any length of time can't revive a choice. A machine validates every row against the offer rules, so a peer can't install a choice no screen could have offered. What each machine saw of the problem stays local.

A peer that doesn't answer is named in plain words on the screen, and the choice still stands here. A second machine with its own problem shows it on its own answer, as `mobile-health-issues` §6 already scopes. The replicated stores (`multiMachine.stateSync`) ship dark and a signed ledger is more than a display preference needs, so this uses the same peer fetch the mobile routes already read through.

## 7. Authority

Owner phone (device signature, its own bucket of 12 a minute) or bearer. No Face ID or PIN: every action is undoable, and these are the person's own view. The peer routes aren't on the device allowlist.

A session holds the bearer too, so an agent could hide its own problems, through either the choice route or the peer route, which uses the same bearer as every other mobile peer read. It can't be told apart from the console today. So: `by` on each row says "Hidden from your phone", "Hidden from the dashboard, or by the agent", or, for anything that arrived from a peer, "Hidden on another of this agent's machines", since a peer's word on who chose can't be checked, every choice goes to `logs/health-choices.jsonl`, the awareness text says never to do this unasked, and the Hidden list is always one tap from the Health page.

## 8. Older servers and apps

Additive. An older server sends no `choices` or `hidden`, so the app shows no buttons and no Hidden row. An older app ignores them; a problem hidden from the console just doesn't appear there.

## 9. Tests

Unit: offers on both sides for every kind, one-id scope, the verdict, snooze timing, stopping and coming back, restart, save failure, undo, merge order, row validation, the reporter on Ignore and Hide, `/health`'s reliability. Integration: the real auth chain for owner, bearer, MSP, unsigned, tampered, peer routes refused to a phone, push failure. E2E: a real AgentServer, a paired phone, the real reporter and `/health`. Console and app: their own tests, and the screens read at phone size.
