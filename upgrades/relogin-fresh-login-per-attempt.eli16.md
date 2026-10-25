# Automatic sign-in repair: start each attempt with a fresh link

## What this is, in plain English

When one of an agent's subscription sign-ins (Claude or Codex) expires, Instar can repair it by itself. It starts a new sign-in, opens the account's dedicated browser, approves the sign-in there, and checks that the right account came back. The repair has a small safety budget. If the sign-in link has to be re-issued more than twice during one repair, it stops and gives up, so it can never spin forever.

## What was wrong

The dashboard also keeps a sign-in link for each account that needs one, and it quietly refreshes that link whenever it expires. Each refresh adds one to a counter on the link. When a repair started, it reused that same dashboard link and read its counter as if those were its own retries. One real account's link had been refreshed 17 times, so the repair decided it had already used up its budget and gave up about one second after starting. It never opened the browser. Across the whole fleet, the automatic repair has never completed a single repair on its own. This bug was one reason.

## What changes

When a repair attempt starts, it now retires any leftover sign-in link for that account and creates a brand-new one, whose counter starts at zero. From then on, only refreshes that happen during this attempt count against the budget, which is what the budget was meant to measure.

## What stays the same (the safeguards)

- If someone is in the middle of a manual sign-in (a live, unexpired link), the repair still does not start at all. It won't take the link out from under a person.
- The retry budget, the attempt limit, the ten-minute time limit, the identity check and the wrong-account quarantine are all unchanged.
- The link is replaced only at the very start of an attempt, before anything has been clicked or approved. Nothing that was already done gets thrown away.

## What you need to decide

Nothing. This is a bug fix inside the existing feature, with no new settings. The effect you should see: accounts on the hands-off list that expire now get repaired, instead of showing "gave up" within a second.
