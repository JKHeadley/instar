# Choosing which AI account a new agent uses (ELI16)

## What was wrong

When you create an agent, you pick Claude or ChatGPT. Many people are already signed in to one or more of those accounts on their Mac: a personal one, a work one, or ones their other agents use. The installer never asked which one: it quietly used whatever account sat in the usual place. Justin hit this while testing on 17 November and asked for a choice.

## What changed

After you pick the AI, setup looks for accounts of that kind already signed in on this Mac. It shows each by its email (and its plan for ChatGPT), including accounts your other agents use, and adds one more choice: sign in to a different account.

- **An existing account** is shared with the new agent, the way agents on one Mac already share the usual account. The screen says plainly that the agents then share that account's usage limit.
- **A new account** gets its own folder, so its sign-in is separate.
- **The chosen account** is added to the new agent's list of accounts only after Instar confirms who it belongs to, from that account's own sign-in.

Setup reads only who each account belongs to. It never reads a password or a key.

If you use an older Instar app that doesn't know this question yet, setup behaves exactly as before.

## Evidence

63 unit tests, covering finding accounts (including ones on another machine being skipped and duplicate emails shown once), every answer, a stale pick, the older-app fallback, the next-free folder, sign-in pointed at the right folder, and adding the account once.
