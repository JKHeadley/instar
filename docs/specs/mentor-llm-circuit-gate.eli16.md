# Mentor LLM rate-limit gate — explained simply

## The everyday version

The agent runs a "mentor" routine that periodically studies a mentee agent and writes up findings —
and that study uses the AI model (it runs an `claude -p` analysis). Separately, there's a safety
breaker: when the AI provider says "you're going too fast, slow down" (rate-limited), a circuit
flips OPEN and pauses ALL AI work for about 15 minutes to let things cool off.

The bug: the mentor routine checked whether it had spent too much money before running — but it did
NOT check whether the AI was currently rate-limited. So while the provider was throttled (breaker
open), the mentor would still fire off its AI analysis, which immediately failed... and that failure
re-tripped the breaker, restarting the 15-minute pause. It was the agent tripping itself, over and
over.

## What we changed

The mentor now also checks the breaker before it runs. If the AI is currently rate-limited (breaker
open), the mentor simply skips this round and tries again later when things have recovered — instead
of throwing a doomed request at a throttled provider and re-tripping the pause for everything else.

## Why it's safe

When the provider is rate-limited, the mentor's AI work would just fail anyway — so skipping is
strictly better: no wasted request, and it stops the self-inflicted re-tripping that was pausing all
the agent's other AI-backed monitors. The mentor's analysis isn't time-sensitive; a skipped round is
picked up on the next one. The check is read-only (it just peeks at the breaker's state; it doesn't
consume the one "probe" slot the breaker allows while recovering). And the order of the gates is
preserved — the money/budget check still comes first. We added tests proving the mentor skips with a
clear "llm-rate-limited" reason and never even starts its AI work when the breaker is open.
