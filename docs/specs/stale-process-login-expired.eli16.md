# One stuck session should not knock out a working login (plain-English overview)

## What this change is

The agent runs many Claude Code sessions, and several of them can share one subscription login (one folder holding that account's saved sign-in). Each session keeps its own copy of the sign-in in memory. When one session renews the sign-in, the provider retires the old copy, and another session that has been running a long time can be left holding the retired copy. That one session then shows "Login expired", even though the saved sign-in is perfectly fine. A brand-new session would work.

Today the agent treats that one screen as proof the whole login is dead. It marks the account "needs sign-in" and keeps it marked for up to 12 hours, even while its own regular usage checks, made with the saved sign-in, keep succeeding. Worse, it starts an automatic re-sign-in that restarts itself every few minutes and can never finish, because the account is never "healthy" enough for the cleanup to close it. That is exactly what happened on the Mac Studio on 20 November 2026 to the Adriana account. I checked by hand: a fresh session with that login worked fine.

## What already exists

- The quota poller decides whether each account is usable. It is the one place that marks an account "needs sign-in".
- A watcher notices a session stuck on "Login expired" and moves its conversation to a working account.
- The sign-in procedure already says the only real proof of being signed in is a real request that works.

## What's new

- Before benching an account because one session showed "Login expired", the agent sends one fresh, tiny Claude request using only that login's saved sign-in: no tools, no plugins, no settings and no other credentials. If it works, the screen came from a session holding an old copy. The account stays usable, and only that one session is restarted, on the same account, with its conversation carried over.
- If an account is already benched this way (for example, right after this update installs), the next regular usage check runs the same fresh request. If it works, the account comes back. Then the existing cleanup closes the stuck re-sign-in by itself.
- If the fresh request fails, or can't be run, nothing changes from today: the account is benched, exactly as it is now.
- The "conversation went quiet" watcher waits at most 3 minutes for that restart, and sends a plain note saying what's happening. After 3 minutes it handles the conversation exactly as it does today.

## The safeguards, in plain terms

- The agent only relaxes on positive proof. A timeout, a network hiccup or anything unclear keeps today's careful behaviour.
- The fresh request is tiny (one short reply from the smallest model). It runs at most 6 times per account in 12 hours, never while the saved sign-in is about to expire (so it can't cause a renewal itself), within the machine's normal limit on how many of these run at once, and only when an account has actually shown an "expired" screen. Each one is recorded in the cost ledger.
- The stuck session is still restarted, because it can't work as it is. It restarts on its own account; it's only moved to a different account if the saved sign-in really doesn't work.
- One setting turns the whole thing off and restores today's behaviour exactly.

## What you need to decide

Nothing. It fixes a real false alarm that benched a working account and caused a sign-in loop. It ships on, with a live off switch. The only thing it stores is a small file counting the checks, so the limit survives restarts. A revert fully undoes it.
