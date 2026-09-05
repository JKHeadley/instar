# Teaching instar about `gpt-6-astra` — Plain-English Overview

> The one-line version: instar refused to pin a conversation to a codex model it could
> already run, because its list of known models was out of date — and that list existed in
> two places kept in sync by a comment, so this PR adds the model and deletes the duplicate.

## The problem in one breath

An operator asked for a conversation to run on codex's `gpt-6-astra`. The agent's own
machine was, at that same moment, running seven sessions on that exact model — and instar
still refused the request with "not a known codex model id." The capability was there; the
configuration path to reach it was not. That is the worst kind of gap, because from the
outside it looks like the feature doesn't exist.

## What already exists

- **A closed list of model ids per framework** — instar keeps an explicit list of which
  model names each CLI accepts. Anything not on the list is refused. That is deliberate: a
  typo in a model name would otherwise launch a session that dies at startup, and the
  operator would have no idea why.
- **Two places that consult it** — the part that validates "pin this conversation to model
  X", and the part that validates "spawn a session on model X".
- **A fallback for stale pins** — if a pinned model stops being available, the session
  quietly runs on the default and says so once, rather than breaking.

## What this adds

`gpt-6-astra` joins the codex list, so a conversation can now be pinned to it. That is the
whole user-visible change: one model name, verified working before it was added.

The more durable half is what got deleted. The spawn side did not read the shared list — it
carried its own hand-typed copy, with a comment saying "keep in lockstep." Nothing enforced
that. So a model added to one and forgotten in the other would produce a split where a
session could be *launched* on a model that could not be *pinned* to — which is almost
exactly the confusing state this bug presented as. The copy is gone; codex now reads the
same shared list every other framework already reads.

## The new pieces

There are no new pieces, and that is the point. Nothing new was built, no new check was
added, and no new component now has a say in anything. One entry was added to a list, one
redundant branch was removed, and two tests were added to hold both facts in place.

## The safeguards

**Prevents the list from silently splitting again.** A test asserts that the two consumers
resolve to the same list object. That test was checked by deliberately re-splitting them —
it fails when they diverge, so it is genuinely watching the thing it claims to watch, not
passing for unrelated reasons.

**Prevents guessed model names from getting in.** Only ids that were actually run and
observed working are added. A plausible-looking sibling name that was never verified is
still refused, and there is now a test asserting that refusal — so the list cannot quietly
drift from "verified" to "seemed likely."

**Prevents a widened list from loosening anything else.** The change only ever grows the
accepted set, by one entry. Unknown model names still fail closed exactly as before; the
check's logic was not touched at all, only the data it reads.

## What ships when

One PR, one change. There is no rollout ladder, no dark flag, and no staged enablement —
adding a known-good value to a validation list has nothing to gate. If it turns out wrong,
the back-out is reverting the commit; the only consequence is that a conversation pinned to
the model falls back to the default and says so once.

## What you actually need to decide

Are you satisfied that `gpt-6-astra` was verified working before being added — and that
collapsing the duplicated spawn list into the shared one is the right call rather than
keeping both and testing that they match?
