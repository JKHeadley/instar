# Project apps: a project's own page one tap from Work and its conversation

<!-- bump: patch -->

## What Changed

A project in Work can now have apps: pages one tap from its row and from a strip at the top of its conversation, with a pinned link in its Telegram topic. The first app is the Feature maturation board. The agent can suggest an app once per project; only the owner's tap attaches, declines or removes it, and a "no" is remembered on every machine. The row shows the app's headline with the time its numbers were read, and says plainly when the numbers could not be read. New routes: `POST /work/projects/:key/app-offers`, `POST /work/projects/:key/apps/:appRef/answer`, `.../pin-retry`, `.../opened`, `GET /work/projects/apps/stats`. A new replicated record kind, `project-app-record`, carries offers, answers and pin steps; older machines skip it. Switch: `projectApps.enabled` (on for development agents, off elsewhere; needs the Chief of Staff).

## What to Tell Your User

When one of your projects would be easier to follow as a page than as long status messages, I may suggest one, once. You'll see the suggestion on the project's row in Work with Attach and No thanks. Once attached, the page is one tap from the row and from the top of the project's conversation, with a pinned link in Telegram, and my updates there get shorter: what changed, plus the link.

## Summary of New Capabilities

- Project apps: an Open button and a live headline on a project's Work row, a strip at the top of its conversation, and a pinned link in Telegram.
- The agent suggests an app once; only the owner attaches it.
- The Feature maturation board is the first app.

## Evidence

- Unit: `tests/unit/ProjectAppStore.test.ts`, `tests/unit/ProjectAppsRuntime.test.ts`, console model tests.
- E2E: `tests/e2e/project-apps-alive.test.ts` (Bearer offer, Bearer attach refused, owner-unlock attach, Open logged, switch off answers 503).
- Live proof on the real Work page at 390x844 and 1280x728: recorded in the PR.
