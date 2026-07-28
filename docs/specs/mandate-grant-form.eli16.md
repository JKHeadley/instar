# Granting someone a floor action from your phone — the Mandates-tab grant form

## What you saw

During the Slack live test, the last scenario needed one thing from the operator: a 1-hour "Mia may deploy to prod" grant. The secure machinery for that grant existed — but the only way to use it was a hand-built terminal command, run at a laptop. The operator's verdict was the right one: instar must be completely mobile-compatible. A user should never have to be at a machine to do what they need to do.

## Why it happened

The grant API shipped PIN-gated and signed — the security model was right — but nobody built it a screen. The dashboard's Mandates tab could issue agent-to-agent permission slips and revoke them, and that was it. When the moment came, the agent did the only honest thing available: generated a copy-paste command. Secure, correct, and a design failure.

## The fix

Every **active** mandate card on the Mandates tab now carries a "Grant a user a floor action" form, built phone-first:

- **Pick the person** — a dropdown of registered users by name and role (fed by a new read-only endpoint). You never type a Slack ID. (A free-text field appears only if no users are registered yet.)
- **Pick the action** — a dropdown of the six floor actions (prod deploy, money movement, credential access, destructive data, external send, grant authority). The list is test-pinned to the real enforcement enum so it can never silently drift.
- **Pick the duration** — 15 minutes / 1 hour / 4 hours / 24 hours. No timestamps to type. If your pick would outlive the mandate itself, it's quietly shortened to the mandate's expiry (a grant can never outlive the mandate that carries it) and the confirmation tells you so.
- **Type your PIN, tap Grant.** The PIN is the only thing you type. It's sent once and never stored — same discipline as issuing and revoking.

The card also now lists the grants a mandate already carries, in plain language ("Mia Member may prod-deploy until 2:30 PM — authorized by operator"), with expired ones marked.

## What didn't change

The security model is untouched. The grant still rides the signed mandate (revoking the mandate voids it), the server still enforces the expiry clamp and rejects a Bearer-only request, and every accepted or refused grant still lands in the hash-chained audit. This change is purely the missing screen.

## How agents learn about it

Agent guidance (the CLAUDE.md template + an in-place migration for existing agents) now says: when the operator needs to grant a user a floor action, send them the dashboard link — never a terminal command. That's the behavioral half of the Mobile-Complete Operator Actions lesson this came from.

## What you'll notice

Next time a grant is needed: open the dashboard on your phone, Mandates tab, pick-pick-pick, PIN, Grant. Done from anywhere.
