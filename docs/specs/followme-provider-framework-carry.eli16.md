# Cross-machine account follow-me keeps the account's kind — Plain-English Overview

> The one-line version: when one machine hands an account to another, it was forgetting what kind of account it was and assuming Claude, so a Codex account got signed in through the Claude door and retried forever.

## The problem in one breath

You have several subscriptions — Claude accounts and a Codex account — and you want each of your machines to be able to use them. When you approve an account moving to a second machine, that machine has to sign in for itself. It first looks up which service the account belongs to, so it knows which sign-in to run. If the account only exists on the *other* machine, that lookup was dropping the answer and just guessing "Claude" every time. Your Codex account was therefore sent to Anthropic's sign-in page, and stored under a folder the Codex program never looks in. It could never finish, so the system kept starting it over, every few minutes, indefinitely.

## What already exists

- **The account pool** — the list of subscriptions the agent can draw on, one entry per account, recording which service it belongs to and where its login is stored on that machine.
- **Follow-me** — the approved path for making an account usable on a second machine. Nothing is copied: the second machine signs in on its own, once, with your approval. That is deliberate, and it is why the second machine needs to know what kind of account it is dealing with.
- **The peer lookup** — how one machine asks another machine what accounts it has. It already returns each account's service; the receiving side just was not keeping that part.
- **The sign-in helper** — already knows both flows, and already picks the Codex one for Codex accounts. It was simply never told it had a Codex account.
- **The retry budget** — a limit on how many times a stuck sign-in gets re-attempted before it stops and waits for you. Some failures are routed into it; others were not.

## What this adds

The account's service now travels with the account. When a machine asks a peer what accounts it holds, it keeps the answer instead of discarding it, and the sign-in that follows uses the real service rather than a guess. That alone fixes the loop: a Codex account now goes to Codex's sign-in and is stored where the Codex program will actually find it.

Two smaller changes come with it:

- If two of your machines have contradictory records about the same account — one calling it a Claude account, the other calling it Codex — the system stops and says so, rather than picking whichever answered first. That refusal is routed into the existing retry budget, so it parks and waits for you instead of retrying something retrying cannot fix.
- The folder each sign-in is stored in is now named after the service. Existing Claude folders keep their exact names, so nothing that works today moves.

## The new pieces

- **A service-agreement check** — when more than one machine has an opinion about what kind of account something is, they have to agree. This is not a judgment call: an account belongs to exactly one service, so two different answers means the records are wrong, not that a choice needs making. A machine running an older version, which does not send the service at all, simply stays out of the vote rather than being counted as a vote for "Claude".
- **A folder-naming rule** — one line that maps a service to the folder its login belongs in. It exists as its own piece, rather than being buried in the sign-in code, because getting it wrong is invisible: the file is written successfully, to a place nothing reads.

## The safeguards

**Prevents a wrong guess from being made silently.** The previous behaviour did not fail loudly; it produced a plausible-looking sign-in attempt against the wrong service. The service now either comes from a machine that actually holds the account, or, where nobody states it, falls back exactly as before — so no existing setup changes behaviour.

**Prevents one endless loop turning into another.** The contradictory-records case still cannot succeed, so it is deliberately routed into the retry budget that already exists for the equivalent "records disagree about the email address" case. It tries a bounded number of times, then stops and waits for a person.

**Prevents breaking machines running older versions.** A mixed set of machines is normal during an update. An older machine that does not report the service is treated as having no opinion, not as disagreeing, so it can neither trigger a false conflict nor drag the answer back to the old guess.

**Prevents disturbing what already works.** Every existing Claude account keeps its existing folder path, which is checked by a test specifically written to catch a change there.

## What ships when

One change, one pull request. There is no staged rollout and no flag, because the current behaviour is not a feature anyone is relying on — it is a lookup returning the wrong answer. Reverting is a plain revert with nothing to clean up.

## What you actually need to decide

Whether to ship this as a straight bug fix now, given that it changes where a future Codex sign-in is stored on a machine (a new folder, with no existing folder moved or deleted) — yes or no.
