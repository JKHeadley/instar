# Conversations stuck at an expired Claude login recover by themselves — Plain-English Overview

> The one-line version: when a chat session lands on a Claude account whose sign-in has expired, the agent now notices the "please log in" screen within about a minute, marks that account as needing sign-in, and moves the conversation to an account that works.

## The problem in one breath

The agent can hold several Claude subscriptions and spread conversations across them. On 2026-10-25 one of them (on the sagemind agent, "Luna") had an expired sign-in, but its saved key still answered the quota check, so the agent kept treating it as healthy. New Telegram conversations were placed on it and every reply was just "Login expired · Please run /login" (newer Claude Code says "Not logged in · Run /login"). Nothing noticed. Marking the account by hand did not help either: the next quota check flipped it back to healthy. Only a manual "move this session" call fixed it.

## What already exists

- **The expired-login detector** — reads the bottom of a session's screen and recognizes Claude Code's own login-failure line. Until now only scheduled-job sessions were checked, and a job stuck there was simply ended.
- **The quota checker** — polls each account's quota. It could mark an account "needs sign-in" from that screen only when the saved key was unreadable AND two sessions saw the screen within an hour.
- **The session move** — the same mechanism as the manual swap route: restarts a conversation on another account and resumes it, with the existing protections against moving a session in the middle of work and against moving too often.
- **The automatic sign-in repair** — starts when an account turns "needs sign-in" for a reason it can act on.

## What this adds

Chat sessions are now watched for that login screen too. When the screen has stayed on the live bottom of a session for a minute, the agent does two things. First it marks the account "needs sign-in", even though the quota check still works, because Claude Code refusing to run is the stronger evidence; the reason it records is one the automatic sign-in repair accepts. Second, it moves the conversation onto a signed-in account through the same move the manual route uses, so the conversation continues.

- The newer "Not logged in · Run /login" wording is recognized.
- The quota checker no longer flips such an account back to healthy while the saved key is the same one Claude Code refused.
- The same rule now applies when a scheduled-job session sees the screen.

## The safeguards

**No false alarms from old text or tool output.** Only Claude Code's own message line, at the live bottom of the screen, for a full minute, counts. A mention scrolled up the screen, a message quoting the words, or the output of a command such as `claude auth status` does not.

**A locked keychain is not a dead login.** If the saved key cannot be read at all (which also happens right after a reboot when the keychain is locked), one screen is still not enough; the older two-session rule applies, and the conversation is not moved until the account is confirmed dead (moving it would only land on the same locked keychain).

**The mark releases when the login is fixed.** A new sign-in changes the saved key, which releases the hold at once; so does the sign-in repair marking the account healthy, an operator doing so, the repair's own key swap, and a 12-hour ceiling. The hold is only kept in memory, so a server restart also releases it. If the login is still broken after that, the next session that lands on it notices again within a minute.

**No thrashing.** One move attempt per session per 10 minutes and at most three per session, protected sessions are never moved, the move keeps its existing "don't kill in-flight work" and rate protections, and there is a switch to turn the move off (`subscriptionPool.loginExpiredSwap.enabled: false`).

## What ships when

All in one change, on by default. The switch above turns off the move; the marking is a correctness fix and stays on.
