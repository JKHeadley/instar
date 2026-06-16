# Pool-Aware Quota Throttle — Plain-English Overview

## What this is, in one line
A fix so the agent stops freezing all its work when *one* of its several Claude accounts hits its weekly limit — while the other accounts sit completely unused.

## The problem (what actually happened on 2026-06-15)
The agent can hold several Claude subscriptions and use them as one pool. Inside it there's a "brake" that decides, before starting any work, whether there's enough quota to run. That brake was **account-blind**: it looked at a single number — one account's usage — and if that number was high, it slammed the brake on the *whole agent*. So when one account ("SageMind-Justin") hit 100% of its weekly limit, everything stopped — even though two other accounts were sitting at 0%, totally fresh. The operator saw exactly that on his dashboard and asked, rightly, "why aren't those two accounts being used?" To make it worse, when the agent couldn't read its real usage it fell back to a rough estimate that read "186%", which jammed the brake even harder.

## What changes
The brake now reasons about the **whole pool**, not one account. Before, it had its own private (and stale) view of usage. Now it simply asks the part of the system that actually places work onto accounts — "is there an account you can place this on, and how much room does it have?" Because the brake and the placer now share the *exact same* decision, the brake can never stop the agent while a usable account exists, and it can never green-light work the placer can't actually run (which used to cause a restart loop — the "session respawned" storm).

It's also careful when it can't trust the data: if usage readings are missing or look broken (like that 186% estimate), it doesn't blindly stop *and* doesn't blindly run everything — it runs the important work and quietly holds back only the low-priority background tasks until real numbers come back. A genuine hard "you're rate-limited right now" signal is always respected.

## What already existed vs. what's new
- **Already existed:** the multi-account pool, the placement logic that picks the best account, the per-account quota readings.
- **New:** the brake now *consults the placement logic* instead of a separate stale number; a small safety guard for missing/untrustworthy readings; and it's wired up so it actually runs in the real server (the first draft of this fix accidentally never fired in production — the review caught that).

## Safeguards, in plain terms
- A single account maxing out can no longer freeze the agent.
- The agent can't start work on an account that's actually full (no more restart loops).
- If the agent is genuinely out of quota on *every* account, it correctly waits — and un-waits automatically the moment a window resets.
- A solo (single-account) agent behaves exactly as before — no change, no risk.

## What you'd decide
Nothing new to configure. It ships on by default because it removes a bug (an over-eager brake); it's a pure code change, reversible by reverting the commit, and a separate later change will add the "use the soonest-to-reset account first" optimizations.

## How we know it's right
It went through a hard multi-reviewer review (six internal reviewers plus an outside GPT-5.5 read). The first two designs were rejected — one was dead in production, one had a subtle restart-loop gap — and the review drove the redesign you see here. It's covered by tests at three levels, including a test that proves "if the brake says go, there's always a real account to place on."
