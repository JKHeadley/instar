# Plain-English overview — Tiered-dev awareness + migration parity (Steps C + D)

> The one-line version: the agent that develops instar now finally *knows about* the
> tier system that was built earlier — and we've checked, in writing, that this change
> doesn't need to reach any deployed bot.

## The problem in one breath

A few steps back we taught the "am I allowed to commit?" gate to size up each change and
suggest a **tier** — Tier 1 for small/low-risk changes (lighter process), Tier 2+ for big
or risky ones (full process). That machinery is live. But nothing the developing agent
*reads* mentions it. So the agent could be staring at a tier signal in its own commit gate
and have no idea what it means or that it's allowed to pick the light path. This step writes
the missing instructions.

## What already exists (built in the earlier steps)

- **The tier classifier** — a small bit of code that looks at how many lines and files a
  change touches, plus whether it brushes anything dangerous (secrets, the relay, migrations,
  new capabilities), and *suggests* a tier. It only ever *suggests* — it never decides.
- **The commit gate** — already prints that suggestion, already lets the agent *declare* its
  own tier in a trace file, already enforces the right amount of process for whatever tier
  was declared, and already writes every decision to an audit log. If the agent picks a
  lower tier than the risk signal suggested, the gate prints a loud notice and records it —
  but doesn't block, because the agent (the "mind") holds final authority.

## What this step adds

Two pieces of writing, nothing else — no new code, no behavior change:

1. **A short section in the `/instar-dev` skill** (the developing agent's own playbook)
   that explains: the gate prints a tier *signal*, *you* declare the tier, Tier 1 needs only
   a plain-English overview plus a side-effects review (no pre-approved spec), Tier 2+ needs
   the full spec, clean Tier-1 changes auto-merge on green tests, and every choice is
   audited. It links to the deeper principle.
2. **A new entry in the constitution** ("Tiered Development") saying the rule plainly:
   process should scale with a change's size *and* risk; the structure *informs* the tier,
   the agent *decides*, and the decision is *recorded*. It's written as flowing directly
   from a deeper principle already in the constitution called **The Body and the Mind** —
   the idea that structure should inform the agent's judgment, never replace it.

## The decision the reader actually has to make

This is documentation-only, and the one judgment baked in is: **the tier system is
developer tooling, not something a customer's bot ever uses.** So the awareness belongs in
the developer's skill and the constitution — *not* in the template that every new bot
inherits. We confirmed that against the code: the developer-only skills aren't shipped to
bots, and the bot template doesn't mention the tier system today and isn't touched here. The
practical upshot: **no migration is needed** — nothing has to be pushed out to already-running
bots, because nothing they run changed. The reviewer just needs to agree that the judgment
("dev tooling, not an end-agent capability") is right and that the wording is clear.
