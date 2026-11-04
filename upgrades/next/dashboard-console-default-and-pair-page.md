<!-- bump: patch -->

## What Changed

`/dashboard` now opens the new console. The legacy dashboard is still there at `/dashboard/legacy`: the console links to it, and every older link to a particular tab (anything like `/dashboard?tab=…`, file links included) opens it as before. The pinned Telegram dashboard message's Sessions and Files links now open the console's own pages.

A waiting phone's pairing code has its own page, `/dashboard/pair`. It shows the address it is on, asks for the dashboard PIN, and then shows the code in large type with a Copy button. It also shows the phone's name, whose phone it is, the time left, and the key fingerprint, with "Not my phone" to decline. Below that it lists the paired phones, each with Remove. The page asks for the PIN on every visit, stores nothing, and clears the code when the unlock runs out. It runs under the strictest browser security policy the server uses. The console's Phones tile opens it. When the code will be shown on the dashboard (an agent with no Telegram owner), the pairing link's answer and the phone's redeem answer both carry `codePageUrl`, so the agent and the iPhone app can hand out one direct link. The installer's last line points to that page too.

Agents' CLAUDE.md is updated in place: the console bullet now says the console is the front door, and the pairing-without-Telegram lines send the operator to the code page instead of the Phones tab.

## What to Tell Your User

My dashboard address now opens the new console. The old dashboard is one link away, and old links still work. To pair your phone, open the pairing link on the phone, then open the code page I send you, type your PIN, tap Copy, and paste the code into the app.

## Summary of New Capabilities

- `/dashboard` opens the console; the legacy dashboard is at `/dashboard/legacy`.
- `/dashboard/pair`: a waiting phone's code after the PIN, large, with Copy.
- `codePageUrl` in the mint and redeem answers on the dashboard pairing path.

## Evidence

Unit, integration and end-to-end tests: the redirect matrix (bare, trailing slash and case variants to the console; any query string to legacy with the query intact), the legacy page at its new address, the strict policy on every address that serves the code page (with a dozen odd spellings checked to never serve it without that policy), the page's behaviour (no code before the PIN, nothing stored, the wipe at the session deadline even with no network answer, late answers dropped, Copy and its fallback), `codePageUrl` on the right paths only, and the CLAUDE.md rewrites in every shipped wording, run twice. Live on Cirrus after release: see the PR.
