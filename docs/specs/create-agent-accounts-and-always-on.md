---
title: "Create my agent: choose the AI account, and an Always available option"
slug: create-agent-accounts-and-always-on
author: echo
status: draft
parent-principle: "User setup must be trivial"
eli16-overview: create-agent-accounts-and-always-on.eli16.md
---

# Create my agent: choose the AI account, and an Always available option

## Why

Justin tested "Create my agent" on Mac build 92 on 2026-11-17 (topic 143810). Two requests came out of it, in his words:

- "we should be intelligent about the provider option selection. In other words if they choose Claude or ChatGPT and the system to text that is there is already a Claude or ChatGPT account or multiple accounts on the machine it should ask the user if they would like to use an existing account and provide the selection of the existing account to use or whether they would like to login to a new account" (12:23 PST).
- On the setup step: "starting with the machine (before login); keeping the machine on (no sleep); any other functionalities that we use for all of our Instar agents that make it more available/capable" (12:0x PST), and "Yes, 1 Password prompt is fine if they choose this option" (12:23 PST).

The installer's own bug from the same test, where a ChatGPT pick produced a Claude agent, is fixed separately in instar PR #3316.

## What exists today

Each item names its file and line.

- **Who an account is.** Claude: the keychain item `Claude Code-credentials`, or `Claude Code-credentials-<sha256(home)[0:8]>` for any other `CLAUDE_CONFIG_DIR` (`src/core/OAuthRefresher.ts:175-176`); the email comes from `<home>/.claude.json` via `readAccountEmail` (`src/core/QuotaPoller.ts:316`), with no network call. Codex: `readCodexSlotIdentity` decodes `<CODEX_HOME>/auth.json` into email, accountId and planType, also with no network call (`src/providers/adapters/openai-codex/codexSlotIdentity.ts:104`).
- **Several accounts.** Only an agent's own subscription pool holds several, one config folder each (`src/core/SubscriptionPool.ts:118-136`). Sessions point the tool at an account with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (`src/core/SessionManager.ts:728,932,1027`).
- **The install's sign-in** checks only the default `~/.claude` or `~/.codex` (`src/install/doors.ts:83,156`, `src/install/doorSteps.ts:156`). The new agent records no account folder.
- **How the app and the installer talk.** The Mac app writes an answers file and runs `instar install --yes --answers` (`MacCreateAgent.swift:113,126`). It polls `~/.instar/state/install-progress.json` (`MacAgentCreator.swift:35`; `src/commands/install/progress.ts`), turns `awaiting-person` into a waiting screen, and re-runs with `--resume`.
- **Always available today.** The agent starts at login with a per-user LaunchAgent, with no admin needed (`src/commands/setup.ts:1756`). The server runs `caffeinate -s` while it is up, which holds only on mains power (`src/core/CaffeinateManager.ts`). Nothing starts before login and nothing changes `pmset`.

## A. Choosing the account

1. **Finding accounts (new: `src/install/accounts.ts`).** For the chosen AI, list the accounts signed in on this Mac, using names and identity only and never reading a secret:
   - Claude: the default `~/.claude`, plus every config folder named in any Instar agent's `subscription-pool.json` under `~/.instar/agents/*/.instar/` on this Mac, keeping those with a keychain item or `.credentials.json` present. The label is the email from `.claude.json`, or "Claude account (email unknown)".
   - ChatGPT: `~/.codex`, plus the pool folders whose `auth.json` decodes. The label is email and plan.
   - Accounts with the same email are shown once. The list is sorted with the default folder first.
2. **The install step (new state `account-choice`, after `door-install` and before `door-sign-in`).**
   - No account found: it goes straight to sign-in, as today.
   - One or more found: it writes `install-progress.json` with `status: "awaiting-person"`, `waitingFor: "account-choice"` and `accounts: [{ id, label, plan? }]`, then stops.
   - The answers file gains `account: { use: <id> } | { new: true }`. A `--resume` reads it; an id that no longer matches a found account is refused with a plain reason.
3. **Using an existing account.** The new agent's pool gets that config folder as its first account, and sessions use it through the existing pin. Nothing is copied; the account is shared, the way agents on one Mac already share it.
4. **A new account.** A fresh config folder is made under the new agent's home (`<agentHome>/.instar/accounts/<door>-1`). Sign-in runs into it, with `FrameworkLoginDriver` setting `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (`src/core/FrameworkLoginDriver.ts:96-98`). The browser handoff is the same as today. The folder becomes the pool's first account.
5. **The app.** On `waitingFor: "account-choice"`, the Mac shows the choice in the restyled create look:
   - one card per account, titled "Use <email>", with its plan when known;
   - a last card, "Sign in to a different <Claude|ChatGPT> account".
   - The pick goes into the answers file, then `--resume`.
6. **The agent's config** records the account by its config folder, never by a secret.

## B. Always available

1. On the confirm step, one switch: "Always available: starts when the Mac starts, even before anyone logs in, and keeps the Mac awake." It is off by default; turning it on says plainly that the Mac's password is asked once.
2. When it is on, after the agent is created, the app runs one privileged helper with a single macOS password prompt (`osascript … with administrator privileges`, or `SMAppService.daemon` with a bundled helper; the choice is settled in review). The helper does three things:
   - installs a LaunchDaemon that runs the agent's server as the person's user (`UserName` in the plist), so it starts at boot;
   - sets `pmset -c sleep 0` and `pmset -c disksleep 0` (on mains power, never sleep), keeping the display's own sleep;
   - writes a record of what it changed, so "Turn off Always available" can undo exactly that.
3. **The keychain catch.** Before anyone logs in, the login keychain is locked, so a Claude sign-in kept in the keychain can't be read and the agent can't use Claude until someone logs in. When Always available is on, setup therefore also creates a long-lived token (`claude setup-token`, saved with the existing `writeClaudeKeyToConfig` route, `src/core/claudeChildAuth.ts:209`) as the pre-login fallback. Codex keeps `auth.json` on disk, so it needs no fallback. If the token can't be made, the switch says it will start at login instead.
4. The per-user LaunchAgent stays as it is; the daemon and the agent refuse to run twice (the existing instance lock).
5. Settings gets "Always available" with the same switch, and turning it off undoes the record.

## Rollback

- A: without an `account` answer, the install behaves as today.
- B: the switch is off by default, and "Turn off" removes the daemon and restores the recorded `pmset` values.

## Tests

- **Unit:**
  - account discovery against a fixture home holding two Claude folders, one with the same email, and one Codex folder;
  - the `account-choice` state, both answers and a stale id;
  - the pool written for `use` and for `new`;
  - the Always available plist and the pmset undo record.
- **Integration:** an install with `--answers` and an account choice, resumed, ending with the pool's first account being the chosen folder.
- **E2E:** the install-progress file carries `accounts` on a fixture Mac home.
- **Live:**
  - on a Mac with two Claude accounts, create an agent, pick the second, and check the first session reports that account's email;
  - with Always available on a throwaway user, reboot and check the agent answers before login.

## Open for review

- The privileged helper route: `osascript` (simplest, one prompt, unsigned script) or an `SMAppService` daemon (signed and Apple's recommended route, but needs a bundled helper and a one-time approval in System Settings).
- Whether a shared account (two agents on one Claude account) should warn about sharing the usage limit. The default is a one-line note on the card.
