<!-- bump: minor -->

## What Changed

Implemented the Coordination Mandate enforcement engine (the design the operator
signed off as A/A/B): a deny-by-default authority gate for autonomous agent-to-agent
actions. The operator writes one bounded, expiring, revocable "permission slip"
delegating specific authorities to a specific pair of agents; the slip — not the agent
— is what authorizes each action, preserving the rule that the one asking is never the
one authorizing. Issuance and revocation require the operator's dashboard PIN, so an
agent's API access alone is structurally unable to create or widen a mandate. A signed
store verifies authorship on every check (a forged or edited mandate fails), risky
authorities can be tied to objective real-state conditions the agent cannot fake, and
every decision — allowed and denied alike — lands in a tamper-evident, hash-chained
audit log. With no mandate issued, the gate denies everything, so this ships inert and
changes no behavior until the operator issues the first mandate.

## What to Tell Your User

You can now hand your agent a bounded permission slip instead of approving every step
of a multi-agent project. You write the slip once from your dashboard with your PIN:
exactly which actions are allowed, within which limits, for which two agents, until
when. Your agent can act inside those lines without pinging you, and nothing outside
them — and you can tear the slip up at any moment. Everything done under a slip is
written to a tamper-evident log you can review. Until you issue a slip, nothing changes
at all: the system refuses every delegated action by default.

## Summary of New Capabilities

- Issue or revoke a coordination mandate from the dashboard surface with your PIN —
  agent credentials alone cannot do either.
- Agents check intended agent-to-agent actions against the mandate and get an
  allow-or-deny answer with the reason; denials are the default with no mandate.
- Review every mandate decision in a chained, tamper-evident audit trail, including
  whether each entry's chain verifies.
- Maturity: stable for the gate, store, and audit; conditioned authorities (objective
  real-state gates for riskier actions) ship deny-safe and unused by the first mandate.
