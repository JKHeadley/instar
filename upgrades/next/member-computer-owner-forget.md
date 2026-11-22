<!-- bump: patch -->
## What Changed

Follow-up to members joining a computer from the owner's invite (spec `docs/specs/member-browser-any-computer.md`, topic 146128), found while building the iPhone People screen for build 119.

- The owner's phone sees each person's computers in `GET /mobile/team/people` (a `computers` array on owner reads only; a member's read is unchanged).
- The owner's phone removes one with `POST /mobile/team/people/:personKey/computers/:deviceId/forget` (in the device allowlist as owner-only, re-checked in the route). It shares the forget helper with the agent's route: a ledger revocation plus `browser-unbind`, replicated as before.
- The page's `activeFor` now takes the newest active key record, and the join routes name the machine with the coordinator's id when there is no mesh id, so a computer relinked after its joined key was removed opens documents (found by the headless-browser live proof).

## What to Tell Your User

You can now see and remove a team member's computers yourself from People on your phone, under that person's name. Removing one stops it opening documents right away; the comments it already left stay. This is only on for development agents for now, and the People screen needs iPhone build 119.

## Summary of New Capabilities

- The owner's phone lists a person's computers (`GET /mobile/team/people`, owner reads) and removes one (`POST /mobile/team/people/:personKey/computers/:deviceId/forget`, owner phones only).

## Evidence

- E2E: `tests/e2e/documents-join.test.ts` (an owner phone lists and removes a joined computer; a member's phone gets 403 and no list).
- Unit: `tests/unit/mobile-session-terminal.test.ts` (the owner-only allowlist names the new route).
- Browser live proof: headless Chromium, 7 of 7 steps pass, including relinking after removal.
