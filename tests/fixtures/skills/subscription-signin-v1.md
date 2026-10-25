---
name: subscription-signin
description: The standard, proven procedure for keeping Claude Code and Codex subscriptions signed in — Google-account profiles, normal-browser sign-in, repair, verification, and when to hand off. Use whenever a subscription shows "needs sign-in", a repair fails, or you set up a new account on a machine.
metadata:
  user_invocable: "true"
---

# /subscription-signin

How an Instar agent keeps its Claude Code and Codex subscriptions signed in, using only what has been proven on real accounts. Follow it with judgment; do not replace it with a script.

API calls below use `Authorization: Bearer $AUTH` against `http://localhost:$INSTAR_PORT` (port is in `.instar/config.json`).

## The chain (why it works)

1. **Each Google account has its own Chrome profile on each machine**, kept signed in to Google. Claude and Codex both sign in "with Google", so a healthy Google session in that profile is what makes every later re-sign-in a few clicks.
   When Google itself asks to sign in again, the agent types the account's password and its 6-digit authenticator code, both taken from the vault by name, in that same normal browser. No passkey and no automated browser are needed, so the Google side needs no human either.
2. **Sign-ins always run in a NORMAL browser** — the account's Chrome opened the ordinary way, never a remote-controlled/automated one (no DevTools/Playwright). Providers put human checks in front of automated browsers (Claude's Authorize never went through; Cloudflare "Just a moment" never cleared); the same profile opened normally passes. The built-in repair does this for you on macOS.
3. **The CLI login is started by Instar**, the browser only approves it: Claude gives a code to paste back; Codex (device code) finishes on its own.
4. **Success is measured, not assumed**: the account must read `active` with the expected email, and an authenticated call must work.

## Hard rules

- Never use an automated browser for a sign-in page. Never solve or work around a CAPTCHA or phone check — hand it to the operator.
- Never pick an account other than the expected one; never approve permissions beyond what the CLI requested.
- Never put a password, code, or token in chat, a file, or a command line. Secrets come from the vault by name.
- Never copy a Chrome profile or a login between machines — cookies are tied to that machine. Each machine gets its own profile and its own sign-in.
- Never drive or close a Chrome window you did not open (a person may be using it).

## 1. Setting up an account on a machine (once)

1. Check the profile registry: `GET /playwright-profiles/resolve?service=google&identity=<email>`. If there is none, create it: `POST /playwright-profiles` then `POST /playwright-profiles/<id>/accounts` with `{"service":"google","identity":"<email>","owner":"operator"|"agent","vaultRefs":[...]}`. Phone-first alternative: the Subscriptions dashboard's profile provisioning.
2. Make sure the vault holds the account's Google password and its authenticator (TOTP) secret, e.g. `google_password_<name>` / `google_totp_<name>`, and that the profile's account entry lists them in `vaultRefs`. If the account's authenticator is already on the person's phone (Google allows only one), don't replace it: store the account's unused backup codes instead (`google_backup_codes_<name>`, bound as `backupCode`). With both present the agent can sign the profile in to Google itself. If the account has no authenticator yet, adding one changes the person's 2-step settings: ask once for a yes, then add it from the signed-in profile and store the secret.
3. Enroll the subscription if it is not in the pool: `POST /subscription-pool/enroll` (never ask anyone to paste a token).

## 2. When a subscription needs sign-in

1. **Look first**: `GET /subscription-pool` (which account, which machine, `needs-reauth`), `GET /subscription-relogin` (any repair episode and its state), `GET /subscription-pool/pending-logins` (a live login waiting for approval).
2. **Let the built-in repair run.** In unattended mode it starts on its own for the listed identities; in approval mode it needs one dashboard tap (**Repair sign-in** on that account × machine cell). You cannot approve for the operator — send them the dashboard link.
3. **Read the outcome**: `GET /subscription-relogin/<episode>/events` (redacted). `succeeded` = done. Otherwise use the table below.
4. **Verify**: `GET /subscription-pool` shows the account `active`, `identityDrifted: false`, right email.

## 3. When a repair does not finish

| What the episode/page shows | What it means | Do this |
|---|---|---|
| `captcha` / `phone-confirmation` / operator-only | Provider wants a human | Tell the operator once, with the dashboard link; never retry through it |
| `relogin-profile-in-use` | That profile's Chrome is already open | Wait until it is closed; never close it yourself |
| `pending-login-already-live` on retry | An older login is still waiting | `POST /subscription-pool/enroll/<id>/cancel`, then retry |
| Google asks for the password or 2-step again | The profile's Google session expired | The repair types the password and authenticator code from the vault; if either is missing, do step 1.2 |
| Google asks for a phone tap, SMS, or "verify it's you" | Google's own risk check | Hand to the operator once; never try another method to get around it |
| Google asks for a second step on an account whose authenticator is on the person's phone | Normal for those accounts | The repair uses ONE saved backup code (vault entry bound as `backupCode`), removed from the list before use; when the list runs low, make new codes from the account's security page |
| Operator-only with reason `plain-browser-automation-not-permitted` | macOS hasn't allowed the agent to control Chrome on this machine | Ask the operator once to allow it (System Settings, Privacy & Security, Automation), then Try repair again |
| Anything else | Read the reason | `GET /subscription-relogin/EPISODE/events`: every attempt records a short reason token (e.g. `chrome-launch-timeout`) |
| Profile missing on this machine | Never set up here | Do section 1 on this machine |
| Authorize button stays greyed out | Normal on Claude until the page sees pointer activity | The repair handles it; if it persists after a minute, hand off |
| Repeated failures on one account | Something structural | Stop retrying after two attempts; report the episode id and last event |

## 4. Keeping it healthy (the 20% that prevents 80% of failures)

- One profile per Google account per machine, registered, signed in to Google, with password and authenticator secret in the vault.
- Keep each profile's Google session in use: open it in a normal browser about weekly, so an expiry is caught before Claude or Codex needs it.
- Don't hammer sign-in pages: each failed automated-looking attempt raises the provider's risk score. One clean attempt, then hand off.
- When you learn something new about a sign-in page, update this skill's table — the procedure is the memory.