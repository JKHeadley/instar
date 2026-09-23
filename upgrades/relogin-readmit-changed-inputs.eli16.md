# Automatic sign-in repair: try again when the setup changes

## What this is, in plain English

When a subscription sign-in expires, Instar opens a "repair" for that account. Depending on the settings, the repair either waits for a one-tap approval or runs by itself. The system records exactly what the repair was allowed to do: which account, which browser profile, and whether it may run hands-off. An approval is only valid for that exact recorded setup. That's a good safety rule, because an approval for one setup can never be reused for a different one.

## What was wrong

Each expired sign-in got exactly one repair record, forever. If the setup changed afterwards — someone added the missing browser profile, or put the account on the hands-off list — the old record no longer matched. It could not be approved, retried or replaced. A cancelled or failed repair was also permanent. So an account that failed once stayed broken until a person signed it in by hand. This happened to two real accounts this week.

## What changes

When the system sees that an account's repair setup has changed, it refreshes that account's repair record to the new setup and starts over from "waiting to begin." If the account is on the hands-off list, the repair then runs by itself. Otherwise it asks for the one-tap approval again.

## What stays the same (the safeguards)

- If nothing about the setup changed, a cancelled repair stays cancelled, and a failed one waits for someone to press "try again." A deliberate stop is still respected.
- A repair that was refused for a safety reason, such as the wrong account showing up, is never restarted this way.
- It never starts a second repair on an account that already has one running.
- All the existing limits still apply: the attempt limit, the time limit, and the circuit breaker that stops repairs after repeated failures.

## What you need to decide

Nothing. This is a bug fix inside the existing feature, with no new settings.
