---
title: "The console's Sessions page uses the window, and a Session settings button"
slug: "console-sessions-width-and-settings"
author: "echo"
parent-principle: "Every Warning Has a Path to Act"
eli16-overview: "console-sessions-width-and-settings.eli16.md"
status: "draft"
---

## 1. Problem

Justin, Telegram topic 134088, 2026-11-05 19:35 PST, with a photo of Work · Sessions at desktop width: "the columns are way too squeezed here. we should make better use of whitespace", and "there should be a session settings clear button where I can change default settings such as default doorway and model". The page sat inside the console's 1120 px frame, as a 300-380 px list plus a 1-word pane. The new-topic default was reachable only from inside New session.

## 2. Design

- **Width.** At 900 px and wider, the Sessions page gets the 1680 px frame an open session already had, and a grid of `minmax(340px, 480px) minmax(0, 1fr)`. The headline is clamped to 26-34 px. With no session open, the pane is a dashed, full-height card holding the existing "Pick a session" line. With one open, the list is `minmax(300px, 400px)` and the pane keeps its existing height rules. Under 900 px nothing changes.
- **Session settings.** A button beside "+ New session" opens a sheet with only the new-topic default: a door picker, a model picker, Save and Clear. It runs `POST /topic-profile/new-topic-default` with the intent header, the same as the existing control. The form is one function, `defaultsForm`, shared by this sheet and New session. The app adds `SessionSettingsSheet`, opened by a gear on the sessions list and from New session. It runs the existing Face ID `session-default` action. No route, permission or proof changes.
- **The word.** `DOOR = { word, Word, words }` in `dashboard/console/sessions-model.js`, `DOOR` in `src/server/mobileSessionControlsRoutes.ts` (the phone answers' sentences) and `SessionWords` in the app. Every sentence a person reads takes the word from there. Its value stays "door" until Justin chooses. API, config and field names (`framework`, `door` in JSON) are unchanged.

## Decision points touched

None. Layout, a second entry point to an existing control, and string sourcing. No gate, no new authority.

## Maturation plan

- **test-agent-live:** unit and DOM tests below; screenshots at 1280x728, 1440x900 and 390x844 against a sample-data stand-in.
- **dev-agent-live:** Echo's console after release, the same three sizes.
- **fleet:** ships to all; no switch, no authority change.
- **graduation criterion:** Justin's next look at the page raises no layout complaint.
- **ladder:** none (presentation only).

## Open questions

*(none; the word is Justin's, and the constant waits for it)*

## 4. Security

None added. The settings sheet calls the route the console already called, under the same token and intent header. The app path is the merged Face ID action.

## 5. Multi-machine posture

Unchanged: the new-topic default stays machine-local by design (the sheet says "on this machine").

## 6. Tests

- Unit and DOM (`tests/unit/console-sessions.test.ts`): the button opens a sheet with only the defaults, Save and Clear send the exact bodies with the intent header, no PIN. No text a person reads spells the word out.
- Unit (`tests/unit/mobile-session-controls.test.ts`): no sentence in the phone answers spells the word out.
- App (`SessionControlsDataTests`): the constant, and no sentence in the session screens spelling the word out.
- Integration and e2e: this is a console-only presentation change with no new route. The existing console static-serving integration test and the session controls e2e test cover the route the sheet uses.

## 7. Agent awareness and migration parity

No new route, setting or capability, so no CLAUDE.md change.

## 8. Rollback

Revert the commit.
