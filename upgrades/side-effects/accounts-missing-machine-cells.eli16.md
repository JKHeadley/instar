# The Accounts page shows when a machine is missing an account (plain-English overview)

## What this change is

The agent can run on several computers at once, and each computer keeps its own copy of the subscription accounts (the Claude and Codex logins) it is allowed to use. The dashboard's Accounts page lists each account and a little chip for every computer that has it.

The problem: if a computer was switched off, or rebuilt from scratch, when an account was added on the others, it simply never got that account, and the Accounts page didn't show that at all. A chip only appeared for computers that already had the account, so a missing one was invisible, and there was no button on that page to fix it. This happened for real on 20 November 2026: after the Mac Studio was rebuilt it was missing four accounts, and nothing on the page said so.

## What already exists

- The server already returns every account on every computer that answers, in one combined list.
- The server already has a protected way to start a fresh sign-in for one account on one computer. It asks for the dashboard PIN, so only the owner can start it. The older "Subscriptions" tab used it for its "Set up" button.

## What's new

- For every computer that answered, but doesn't have a given account, the page now shows a dotted chip with a "+" in front of the computer's name.
- Opening the account shows that computer as "not on this machine", with a quiet **Set up** button. Tapping it asks for the PIN and starts the sign-in on that computer, exactly like the older tab did.
- If a sign-in for that computer is already running, it shows "signing in" instead.

## The safeguards, in plain terms

- A missing account is **not** treated as a problem that needs the owner. Not every account is meant to be on every computer (for example, OpenAI limits how many paid Codex accounts one computer may hold). So the headline, the "needs you" list, the ready count and the warnings all ignore missing chips.
- A computer that didn't answer is shown as "couldn't check", never as "missing". We don't know what it has, so we don't claim anything.
- The Set up button uses the existing PIN-protected route without changing it, so nothing new can start a sign-in without the owner's PIN.

## What you need to decide

Nothing. It is a display fix that a revert fully undoes. It changes no settings, stores nothing and adds no new authority. If a missing chip ever turns out to be noise for an account that is kept off a computer on purpose, the follow-up would be a "kept off here on purpose" mark. For now the chip is deliberately quiet.
