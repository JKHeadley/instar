# Why one engine's "rate limit" shouldn't freeze the others — explained simply

## The short version
Instar can run its background AI checks on different engines (Claude, Codex,
Gemini, Pi). Each engine has its own "trip switch" (a circuit breaker) that flips
when that engine gets rate-limited, so Instar stops hammering an engine that's
already saying "too many requests." This change adds a test proving one engine's
trip switch flipping does NOT freeze the other engines, and fixes a confusing log
message that made it LOOK like it froze everything.

## What was confusing
When the Claude engine got rate-limited, the log printed: "pausing ALL LLM-backed
work." Reading that, you'd reasonably think every engine just got frozen. During a
real incident, that exact wording sent us down the wrong path — we thought one
engine's trouble was freezing all of them.

The truth: each engine's trip switch only affects THAT engine. Claude getting
rate-limited only pauses Claude calls. Pi and Gemini keep working on their own
switches. The "froze everything" feeling in the incident actually came from a
different thing — the message checker kept FALLING BACK to the rate-limited Claude
engine — which was fixed separately.

## What this change does
1. **A new automated test** sets up a Claude engine that's rate-limited (its switch
   flipped) and proves: a check sent to Pi still goes through fine; a check sent to
   Claude correctly gets turned away; Pi keeps working call after call. So the
   "one engine's trouble stays contained" promise is now locked in by a test that
   would fail if anyone ever broke it.
2. **The log message is reworded** to say "pausing further calls on THIS engine …
   other engines have their own switches" — accurate, and it won't mislead the next
   person (or the next me) during an incident.

## What changes for you
Nothing about how the system behaves — engines were already isolated. This just
proves it with a test and makes the log honest about what it means. No settings to
change, no new features to learn.

## Why it matters
A misleading log line cost real time during an outage. Clear, accurate signals are
part of being able to reach and trust the system. And a regression test means the
isolation guarantee can't silently rot — if someone ever wires the engines together
by accident, the test catches it before it ships.
