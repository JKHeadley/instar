# Empty decision-quality ratios are now honest

The decision-quality route publishes several ratios for each decision point:
how many decisions have an outcome row, what share of those outcomes are still
unknown, and what share of settled grades came from self-report.

Each ratio needs a different denominator. Previously, an empty point returned
zero for all three. Those zeros read like real measurements: complete outcome
coverage, no unknown results, and no self-reported evidence. The surrounding
object did say evidence was insufficient, but consumers could still quote the
individual ideal-looking fields.

The route now returns `null` when the relevant denominator is zero. It still
publishes decisions, outcome rows, settled grades, and the insufficiency flag,
so the reason is visible. A populated point with a genuinely measured zero
still returns zero.

The integration test calls the real HTTP route with an empty ledger and checks
all denominators and ratios together. Reintroducing the old fallbacks makes the
test fail.
