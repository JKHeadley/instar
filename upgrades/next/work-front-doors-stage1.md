# Three doors and one Needs-you list

<!-- bump: minor -->

## What Changed

The console now opens on three doors in its sidebar (and its phone-width bottom bar): Conversations, Work and Agent. Work opens straight on the work board (or the Work section with Promises and Plans when the board is off). Agent holds everything about how the agent runs: Fleet (machines, sessions, other agents), then the old Work, Capacity, People and Settings pages as sections, shown as names and icons only. Home stops being a page on the web: its old link, an empty address and any unknown address land on the Conversations door. Every existing page address still opens the same page.

A new server read, `GET /needs` (and `GET /mobile/needs` for paired phones, with its own device rule and rate bucket), returns the one Needs-you list. It is built by running the console's own Home rules on the server over its loopback (attention queue, promises due soon, and every `NEED_SOURCES` source), so the console strip, the phone apps and the Mac app all show the same list as Home. The owner sees every source; a member's or guest's phone sees only the work board, and only when the board's own device rule already admits that phone. Each answer says `complete` and lists `couldNotCheck`; each source carries its multi-machine posture. The console shows it as a strip above Conversations and Work that hides only on a complete zero read.

A canary sends a synthetic need through the real read every hour; two misses in a row raise one notice. `GET /needs/canary` shows its state.

The `plans` need source now treats a switched-off initiative tracker as nothing waiting instead of "could not check plans".

Agent instructions: a new feature note on the Needs-you list, the Registry First row for "what is waiting on my person?" now names `GET /needs`, and the sentence "in Home's count" becomes "in the Needs-you list" (reworded in place on update).

## What to Tell Your User

- **One list of what needs you**: "Everything that needs you is now in one list at the top of Conversations and Work, the same on the website and the phone apps. If part of it couldn't be checked, it says so instead of showing nothing."
- **Three places to go**: "The menu is now just Conversations, Work and Agent. Everything about how I run (machines, accounts, settings) is under Agent, and every old link still works."
- **Ask me in chat too**: "You can also just ask me 'what needs me?' here and I'll read you the same list."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| The Needs-you list | `GET /needs` (bearer) or `GET /mobile/needs` (paired phone) |
| Needs-you canary state | `GET /needs/canary` |
| Three-door console | Open the dashboard: Conversations, Work, Agent |

## Evidence

- Unit tests: needs read composition, viewer filtering, honest incompleteness, the canary (`tests/unit/needs-read.test.ts`); doors, every linked address resolving, the strip model, the wording migration (`tests/unit/console-front-doors.test.ts`); lifecycle timers (`tests/unit/console-lifecycle.test.ts`).
- E2E: `tests/e2e/needs-read-alive.test.ts` boots the production server, reads the list as the console and as a paired owner phone.
- Live: a throwaway agent built from this branch answered `/needs`; a Secret Drop request appeared as a row without its one-time token; the console doors, the Agent page and the strip were checked at 1280x728 and 390x844.
