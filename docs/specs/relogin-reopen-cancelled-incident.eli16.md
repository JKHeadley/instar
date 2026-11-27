# Sign-in repair: don't lose track of an account that is still signed out

## What this is about

When an account gets signed out on a machine, Instar writes down an "incident": a record saying this account's login failed here. The automatic sign-in repair can only start from an open incident. That keeps it from repairing accounts on a guess.

Every few minutes, Instar re-checks which accounts on the machine it is tracking. If an account briefly drops off that list, its open incident is closed as "cancelled". When the account comes back on the next check, nobody reopens the incident. A new incident is only ever opened when an account changes from signed in to signed out, and an account that is still signed out does not change. So it stays signed out with no incident, and the repair can never start again.

That is what happened to the gearfinity3d account on the Mac Mini on the evening of November 25. Its incident was closed as cancelled while the account stayed signed out, and its next automatic repair try was dropped. The Laptop shows the same problem for the same account.

## What changes

When an account comes back onto the tracked list and is still marked signed out, Instar looks at its most recent incident. If that incident was closed only as "cancelled", Instar reopens it exactly as it was, with the same evidence that opened it in the first place. It then writes a "reopened" note, so every case can be seen later.

## Why this is safe

- An incident that was closed because the account recovered ("resolved") is never reopened.
- Nothing new is invented. The reopened incident keeps its original, real evidence, and the repair still runs all its normal checks before doing anything.
- Reopening does not start a repair by itself. The usual slow retry then runs: at most three tries, hours apart, and never after a phone or CAPTCHA challenge.

## What a reader needs to decide

Nothing. There is no new setting, route or permission. If it ever proved wrong, reverting the change restores the old behaviour, and any reopened incident simply stays open until the account is seen signed in.
