# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Local Telegram sessions no longer show the headless icon.** The dashboard's live session list for THIS machine comes over the WebSocket, whose rows never carried `platform`, so every local Telegram topic was drawn with 🖥️ (headless) while the same topic seen from another machine (via `GET /sessions?scope=pool`) showed ✈️. The platform derivation moved out of the `GET /sessions` handler into `src/server/sessionPlatform.ts` (`resolveSessionPlatform`), and `WebSocketManager` now takes it as an injected `resolveSessionPlatform` option wired by `AgentServer` to the real Telegram and Slack adapters, so both surfaces fill `platform` / `platformId` / `platformName` from one function.
- **Every session-row badge has a tooltip, and a "?" button opens a legend.** Type (interactive / job), model (with a note when the session started on a bare alias like `opus`, so its exact version is not recorded), platform icon, machine and running time each explain themselves on hover, and the "?" next to + in the Sessions header toggles a small legend that also works on a phone.

## What to Tell Your User

The little icons on each session in the dashboard now explain themselves. Hover over any of them on a computer, or tap the "?" next to the + button on your phone, to see what each one means: the session type, the model it runs on, whether it's linked to Telegram, which machine it's on, and how long it has been running. I also fixed a wrong icon: sessions on the machine you're viewing showed a screen icon ("no messaging") even when they were Telegram conversations. They now show the Telegram plane.

## Summary of New Capabilities

- Tooltips on every dashboard session badge, plus a "?" legend in the Sessions header.
- The platform icon is now correct for this machine's own sessions.

## Evidence

- `tests/unit/sessionPlatform.test.ts`: Telegram topic with and without a real name, Slack fall-through, headless with and without adapters; source-level wiring that `AgentServer` hands the WebSocket manager a resolver backed by the real adapters and that `GET /sessions` uses the same helper.
- `tests/unit/WebSocketManager.test.ts`: a local Telegram row carries `platform: 'telegram'` and its topic id from the resolver; no resolver or a throwing resolver leaves `platform` unset instead of breaking the list.
- `tests/unit/dashboard-session-badge-legend.test.ts`: the "?" toggle and hidden-by-default legend, the legend covering every badge, the tooltip on each badge, and the bare-alias model note.
- Observed before the fix on the live dashboard (2026-10-21): four Mac Studio Telegram topics drawn with 🖥️ while a Mac Mini Telegram topic, seen through the pool, drew ✈️; `GET /sessions` already reported `platform: "telegram"` for all of them.
