# Remove the "Create a dedicated sign-in profile" form — Plain-English Overview

> The one-line version: the Subscriptions page loses a form nobody used, because the agent already does that job itself.

## The problem in one breath

The Subscriptions page in the dashboard had a box called "Dedicated browser profiles" with a form to "Create a dedicated sign-in profile". Filling it in only made an empty Chrome profile folder and wrote down which Google account it was for. It never actually signed in. Justin never used it, and it made the page look like signing accounts in was his job.

## What already exists

- **The profile registry** — a list on each machine of which Chrome profile belongs to which account. It stays exactly as it is.
- **The provision route** — the server call behind the form. It stays, so anything that calls it directly still works.
- **The sign-in skill and sign-in repair** — the agent creates a profile, signs it in to Google, and repairs Claude and Codex sign-ins by itself. This is what replaced the form in practice.

## What this adds

Nothing new is added. The form, its styling and the code that drew it and sent it are removed from the dashboard. The agent's instructions (its CLAUDE.md and the sign-in skill) no longer point anyone at the form. Instead they say: create the profile yourself through the registry calls, then sign it in with the sign-in skill.

## The safeguards

- The server route and the registry are untouched, and their existing tests still pass.
- Agents that are already installed get the corrected instructions on their next update. The update only swaps out the exact outdated text: one bullet and one table row in CLAUDE.md, and one sentence in the skill. Anything added around that text is kept. If someone reworded the bullet, the update leaves it alone rather than overwrite it, and running it twice changes nothing the second time.
- A new test checks that the page no longer shows the form.

## What you'll notice

The Subscriptions page is a little shorter. Nothing else changes: when an account needs its own browser profile, the agent sets it up and only sends a secure link if a password or approval is truly needed.
