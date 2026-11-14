# Side-Effects Review — a person's stop holds recommended-service setup

**Tier 2 by risk (session restart behaviour), with second-pass review.** Spec: `docs/specs/recommended-services.md`. Dark: setup only runs on a throwaway or development agent listing a recipe.

## Summary

- New `held` in per-machine setup state. `reconcile` skips a held service, so no restart and no stuck notice.
- `holdSetupForSession` is called from the Telegram sentinel kill and `DELETE /sessions/:id`, before the kill and matching by session name or topic. `holdAllSetups` is called from the Slack sentinel kill-all and the app's Slack kill-all, and also holds a setup whose session is already dead.
- Setup state now follows the conversation's current session, found through the topic. A reply brings a session back under a different name. Before this, a repeat yes could start a second session, and a no couldn't stop the renamed one.
- New `POST /recommended-services/:id/hold`, for a session whose person said not now. Needs the bearer token and `X-Instar-Request`. No PIN, and it refuses without a recipe.
- A repeat yes lifts a hold, resets its restart count and starts setup. A fresh yes also lifts it. A no and a pass clear it.
- The Jev offer text says credits are needed before a key. This changes its offer hash, which is harmless because no real agent has a grant.
- The brief rule covers sign-in codes and pictures. The Jev brief records the credit requirement and a credit code as the route that avoids a card.

## 1. Over-block

A false emergency stop now stays stopped until the person writes again. The second live run was exactly this: "No, don't add credits" was classified as a stop. It recovered before only because of the restart this removes. The person is told "Session terminated. Send a new message", so it isn't silent, and the classifier bug is filed on its own (fb-01131fac-fb1).

An agent's own `DELETE /sessions/:id` with a bearer token also holds, since the route can't always tell operator from agent. A session ended that way stays ended until a yes, a no, a pass, or a reply. An agent ending its own setup session on purpose wants that.

## 2. Under-block

- Kill paths that aren't named still restart: the reaper, the watchdog, crash recovery. They're not a person's stop, so that's intended. A new person-facing stop path added later would miss this. A test pins the four named paths by reading the source, so it shows the calls exist and not that each runs.
- `/stop-all` style autonomous stops and the route at `routes.ts:28380` are covered only where they go through `onSentinelKillSession`. The route's fallback without Telegram doesn't hold, and setup needs Telegram to talk to the person.
- A session the person brought back by replying, which then dies, isn't restarted while held. Their next message resumes it. Recorded in the spec's Left behind.
- The hold rule is prompt text, so a session can fail to call it. It then gets the bounded restarts, as today.
- The hold is written before the kill. If the kill fails, the session keeps running while held. It can still finish and pass, which clears the hold.
- Narrow race left in place: a stop during `startSetup`, before any session name is saved, can find nothing to hold or leave the new session running. The window is seconds, one recipe, and only on proving agents.

## 3. Level-of-abstraction fit

The stop decision stays where it is, in the sentinel and the routes. Setup state only records the outcome, and `reconcile` reads it. The two kill-all paths hold every setup that hasn't passed, including one whose session is already dead.

## 4. Signal vs authority compliance

No new judgment. `held` is a recorded fact, and `reconcile` applies a deterministic skip. The hold route only reduces what the system does, and grants nothing. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

`dormant` and `exhausted` are unaffected, because the hold check sits beside them. `endSetup` clears `held`, and `reconcile`'s no-grant branch runs before the skip, so a no from another machine still ends a held setup. A repeat yes used to return without touching setup. It now restarts a held one, which needs the PIN and a live page token.

## 6. External surfaces

`GET /recommended-services` gains `held`. One new route. The offer text changes only on the confirm page, which real agents can't reach. No change to what a person sees on any real agent.

## 6b. Operator-surface quality

The confirm page shows the new cost line through the existing field. It is one sentence longer, and the page is otherwise unchanged. No new control.

## 7. Multi-machine posture

Machine-local, like the rest of setup state. `machine-local-justification: physical-credential-locality`: setup state tracks a key and session on one disk. A stop on one machine holds the session on that machine. Setup runs only on the granted machine.

## 8. Rollback cost

A revert removes the route and the skip. A leftover `held` field in the state file is ignored. No data migration.

## Second-pass review

First read: concern raised. A stop, a reply and then a yes could start a second live session, because state kept a stale session name. The reviewer also named an unheld stop under a renamed session, a fresh yes leaving a hold, the app's Slack kill-all, a dead session coming back after a kill-all, the gap after the dashboard's kill, a hold overwritten during preflight, a repeat yes keeping its spent restarts, a pass not clearing the hold with no open promise, and an overclaiming test title. All were fixed.

Second read: concurred, nothing blocking, from reading the code without running tests. It raised three smaller items. Re-adopting a session after a no, and a stop during preflight, are fixed after that read and weren't re-read. Left in place: a stop during `startSetup` still ends with a session running while held, and a yes on an open session clears `lastAttemptAt`, so a later idle-out gets one more restart.

Verifier: the first full run failed one integration test, `recommended-services-confirm-wiring`, because that test's Telegram stand-in had no topic lookup, which the no path now calls. The real adapter has it. The stand-in now keeps real topic records, so the no path runs the real lookup. I hadn't run that file locally before pushing. Test-only, so no second read.
