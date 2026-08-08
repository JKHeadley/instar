# BRIEF 2 — Building: how is a feature authoritatively identified as user-facing?

**Take-or-decline. Self-contained. Produces a proposal document, never a registry edit.**

## The finding, verbatim

> **GAPS — Yes.** The family clearly implies a mandatory, authoritative mechanism for identifying
> user-facing features, but none is stated. **The admitted declaration loophole means the live-test
> obligation can be avoided simply by not declaring the feature user-facing.**

## Why this one is sharp

*Live-User-Channel Proof Before Done* says a user-facing feature is not done until a user-role session
has driven it through its real surface. The gate is real (`src/core/LiveTestGate.ts`) and it vetoes.

**But its hard veto fires only when a feature is DECLARED user-facing.** An undeclared feature that the
classifier merely suspects gets a soft nudge, not a refusal. So the obligation is escapable by
omission — not by arguing, not by overriding, just by not saying.

That is not a hypothetical: the standard was earned from a multi-machine transfer that reported
`ok:true` and never moved the seat, found by the operator on first live use. **A feature nobody
declares is exactly the feature that reaches the operator untested.**

## The question to answer

**What makes a feature user-facing — and who or what decides, given that self-declaration is the
loophole?**

Constraints that make this genuinely hard, and which a good draft will confront rather than dodge:

- **A keyword classifier is forbidden here.** *Intelligence Infers, Keywords Only Guard* bans a
  keyword list deciding open-domain meaning. "Does this feature touch a user surface?" is such a
  judgment. A proposal whose answer is a word list will be refused by the constitution it is joining.
- **Fail-open vs fail-closed is a real trade.** Treating everything as user-facing until declared
  otherwise inverts the loophole into a tax on every internal change. Say which direction you choose
  and what it costs.
- **Structural signals may exist that are not judgments at all** — a new route, a dashboard tab, a
  message-sending path, a config key the operator sets. Enumerable surfaces are `invariant`-shaped
  and do not need a model. Whether they COVER the space is the open question.

## Deliverable

`docs/proposals/standard-proposal-user-facing-identification.md`: the obligation; the identification
mechanism and its failure direction; what it MEASURES vs CERTIFIES; at least one feature that would
slip through your proposal (there will be one — name it); and whether this amends
*Live-User-Channel Proof* or stands as its own article.
