# Periodic Goal Re-Alignment — plain-English overview

Long autonomous sessions can slowly lose the plot. Every individual task may look
reasonable, yet after hours the pile of tasks can point somewhere different from
what the user actually asked for. This feature gives long-running work a regular
"zoom out and check the map" moment.

The map is not the agent's own summary of itself. It comes from messages whose sender
identity the chat service authenticated as the topic's operator. The system keeps
short source quotes and message references so it can show where each priority came
from. Forwarded messages, messages with missing sender proof, and incomplete history
are not quietly treated as user instructions. The messages and the run's task file
are also wrapped as untrusted data before an AI reviewer sees them, so pasted or
quoted instructions cannot simply take over the review.

The review distinguishes four outcomes. "Aligned" means the current plan advances
the active goals. "Drifting" means a priority is being underweighted or the current
work is merely unrelated. "Diverged" is deliberately harder: the current plan must
actually contradict or abandon a still-active priority, and the result must quote
evidence from both the user's message and the run's own plan. If history is
incomplete, evidence conflicts, a provider fails, or the citations do not check out,
the answer is "indeterminate" and nothing is injected.

The hourly timer is only a wake-up, not an hourly AI bill. If neither the source
goals nor the run's meaningful focus changed, the system reuses the prior result:
zero new model calls and zero repeated nudges. When something did change, the work
runs through the shared background queue with its own durable request and cost
limits, retry backoff, and circuit breaker. The normal reflector routing prefers an
available non-Claude provider. If none is available, the feature stays quiet unless
the operator explicitly chose Claude for it.

A new session receives the latest fresh brief from cache, without waiting for an AI
call. Delivery uses a stable receipt number so frameworks with idempotent injection
can suppress duplicates. Where a framework cannot know whether a crash happened
before or after insertion, the contract is honest: it may retry once, so at most one
duplicate is possible rather than making a false exactly-once claim. An
already-running session receives a semantically changed drift/divergence brief only
at a proven safe idle boundary, through an internal system channel that cannot be
mistaken for a user message. The feature never edits the task file, never blocks
work, and never tells the operator that the model thinks the agent is drifting. The
session records whether it adopted, disagreed with, already addressed, or could not
assess the brief, so the system can tell whether the full-context agent processed the
signal without forcing a model judgment to become authority.
Operator alerts were deliberately removed from this first version because a semantic
disagreement is not precise enough to spend the user's attention. The redacted
status page and audit trail remain available for inspection.

On a multi-machine agent, the machine with the authenticated chat history performs
the verified source read, while the current topic owner performs the comparison and
delivery. State and deduplication follow the topic, so moving work to another machine
does not reset budgets or let an old owner speak after the move. Only random opaque
generation IDs, delivery receipts, budget counters, and verdict metadata are replicated; quotes,
reasons, and brief bodies are not copied to every machine. That metadata is
protected in transit and stored in plaintext on each pool machine, while the
quote-bearing local cache is permission-restricted and deleted when the run ends or
the principal changes. When cached quote bodies expire during an unchanged run, a
content-free recipe re-fetches and re-validates the cited rows to rebuild a generic
brief without another AI call; missing or changed evidence produces no context.

The feature ships dark and then dry-run only. Before it can inject live, it must pass
a labeled review battery, a week-long dev-agent soak, restart and continuation tests,
a real topic transfer, all-framework session-start parity, strict citation accuracy,
and a high precision bar for the risky "diverged" label. This is a review-and-signal
system, not an automated steering wheel.
