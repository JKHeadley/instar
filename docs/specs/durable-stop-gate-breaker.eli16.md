# Durable Stop-Gate Breaker — ELI16

## What is happening today

Instar asks a small language-model judge whether an agent is ending a turn for a
good reason or merely stopping because the conversation is long. That judge has
a strict two-second deadline because it sits directly on the turn-ending path.
When the judge is too slow, Instar does the safe thing: it lets the turn end and
records a degradation. That fail-open choice is intentional and stays unchanged.

The recurring bug is in the brake around that slow judge. After several timeouts,
Instar opens a circuit breaker and stops launching calls that are already known
to miss the deadline. But the breaker lives only in memory. Every software update
restarts the server and erases what it learned, even though the slow provider is
still slow. The fresh process spends the same retry budget, produces the same
feedback, and relearns the same fact. The live agent has accumulated 179 timeout
records across many releases, including today.

## What changes

The breaker will keep its small amount of state—failure count and cooldown
deadline—in the Stop Gate's existing local SQLite database. On restart, the new
process reloads that state. If the cooldown is still active, it immediately takes
the existing fail-open path without launching another doomed model process. When
the cooldown ends, one real probe is allowed. Success clears the saved breaker;
failure reopens it. No messages, prompts, user text, or credentials are stored.

This also closes the broader engineering gap. Our standard already says repeating
actions need backoff, a breaker, and a cap, but our structural test only checked
one process lifetime. The upgraded standard says a routine restart cannot mint a
fresh retry budget while the same pressure continues. The shared convergence test
will now rebuild restart-sensitive controllers in the middle of sustained failure
and require the same action bound to hold. That makes this a class repair, not a
special-case silence switch.

## Safety and tradeoffs

The language model remains the only authority that decides whether a stop is
justified. The persisted breaker decides only whether an expensive probe is
currently admissible. It never invents a stop/continue verdict. When open, the
system behaves exactly as it does on any authority failure: allow the turn to end.

Breaker state is local to each machine on purpose because model availability and
CLI credentials are physically local. A slow provider on one computer must not
disable a healthy provider on another. The database change is additive and older
versions safely ignore it, so rollback is just reverting the code. Corrupt dates
are clamped so they cannot suppress probes forever, and database-write failures
fall back to the current in-memory brake rather than breaking the Stop path.
The authenticated reset action is explicitly classified as a machine-local
write because it changes only this computer's physical-provider breaker.

## What approval means

Approval means accepting three linked changes: persist this breaker across normal
server restarts, keep the existing fail-open behavior and truthful first-failure
telemetry, and strengthen the shared loop-safety standard/test so restart-reset
brakes cannot pass as convergent in future features.
