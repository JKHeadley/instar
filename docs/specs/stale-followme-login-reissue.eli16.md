# Stop asking for a sign-in that already worked — plain overview

## What this is

When one of the agent's subscription accounts needs signing in again on a machine, Instar opens a "pending login": a sign-in link with a code, shown on the Pending Logins surface. Codes expire after about 15 minutes, so a background check renews any expired code by starting a fresh sign-in process.

That renewal had no way to notice that the account was already signed in. It only closed a pending login when it saw the saved login change after the latest renewal, and each renewal reset that comparison. On Linux machines it could not see the saved login at all. So once a sign-in finished some other way (an automatic repair, or the account recovering on its own), its pending login kept being renewed forever.

On 2026-11-13 five of these were running for accounts that were working normally. One on Mama PC had been renewed 1113 times in 11 days: a new sign-in process every 15 minutes, and a sign-in request on screen that nobody needed.

## What already exists

- The pending login list and the renewal check.
- A live identity check: Instar can ask which account a saved login belongs to. It already uses this to confirm a sign-in after someone pastes a code.
- The list of accounts on each machine, with whether each one is working.

## What is new

Before renewing an expired Claude code (or after a restart, when every code's process is gone anyway), Instar checks two things. First, with no network: does this machine already list the account as working, under the expected email, with no mix-up? Only then: does the saved login answer a live identity check as exactly that account? If both say yes, the stale sign-in request is closed and no new code is made. Nothing about the account itself is changed, because it was already working. In every other case renewal works as before: an account listed as signed out, a different account, no answer, an error, a Codex account, or a sign-in that is not tied to an expected account.

## Safeguards in plain terms

- It only acts when the old code had already expired or its process died, so it cannot close a sign-in someone is in the middle of.
- It needs an exact match with the expected account, and the account must already be listed as working. A mismatch changes nothing and raises no alert.
- Codex accounts are left out: their saved login names the account even after it stops working, so it is not proof.
- If the login changed while the check ran (cancelled, finished, renewed), it is left alone.
- The repair system's own renewal path is not changed.
- Undoing it is a plain revert.

## Why it matters for the accounts

One identity read replaces an endless stream of sign-in processes. Automation stays the same, and the agent makes fewer, more ordinary requests to the provider.

## What the reader needs to decide

Nothing. This is a narrow fix with a plain revert path.
