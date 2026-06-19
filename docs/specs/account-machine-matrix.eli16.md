# Plain-English overview — a grid for "which account is signed in on which machine"

## What this is

When you run the agent on more than one machine, each machine has to sign in to your subscription accounts separately (that's the ToS-safe way — nothing is copied between machines; each machine logs itself in). Until now there was no good way to do that on demand: the dashboard only ever offered to add an account when its load-balancing logic happened to think it'd help, so when you just wanted to put your other accounts on the Mac Mini, there was no button — and I fell back to DMing you a sign-in link and having you paste the code back in chat. That's clumsy and off-dashboard, which is exactly what we're trying to avoid.

This builds the grid you described: on the Subscriptions tab, a table with your accounts down the side and your machines across the top. Every cell is either a check mark (that account is signed in and active on that machine) or a "Set up" button (it isn't yet). At a glance you can see who's active where.

## How a cell works

Tap "Set up" on a cell and the whole sign-in happens in the dashboard: the target machine starts its own fresh login, the auth page opens, and the cell turns into a little "paste your code here" box. You authorize, the page gives you a code, you paste it into the cell and tap Submit. The code travels straight to the machine doing the login (never through chat), finishes the sign-in, and the cell flips to a check mark.

## What already exists vs. what's new

Most of the machinery already shipped. The "which account is on which machine" data comes from a view we already have. The code-paste-and-finish half is the exact feature I shipped earlier today (the off-chat code paste-back), reused unchanged — including its safety check that the machine actually logged into the *right* account (it compares the signed-in email against the account you picked, and refuses if they don't match). The only genuinely new piece is one small "start the sign-in for this cell" action behind each button, plus the grid itself.

## Safety

- The code never goes through chat — it rides the same secure dashboard connection as everything else.
- Nothing is copied between machines; each machine signs itself in.
- A cell only turns into a check mark if the machine logged into the account you actually picked (the email is validated); a mismatch is held and flagged, not silently accepted.
- An offline machine shows as offline — its buttons are disabled, never a fake check mark.

## What you need to decide

Nothing structural — this is the design you proposed, built on plumbing that already shipped and was verified. The only judgment call (made here) is that you clicking "Set up" in your signed-in dashboard is the authorization (you acting directly on your own accounts), rather than the heavier agent-to-agent permission system, which is for autonomous work, not you managing your own logins.
