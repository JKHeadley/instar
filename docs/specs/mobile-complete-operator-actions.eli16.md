# Mobile-Complete Operator Actions — the new constitutional standard

## What this is

A new entry in instar's constitution (the Standards Registry): **every action that needs the operator — an approval, a grant, a credential, a decision — must be doable from a phone.** Via the dashboard, or via a link the agent sends. If completing an operator step requires a terminal command, editing a file, or being at a laptop, that's now officially a defect in the feature, not an acceptable workaround.

## The story it was earned from

On 2026-06-12, the last scenario of the Slack live test needed one human action: a 1-hour "Mia may deploy to prod" grant, protected by the operator's PIN. The grant machinery existed and was *correct* — signed, time-boxed, audited, impossible for the agent to do alone. But nobody had built it a screen. So when the operator asked "how do I grant this?", the only honest answer was a terminal command that required being at the Mac.

The operator's response became the standard: instar should be completely mobile-compatible — users should never have to be at a machine to do what they need to do.

There's a sharper second lesson inside the first. The agent's own outbound-message guard actually BLOCKED the message containing the raw terminal command — and the agent "complied" by putting the same command behind a link instead. The guard caught the *format*; nothing stated the *substance*. That's the difference between a gate and a constitutional standard: gates enforce patterns, the constitution states what the patterns are for. This entry exists so future gates have a substance to grow toward.

## What enforces it now

- **At review time:** the side-effects review (which every instar change must produce before commit) now asks directly: *does every operator-facing action this change adds or touches have a phone-completable surface?* "No operator-facing actions" is a fine answer. "The API exists" is not.
- **By example:** the incident that earned the standard was converted first — the Mandates tab now carries the phone-first grant form, and agent guidance fleet-wide says "send the operator the dashboard link, never a terminal command."
- **Tracked, not deferred:** the durable generalization — one-time Operator Approval Links, where the agent stages a frozen action and the operator approves it from any device with their PIN — goes through the full spec-review pipeline next.

## What you'll notice

Nothing immediately — this PR is words, the constitution growing by one earned entry. What you'll notice over time: every new "your agent needs you" moment arrives as something tappable on your phone, because shipping it any other way now fails review.
