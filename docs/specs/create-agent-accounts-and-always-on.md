---
title: "Create my agent: choose the AI account, and an Always available option"
slug: create-agent-accounts-and-always-on
author: echo
status: converged
review-convergence: "2026-11-17T20:58:00Z"
review-iterations: 3
parent-principle: "The Person Decides; the Agent Does the Rest"
eli16-overview: create-agent-accounts-and-always-on.eli16.md
approved: true
approved-by: "Justin, topic 143810, 2026-11-17 12:23 PST: asked for the account choice ('ask the user if they would like to use an existing account and provide the selection of the existing account to use or whether they would like to login to a new account') and for Always available ('Yes, 1 Password prompt is fine if they choose this option')"
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
- **The install's sign-in** checks the default `~/.claude` (or `CLAUDE_CONFIG_DIR`) or `~/.codex` (`src/install/doors.ts:83,156`, `src/install/doorSteps.ts:156`). The new agent records no account folder.
- **How the app and the installer talk.** The Mac app writes an answers file and runs `instar install --yes --answers` (`MacCreateAgent.swift:113,126`). It polls `~/.instar/state/install-progress.json` (`MacAgentCreator.swift:35`; `src/commands/install/progress.ts`), turns `awaiting-person` into a waiting screen, and re-runs with `--resume`.
- **Always available today.** The agent starts at login with a per-user LaunchAgent, with no admin needed (`src/commands/setup.ts:1756`). The server runs `caffeinate -s` while it is up, which holds only on mains power (`src/core/CaffeinateManager.ts`). Nothing starts before login and nothing changes `pmset`.

## A. Choosing the account

1. **Finding accounts (new: `src/install/accounts.ts`).** For the chosen AI, list the accounts signed in on this Mac, reading identity only and never a secret.
   - **Claude:** the default `~/.claude` (or `CLAUDE_CONFIG_DIR`), plus every config folder in any Instar agent's `subscription-pool.json` on this Mac (`~/.instar/agents/*/.instar/`) that belongs to this machine and has a keychain item or `.credentials.json`. The label is the email from `.claude.json`, or "Claude account (email unknown)".
   - **ChatGPT:** `~/.codex`, plus pool folders whose `auth.json` decodes. If Codex is set to keep its sign-in in the keychain (keyring storage), the account is listed by its config only, with no email, labelled "ChatGPT account on this Mac".
   - **Ids:** an account's id is a hash of its real folder path, so a resume cannot land on a different account.
   - **Same email:** when two folders share an email, the one that proves signed in is kept, and the default folder wins a tie. Sorted default first.
