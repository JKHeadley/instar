# Why a sign-in repair did not start — Plain-English Overview

> The one-line version: when an account shows "Needs sign-in" but the automatic repair never starts, the agent and the dashboard now say why, per machine, instead of showing a Sign in button with no explanation.

## The problem in one breath

On 2026-10-26 the dashboard showed many "Needs sign-in" cells on the Mac Mini and the Windows PC, and none of them were being repaired. The repair has a list of conditions it checks before it starts (a confirmed sign-in failure on that machine, a browser profile signed in to that account on that machine, and so on). When one of them failed, the account was silently skipped on every check. Nothing on the dashboard or in the API said which condition failed, so it looked like auto-login was broken everywhere.

What was actually happening on the Mini: four accounts had no confirmed sign-in failure on that machine (their saved login could not be read, which on its own is not treated as proof, so a locked keychain after a reboot never triggers a repair), and the fifth had a confirmed failure but no browser profile for that account on the Mini. On the Windows PC the automatic repair is not running at all.

## What this adds

- The re-login status read (`GET /subscription-relogin`) now lists `blockers`: one row per needs-sign-in account on that machine that has no repair, with the reason (`no-open-incident`, `profile-unresolved`, and the rest of the repair's existing refusal reasons). The all-machines view merges every machine's rows.
- The dashboard's Subscriptions grid shows that reason in one plain sentence under the cell's Sign in button, and says so when a machine is not running the repair at all.
- The agent's own instructions say to read this before guessing.

## The safeguards

It only reads. It starts no repair, writes nothing to the sign-in history and opens no login. It runs the very same admission check the repair runs, so the reason shown is the reason the repair uses. A read that fails leaves the field out (unknown) rather than claiming nothing is blocked.

## What it does not change

It does not loosen when a repair may start. Turning an unreadable login into a repair, or creating the missing browser profiles, are separate decisions; this change makes them visible.
