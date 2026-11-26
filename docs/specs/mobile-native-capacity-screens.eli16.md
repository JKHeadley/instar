# Native Accounts, Spend and Resource usage screens — Plain-English Overview

> The one-line version: the owner's iPhone gets three look-only screens — which AI accounts are signed in and how much of each limit is used, what AI use cost across your machines (with this machine's spending limits), and how much CPU and memory the agent is using — built from the same data the web console already shows, with nothing secret in them.

## The problem in one breath

Justin asked for the Instar iPhone app to do everything natively instead of opening web pages. Today the app can only show accounts, spending and resource use by opening the web dashboard, because the phone is only allowed to call a short list of server addresses and these aren't on it.

## What already exists

- **The web console's Accounts page** — lists each AI subscription account, its email, whether each machine is signed in to it, and how much of its 5-hour and weekly limits is used, with reset times. It also lets you start a sign-in fix.
- **The web console's "What thinking costs" page** — shows pay-per-use cost recorded on this machine, the spending limits on paid routes, and how many tokens conversations used.
- **Resource usage** — the server records CPU and memory for itself and each session; the console shows it per machine.
- **The phone's allowlist** — a paired phone signs every request with a key that never leaves the phone. The server lets it reach only listed addresses. Some addresses are owner-only, so a helper's phone is refused.
- **The just-built Schedule, Promises and Machines screens** — the same pattern this change copies.

## What this adds

Three new read-only server answers made just for the phone: accounts, spend and resources. Each is a cut-down summary of what the console already shows the owner (for spend, what each machine's own console shows, added together). The raw console data has things the phone should never get — folder paths of account logins, internal ids, internal machine ids (a paid route's designated machine appears only by its name), error text — and those are left out by an explicit list of allowed fields, not by trying to remove bad ones.

The app gets a "Capacity" section on the agent's page with three screens: Accounts (sign-in problems first), What thinking costs (today, 7 days or 30 days), and Resource usage. Pull down to refresh.

## The new pieces

- **The accounts answer** — each account once, by name and email (the email the console already shows you), signed in or needing sign-in on each machine, its usage windows highest first with reset times, and how old the reading is. It reads every machine that answers, and names any that didn't.
- **The spend answer** — recorded cost with how each figure was worked out (estimated, reported by the provider, covered by a subscription, or not priced), added up across your machines (each machine's ledger is read on that machine, and any machine that is off, unreadable or offline is named, so a partial total never looks complete), conversation token totals the same way, and this machine's paid routes with spend against their limits and whether the limits are actually enforcing.
- **Honest time windows** — spend is recorded in whole days (UTC), so "Today" can include part of yesterday; the screen says exactly what each figure covers instead of pretending.
- **The resources answer** — CPU and memory for the whole agent, the server and each session, now and at the peak in the last hour.
- **The three screens** — plain words, no buttons that change anything. An older server gets "update the agent to see this here".

## The safeguards

**Nothing can be changed from these screens.** They only read. Sign-in fixes, spending limits, freezing and arming stay in the console.

**Only the owner's phone sees them.** The phone's request is checked twice: the device check refuses a helper's phone before the route runs, and the route checks again. Revoked, unsigned or tampered requests are refused as before.

**Nothing beyond what the owner already sees leaves the server.** The answers do include things the owner sees in the console — each account's login email and the spending figures — but credentials, login folder paths, internal ids and raw errors are never returned. Only listed fields are returned, and free text is passed through the secret scrubber and shortened.

**Honest when unsure.** A machine that is offline or didn't answer is named, and totals say they cover only the machines that answered. No reading shows "No reading yet", never 0%. A switched-off spend view says it is off, never "$0". An old usage reading is marked out of date.

## What ships when

One server change (the three routes, their allowlist entries, tests at all three levels, and a line telling agents about them), then one app change (three screens and parsing tests). Rolling back is a revert; nothing is stored.

## What you actually need to decide

Nothing new: this follows Justin's 2026-11-03 request for native screens, and it is approved under that request only because the three answers show no more than the console already shows the owner.