2. **The install step (new state `account-choice`, after `door-install` and before `door-sign-in`).**
   - No account found: sign-in runs as today.
   - One or more found: it writes `install-progress.json` with `status: "awaiting-person"`, `waitingFor: "account-choice"` and `accounts: [{ id, label, plan?, borrowedFrom? }]`, then stops.
   - The answers file gains `account: { use: <id> } | { new: true }`. A `--resume` reads it; an id that no longer matches a found account is refused with a plain reason.
   - An older Mac app that doesn't know `account-choice` sees a waiting state it doesn't understand. It shows its generic "Continue" screen. Continuing without an answer means "use the default folder" when that folder is signed in (today's behaviour), and otherwise goes to sign-in.
3. **Using an existing account.**
   - **The default folder:** the new agent's pool gets it as its first account, as today.
   - **A folder inside another agent's home:** it is added with `borrowed: { from: <agent> }`, a new pool field. Sharing a folder is the same posture as agents sharing the default `~/.claude` today. The `claude` and `codex` tools refresh their own sign-in when a session runs, so two agents on one folder can race on a refresh exactly as they can now; this change does not make that worse, and it does not claim to fix it.
   - The card is honest about it: "Shared with <agent>. The agents share this account's usage limit and sign-in. For an agent that runs on its own, sign in to a different account." When that account is borrowed, "Sign in to a different account" is shown first.
   - If the owning agent is deleted, the borrowed entry shows "signed out" with a sign-in button; nothing fails silently.
4. **A new account.**
   - A fresh folder is made at `~/.instar/accounts/<agentName>/<door>-<n>` (mode 0700), with the next free n, so a re-run never reuses a folder. It sits outside the agent's home because sign-in happens before the agent is created, and agent creation sets aside a half-made agent folder.
   - Sign-in runs into it with `FrameworkLoginDriver` setting `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (`src/core/FrameworkLoginDriver.ts:96-98`), with the same browser handoff as today.
   - The install's sign-in check (`doors.ts:83,156`) is given that folder.
5. **Pool entries** are insert-if-absent, keyed by the account id, and carry the machine id, so another machine of a multi-machine agent never tries a path that exists only here.
6. **The app.** On `waitingFor: "account-choice"`, the Mac shows the choice in the restyled create look:
   - one card per account, titled "Use" plus the email, with its plan when known and "shared with <agent>" for a borrowed one;
   - a last card, "Sign in to a different account".
   - The pick goes into the answers file, then `--resume`.

## B. Always available

This is the Direct (unsandboxed) Mac build only. The sandboxed build cannot read `~/.instar` or run the helper, and it doesn't show the switch.

1. **What the switch promises, honestly.** It is off by default. Before showing it, setup checks FileVault (`fdesetup isactive`).
   - **FileVault on** (the default on new Macs): a restarted Mac waits at the unlock screen and nothing can run before someone types the password. The switch then reads "Keep <agent> available: restarts after a power cut once you unlock the Mac, and stays awake while plugged in". It promises nothing before login.
   - **FileVault off:** "Starts when the Mac starts, even before anyone logs in, and stays awake while plugged in."
   - Either way it says the Mac's password is asked once to turn it on, and once again to turn it off.
2. **The privileged helper.** It is an `SMAppService.daemon` helper bundled in the Direct build (Apple's signed route); macOS shows a one-time "allow" in System Settings plus the password. No `osascript` admin shell is used, so no name or path is ever spliced into a root command. The helper:
   - **checks the caller:** it accepts an XPC connection only when the caller's code signature satisfies a code requirement naming the Instar app's Team ID and bundle id (audit token, `SecCodeCheckValidity`). Any other process is refused.
   - **takes the user from the caller:** the user the daemon runs as is read from the caller's audit token (its uid), never from a field in the request.
   - **checks the path after resolving it:** the agent home in the request is resolved to its real path (symlinks followed) and must lie under that user's home and hold an Instar agent config.
3. **What it changes.**
   - `pmset -c sleep 0`: on mains power the Mac does not sleep while the lid is open; a closed laptop lid still sleeps, and the switch says so.
   - `pmset autorestart 1`: power returns, the Mac starts.
   - **FileVault off only:** a LaunchDaemon that runs the agent's server as the person's user (`UserName`).
   - **Turned-on period:** while the daemon is on, the agent's per-user LaunchAgent is turned off, so the two never fight over the instance lock. Undo turns it back on.
   - Before changing them, it records the previous `pmset` values in a **root-owned** file (`/Library/Application Support/Instar/always-available/<agent>.json`). Undo puts a value back only if it is still the one Instar set.
4. **Claude before login (FileVault off only).** A daemon runs outside the login session and cannot read the login keychain. A daemon-started agent therefore needs a Claude token as its main sign-in, not a fallback. Setup asks the person for one:
   - "Paste the code from the Claude sign-in page" opens `claude setup-token` in the browser; this reuses the existing paste route (`src/commands/install.ts:546-558`, `setClaudeKey`).
   - The token is checked against the chosen account's email (`GET /api/oauth/profile`, `CredentialIdentityOracle`), and a mismatch is refused.
   - It is stored agent-wide, where the existing route puts it (`sessions.credentials.anthropic`, `writeClaudeKeyToConfig`), with the config file at mode 0600. That makes it the Claude sign-in for every session of this agent while Always available is on; the email check above is what makes it the chosen account. The record keeps any token that was there before (one set with `set-claude-key`). Turning Always available off removes the token only if it is still the one setup wrote, and otherwise puts the earlier one back; the agent then goes back to its pool folder.
   - While the switch is on, this token overrides the pool: every session uses the chosen account, and the pool can't move to another account when this one reaches its usage limit. The switch's detail line says so, and a test covers it.
   - The token lasts about a year. The existing `ClaudeKeyHealth` warning watches it, so the person is told before a daemon-started agent loses Claude. Other agents' credentials are never touched.
   - The paste screen shows the expected email first ("Sign in as <email>, then paste the code"), so the email check doesn't loop on a browser signed in to another account.
   - If the person skips it, the daemon is not installed: the switch keeps restart and awake, and says the agent starts at login.
   - **Codex:** a file-based sign-in needs nothing more. A keyring-stored Codex sign-in is treated like Claude: start at login only.
5. **Other things that start the agent.** The fleet watchdog (`ai.instar.watchdog`, `setup.ts:1668`), recovery autostart and the update migrations that reinstall the per-user LaunchAgent all read the Always available record first. While it is on they leave the LaunchAgent off and never start a second copy. A test covers each of them.
6. **Limits of a daemon-started agent.** It runs outside a desktop session: browser automation, notifications and anything needing the logged-in desktop don't work until someone logs in. The switch's detail line says so in plain words.
7. **Settings** gets "Always available" with the same switch. It re-checks FileVault each time it opens and updates the wording if that changed. Turning it off asks for the password and undoes exactly what the record lists.

## Rollback

- A: without an `account` answer, the install behaves as today.
- B: the switch is off by default. "Turn off" removes the daemon, turns the LaunchAgent back on, and restores the recorded `pmset` values that are still Instar's.

## Tests

- **Unit:**
  - account discovery against a fixture home holding two Claude folders, one with the same email, one Codex folder and a keyring-stored Codex;
  - the `account-choice` state, both answers, a stale id, and the older-app fallback both with and without a signed-in default folder;
  - the pool written for `use`, for `new` (next free folder on a re-run) and for a borrowed folder;
  - the FileVault on/off wording;
  - the Always available plist; the undo record only restoring values still Instar's; the LaunchAgent turned off and back on;
  - the watchdog, recovery and update paths respecting the record;
  - the token refused on an email mismatch, and removed on turn-off.
- **Helper (Swift):** a request from an unsigned or foreign process is refused; a request naming a symlinked or out-of-home path is refused; the user is taken from the caller.
- **Integration:** an install with `--answers` and an account choice, resumed, ending with the pool's first account being the chosen folder.
- **E2E:** the install-progress file carries `accounts` on a fixture Mac home.
- **Live:**
  - on a Mac with two Claude accounts, create an agent, pick the second, and check the first session reports that account's email;
  - with Always available on a throwaway user, reboot and check the agent answers before login; then log in and check that the watchdog and the LaunchAgent don't start a second copy.

## Review

Round 1, an independent review on 2026-11-17, found three critical issues, four high and four medium. The text above now covers them:
- the before-login Claude sign-in is a pasted token that becomes the agent's main sign-in, checked against the chosen account and stored with mode 0600;
- FileVault is checked, and the switch's words follow it;
- `autorestart` is set;
- the LaunchAgent is turned off while the daemon runs;
- folders in other agents' homes are borrowed, not refreshed;
- the helper is an `SMAppService` daemon taking a typed request, with no osascript;
- the undo record is root-owned and conditional;
- keyring-stored Codex sign-ins are detected;
- account ids are path hashes;
- runs can repeat safely, with insert-if-absent pool entries tied to their machine;
- of two folders with the same email, the signed-in one is kept;
- the lid-close and turn-off-password wording is added;
- `disksleep` is dropped.

Round 2 found two high findings (the helper must check its caller's signature, take the user from the caller and resolve the path; the token's agent-wide storage must be named) plus a partial one (borrowed accounts can still race, because the tools refresh themselves), and six more. All are covered above: the caller signature check, the agent-wide token at mode 0600 removed on turn-off, the shared-account card that recommends a fresh sign-in, watchdog/recovery/updates respecting the record, the older-app fallback to sign-in, the daemon limits wording, the expected email shown first, FileVault re-checked in Settings, and the expanded tests. Round 3 closed every critical and high finding. Its four remaining points are folded in: an earlier token is kept and restored, the pool override is stated and tested, the token's expiry is watched, and the live test covers a login after boot. The spec is converged after three rounds.
