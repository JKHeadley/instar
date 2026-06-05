<!-- bump: minor -->

## What Changed

Added the cutover-readiness checker — the read-only surface that answers "is
everything up to the cutover door green?" from durable server-side state, never from
anyone's claim. It composes the two objective conditions the migration design names:
the persisted import-integrity report and the durable zero-divergence parity window
(now with a freshness bound, so a window that stopped being fed shows as stale instead
of silently counting as ready). The two mandate conditions that previously always
evaluated false now resolve from this real state — they still evaluate false until the
state genuinely clears, so nothing changes behavior today. An agent can trigger a live
parity check, but the server fetches and compares on its own; the request contributes
nothing to the result, and a failed check records nothing. There is deliberately no
route that fires the cutover itself: the flip stays a human action.

## What to Tell Your User

When a migration is gated on safety checks, you can now see at a glance whether
everything up to the final switch is green — data integrity verified and live parity
holding, both read from durable records the agents cannot fake. Your agent can ask the
server to run a fresh comparison, but it cannot vouch for the result or write it in.
And the final switch itself is still yours alone: there is intentionally no way for an
agent to flip it.

## Summary of New Capabilities

- Read the composed cutover-readiness status: data-integrity verdict, live-parity
  window with freshness, and an explicit marker that the final flip is a manual
  operator action.
- Trigger a server-side live parity comparison that records its result into the
  durable window — failed checks record nothing.
- Mandate conditions for gated authorities now resolve from this real durable state
  instead of always refusing, enabling future conditioned delegations to actually
  clear when the evidence does.
- Maturity: stable; inert in behavior until integrity and parity records exist, and
  the first issued mandate carries no conditioned authority.
