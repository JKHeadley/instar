# Approval-as-Data — the approval ledger (Phase 2), explained simply

## What this is

Until now, when Justin approved something, that approval vanished the moment it
happened. "Approved" — and no memory of it. So the agent could never learn the
pattern of *when Justin agrees with its recommendation as-is* versus *when he changes
it*, and could never get better at recommending the thing he'd have picked anyway.

This change builds the **approval ledger**: every approval becomes a durable, signed
record. Each one is tagged as one of three things:

- **approved-as-is** — Justin took the recommendation exactly.
- **approved-with-change** — Justin approved, but changed something (and we record
  *why* — the single most useful bit).
- **rejected** — Justin said no (also with the why).

From those records, the system computes a simple score per *kind* of decision: out of
all the decisions of this kind, what fraction did Justin take as-is? That fraction (the
"agreement ratio"), plus a "current streak" of consecutive as-is approvals, is the
signal that — much later, and only if Justin opts in — could let a class of low-risk
decisions auto-approve. That auto-approval part is NOT in this change; this is just the
memory + the scoreboard.

## The restaurant analogy

Think of the agent as a sous-chef proposing dishes to the head chef (Justin). Today,
each "yes" or "change the sauce" is said out loud and then forgotten. The ledger is a
notebook where the sous-chef writes down every proposal and what the head chef did with
it — took it as-is, tweaked it (and the tweak), or sent it back. Over weeks, the notebook
reveals: "For pasta dishes he almost always takes my call; for desserts he usually
adjusts the sweetness." That's how the sous-chef learns to propose what the chef would
pick — and which calls the chef trusts him to just make.

## The one rule that keeps it honest

The agent must **never decide for Justin** whether he agreed. Only Justin's *explicit*
words count: "go with your picks" = as-is; "change X because Y" = a change with that
reason. If Justin is silent or vague, nothing is recorded. And Justin can correct any
entry later (a correction is a new signed line, never a quiet edit). This is what stops
the agent from flattering itself by marking everything "approved-as-is."

## What Justin asked for, and what changed mid-build

Justin asked for this, then made one correction while it was being built: the original
written design only tracked *official spec sign-offs*, but most of his approvals (like
picking A/A/B in chat) happen in conversation. So the ledger was generalized to track
approvals **wherever they occur** — a spec, a chat, anywhere — each tagged with where it
happened. Fittingly, that very correction became the ledger's first recorded
"change" entry: the first real data point is the feedback that shaped the feature.

## What's safe about it

It only *reads and records* — it never blocks or changes any behavior. If the agent has
nowhere to store state, the feature simply isn't there (the API politely says
"unavailable") rather than breaking anything. Every record is signed so tampering shows.
