# Fable 5 quota usage on the Subscriptions dashboard — Plain-English Overview

> The one-line version: show a "Fable 5" usage bar per account on the Subscriptions dashboard, reading a number the Anthropic usage API already gives us.

## The problem in one breath

Fable 5 has its own weekly usage allowance that is separate from an account's normal limits. The dashboard showed the normal limits (a 5-hour bar and a weekly bar) but never showed Fable 5 — so the only way to know if a Fable 5 pool was maxed out was to try a call and hit the wall.

## What already exists

- **The Subscriptions dashboard tab** — shows each account with a 5-hour usage bar and a weekly usage bar, each with a reset countdown. It reads the account's latest quota snapshot.
- **The quota poller** — periodically calls Anthropic's usage endpoint for each account and turns the raw response into a small snapshot object (`fiveHour`, `sevenDay`, and a per-model map for Opus/Sonnet).
- **The multi-machine replication layer** — when the agent runs on more than one machine, each machine's account-usage snapshots are shared with the others through a strict validator that only lets through a known set of fields (anything unknown makes it reject the whole snapshot, on purpose, for safety).

## What this adds

A third bar — **Fable 5** — under the existing two, per account, with its own reset countdown. It only appears when there's a Fable reading to show.

The key discovery: Anthropic's usage response *already* contains Fable 5's weekly usage. It isn't a tidy top-level field like the others; it lives inside a `limits` list as the entry scoped to the model whose display name is "Fable", carrying a percent-used and a reset time. We parse that entry into the same little `{percent, resetsAt}` shape the other bars use, so the dashboard can draw it with the exact same bar component.

## The new pieces

- **A `fable` window on the quota snapshot** — parsed from the usage response's `limits` list. Same shape as the 5-hour and weekly windows, so nothing downstream needs special handling.
- **One new dashboard bar** — drawn only when a Fable reading exists; otherwise nothing changes.

## The safeguards

- **It's read-only.** This is a display of a number, nothing more. It does not gate, block, filter, or decide anything. It is deliberately NOT wired into the model-escalation or scheduling decisions (those keep using the overall limits only) — feeding Fable into a *decision* would be a different, riskier change.
- **Multi-machine safety.** The strict cross-machine validator would have rejected any peer's whole snapshot the moment it carried the new `fable` field. We taught it to accept and shape-check `fable` (a real number and a real date, nothing else), so a peer's Fable usage survives sharing instead of nuking that peer's quota on the receiver.
- **Conservative parsing.** We only treat an entry as Fable when it's a weekly-scoped limit whose model display name is exactly "Fable" and it actually has a percent — so an Opus-scoped or malformed entry is never mistaken for Fable.
- **Graceful absence.** No Fable reading (freshly-set-up account, unread quota, sparse response) simply means the bar doesn't render — same as the existing bars.

## What the reader needs to decide

Nothing risky. This is an additive, read-only dashboard bar backed by data the API already returns, covered by unit tests on the parser, the renderer, and the replication validator, and live-verified across all four real accounts. The only judgment call already made: keep Fable display-only for now rather than letting it influence which account the agent routes work to. If that turns out wrong, the back-out is reverting four small hunks.
