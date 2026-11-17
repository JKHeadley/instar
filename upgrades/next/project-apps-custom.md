# Project apps part 2: apps your agent writes, in a sealed frame you approve from your phone

<!-- bump: patch -->

## What Changed

The agent can now write a small app for one project, such as a sales pipeline or a course tracker, and attach it the same way as part 1's built-in pages. Each version needs the owner's Approve on a Work Board card from their phone; the desktop console cannot approve it. The app runs in a sealed frame: it cannot see the dashboard, its sign-in or anything outside its own data, and it only talks to `/project-apps/<appId>/api/data` and `/api/summary` with a short-lived key the wrapper hands it. Everything it stores is encrypted, and erasing destroys the keys. New routes: `GET/POST /project-apps`, `PUT /project-apps/:appId/source`, ticket/key/frame/api routes under `/project-apps/:appId/`. New replicated kind `project-app-blob` (older machines skip it). Switch: `projectApps.custom.enabled` (development agents only). For now apps are served only from the machine holding the lease; other machines show "still copying".

## What to Tell Your User

When a project would be easier to run from its own little app, such as a pipeline you can drag deals through, I can build one for it. You approve each version from your phone before it runs, and it lives in a locked box: it can't see your dashboard or anything else, only its own data.

## Summary of New Capabilities

- Agent-written project apps, approved version by version from the owner's phone.
- A sealed frame with a narrow per-app key.
- Encrypted app storage with erase by key destruction.
- An example sales-pipeline app.

## Evidence

- Unit, integration and e2e tests are listed in `upgrades/side-effects/project-apps-custom.md`.
- Hostile-app browser proof in Chrome and WebKit: every escape attempt was blocked; only the app's own data write succeeded.
