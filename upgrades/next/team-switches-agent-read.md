## What Changed
- **The agent can read its own team settings summary.** `GET /team/people` (agent token) now carries `teamSwitches`: the same one line per setting the owner's phone shows, each with `setting`, `on: false`, `offOn` (the machines), `action` and `requested`. It is `null` on an agent without the team router. Read-only: turning a setting on stays the owner's Face ID tap in the app.
- **Instructions point at it.** The "Registry First — team settings" line now says `GET /team/people` → `teamSwitches`; existing agents get that phrase rewritten on update. The old route answered only the owner's phone, so the agent got refused.

## What to Tell Your User
When you ask whether anything is off that team access needs, I can now check it myself and tell you which machines have it off. Turning it on is still your one tap in the app.

## Summary of New Capabilities
- `GET /team/people` → `teamSwitches`: the team settings summary for the agent token.

## Evidence
- `tests/integration/team-access-routes.test.ts`: summary equals the phone route; agent token refused on the phone route and every turn-on route.
- `tests/integration/team-people-routes.test.ts` and `tests/e2e/team-people-alive.test.ts`: the field is present for the agent token, including on the production boot path.
- `tests/unit/PostUpdateMigrator-teamSwitchesRead.test.ts`: the installed line is rewritten once.
