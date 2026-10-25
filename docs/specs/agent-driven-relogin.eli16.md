# Agent-driven sign-in repair — the plain-English version

## What this is

When one of your agent's Claude or Codex sign-ins expires, Instar can repair it by itself: it notices the expiry, checks the repair is allowed, opens that account's own Chrome, signs back in, and then checks that the right account came back. The part that clicks through the sign-in pages has been a fixed script. It sorts every page into a known type and only knows one move per type, so the moment a provider shows a page nobody predicted, it can only wait and give up. It had never completed a repair.

## What changes

Instead of the script choosing the next move, a model reads the page and chooses. It is shown the page's visible buttons and links and a short instruction ("sign this account in"), and it answers with one of the moves on offer: click this button, fill the password box, wait, or give up. That is the whole change. It runs inside Instar; it is not a separate agent session with tools.

## What stays locked, no matter what the model says

- It can only ever be on the real Claude, OpenAI or Google sign-in sites.
- Any button that names a different account is never offered, and the account is checked again after sign-in.
- The model never sees a password, a code or another person's email. Instar types the password itself.
- It cannot approve more permissions than the ones you allowed.
- Buttons like "sign out", "delete", "change password" or "manage account" are never offered.
- Only one repair runs at a time, and each has a hard time limit.
- CAPTCHAs, phone prompts and bot-check pages are still handled by fixed rules and handed to you when they need you.

Success is never the model's word: Instar checks the signed-in account itself and makes a real authenticated call.

## Where it runs

Only on your development agent (my three machines) at first. Every other agent keeps the old script until this has repaired real expiries.

## What you need to decide

Nothing further: you approved this small version on 2026-09-24. Everything from the long overnight design that is not listed here was deliberately left out, and can be added later only if real repairs show it is needed.
