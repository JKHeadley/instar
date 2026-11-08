# Upgrade Guide — dashboard-conversations

## What Changed

The dashboard console gets a Conversations page (Work > Conversations, `#/work/chats`) with the same app, Telegram and Slack conversations as the Instar iPhone app: list on the left and the conversation on the right on a computer, one or the other at phone width. Each browser becomes a device of its own (docs/specs/dashboard-conversations-browser-device.md): it makes a non-extractable WebCrypto key, is approved through the same channel a new phone would be (with a Telegram owner: the private Telegram chat or an owner phone, never the dashboard PIN alone), and then signs every message itself. New routes `POST /mobile/browser-devices` (Bearer + dashboard PIN session) and `GET /mobile/browser-devices/status`. A browser device may call only the conversation and media routes and may only revoke itself. Its ledger activation row carries `client: 'browser'` in the signed payload, so its messages show as browser-signed; Telegram and Slack mirror lines say `💻 <owner> (from the dashboard)` and the session tag says `(💻 signed)`. Behind `mobilePairing.browser.enabled` (development agents live, fleet dark), with `maxBrowsers` (10) and `maxSetupsPerHour` (6).

Always on, as a security correction: every `/view/` response (private views, the PIN page, signed tunnel links, views relayed from another machine) is served under `Content-Security-Policy: sandbox allow-popups allow-popups-to-escape-sandbox allow-downloads`, so agent-written markup can no longer run script on the dashboard's origin or read its stored token. The PIN page now says unlocking isn't available at this address instead of showing a form that could not work (repair tracked separately). The console's CSP allows `blob:` images and media for files it downloaded itself.

## What to Tell Your User

You can now chat with me from the dashboard, the way Telegram Web sits next to the Telegram phone app: open Conversations under Work. The first time, the browser asks for the dashboard PIN and then for your approval in our private Telegram chat (or on your phone), exactly like adding a new phone. After that it shows up under People > Phones as a browser, and you can remove it there any time. Messages you send from it are marked as sent from the dashboard.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Conversations in the dashboard (app, Telegram, Slack) | Work > Conversations |
| A browser approved as its own signed device | The page walks you through setup; approve it in Telegram or on your phone |
| Remove a browser | People > Phones, or "Forget this browser" on the page |
| Private views sandboxed off the dashboard origin | Automatic |

## Evidence

Unit and integration tests cover the browser setup and approval paths, the closed browser allowlist, the activation effects and their recovery, the decline-versus-approval race, the hourly setup limit under concurrency, the credential-question parity with the server's detector, the §4.7 wording (phone wording unchanged byte for byte), and the `/view` sandbox through the real server including relayed views and upper-case paths (`tests/unit/html-site-ratchet.test.ts`, `tests/integration/view-tunnel-routes.test.ts`, `tests/integration/pool-view-link-proxy.test.ts`). The live proof drives the real dashboard on throwaway agents at 1280x728 and 390x844 before the operator is asked to use it.
