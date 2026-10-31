# Noticing when OpenAI's new device limit locks out a Codex account — Plain-English Overview

> The one-line version: if OpenAI ever tells one of our machines "Device limit reached" for a Codex account, the agent now notices, stops using that account on that machine only, never keeps trying to sign it back in, and tells the operator once.

## The problem in one breath

On 31 October 2026 OpenAI started limiting how many paid personal ChatGPT accounts (Go, Plus, Pro) one device can use. Over the limit you see "Device limit reached" when signing in, or get signed out later. Signing out of a different account does not free a slot. OpenAI did not say what the number is. Echo uses 5 personal Codex accounts on each of 3 machines, and the operator decided to keep doing that and just add a tripwire. Without one, a lockout would look like an ordinary sign-out, the automatic sign-in repair would keep trying (up to 12 times per account per machine), and each try would hit the same wall, which is exactly the kind of repeated attempt a provider might read as abuse.

## What already exists

- **The quota check** reads every Codex account's limits every few minutes by asking the Codex program directly. When an account stops answering because it is signed out, it marks it "needs sign-in".
- **The automatic sign-in repair** starts for accounts marked "needs sign-in" for reasons it can act on, and retries some kinds of failure slowly.
- **The expired-login watcher** reads the bottom of a Claude session's screen for "please log in" and moves the conversation to a working account. It does not watch Codex sessions.
- **The session move** restarts a conversation on another account of the same kind, with brakes so it cannot thrash.

## What this adds

A new reason an account can be benched: "Codex device limit". It is deliberately a reason the sign-in repair refuses to act on. Benching an account on one machine takes it out of new work and out of swap targets on that machine only, because the limit is per device. The same account keeps working on the other machines.

**Who decides: Jev, not a word match.** The operator asked that this not be a brittle string check. So the decision "is this really a device-limit lockout?" is made by Jev, the fast model the agent already uses for judgement calls, reading OpenAI's own refusal message. When Jev is unsure, a second model (GPT-6 Luna) referees. If neither model is reachable, nothing gets benched and everything behaves as it does today. Each "yes" is checked again later against what actually happened, so how often Jev is right gets measured.

Three places can bring a case to Jev:

1. **The quota check.** When OpenAI refuses the quota check for an account, its refusal message goes to Jev. Only this, OpenAI's own answer about this login, can bench an account, and it has to happen twice: one "yes" makes the account *suspected* and schedules another check five minutes later; only a second, separate refusal judged "yes" within the hour benches it.
2. **Codex sessions' screens.** If a session's screen looks like a sign-in problem for a minute, the agent runs a quota check on that account right away, and that check goes to Jev as above. The screen text itself never benches anything, because a session might just be talking about device limits. If the account is confirmed benched, the conversation moves to another Codex account, using the same brakes as the expired-login move.
3. **The sign-in repair.** If a sign-in page that the repair doesn't recognise is judged to be a device-limit page, or the repair's helper reports one, that one repair stops and is not retried. It doesn't bench the account and doesn't send a message by itself; it asks for a quota check, and that decides.

The operator gets **one** message per machine, listing the benched accounts there. It is low-key while the machine still has a working Codex account, and urgent only if none are left. It updates itself as the list changes and clears when the accounts work again.

## The safeguards

**Only OpenAI's own refusal can bench an account.** Screens and web pages can at most start a quota check or stop one sign-in attempt.

**It undoes itself.** Two normal quota checks in a row, five minutes apart, bring an account back. Setting the account active again does too. If the operator says "keep using it on that machine anyway", the agent puts it on that machine's ignore list and it is never benched there again. A later ordinary sign-out is then repaired as usual.

**It doesn't keep knocking.** While an account is benched, its quota check runs hourly at first and then less often, at most every six hours, so OpenAI doesn't see a stream of refused attempts.

**Personal details stay home.** Before any text goes to Jev or the referee, passwords and keys are scrubbed and e-mail addresses, names and phone numbers are masked. The referee also runs on a different Codex account from the one being judged, so a locked-out account never judges itself.

**It won't bench everything at once.** If every Codex account on a machine is refusing in the same way, that is almost certainly not the device limit (the limit leaves the accounts under it working), so nothing is benched and the message says so.

**It can only make the agent do less.** Every effect benches one account on one machine, stops a sign-in attempt, or sends one message. Nothing signs in, spends quota, deletes anything, or touches other machines.

**It can be switched off** with one setting. Benched accounts then go back to working normally within one check, and today's rules decide afresh.

## What you need to decide

Nothing up front. The operator already chose: keep all accounts everywhere and detect. If the tripwire fires, the message asks which machine should keep which accounts. Leaving the account benched is a fine answer.
