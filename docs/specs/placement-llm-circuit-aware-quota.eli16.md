# ELI16 — Quota-aware placement must see the open LLM circuit

**Parent principle:** No Silent Degradation to a Brittle Fallback — a machine that cannot actually serve LLM work must report itself blocked, not present a healthy-looking signal that misroutes work onto it.

## The problem in plain words

When I run on more than one machine, I decide which machine should serve a new conversation. I'm supposed to skip any machine whose AI account is rate-limited. To do that I read each machine's "quota state" — a little health flag it broadcasts.

The bug: that flag is computed ONLY from the account's usage poll (how much of the 5-hour window is used). It ignores a second, more direct signal — the "circuit breaker" that trips when the machine's actual AI calls start failing with rate-limit errors. So a machine can have its circuit OPEN (its calls are failing right now, it literally cannot answer) while still broadcasting "quota: not blocked."

I caught this live: a real Slack message routed to my Mac Mini because my laptop is over-subscribed. The Mini's flag said "not blocked," but its circuit was open — so the session I handed it died instantly and the user got a "session stopped" notice instead of an answer. Placement sent work to a machine that couldn't do it — the exact thing this feature exists to prevent.

## The fix

Make the health flag tell the truth: if a machine's AI circuit is open (or still probing recovery), mark it "blocked" for placement, no matter what the slower usage poll says. The circuit reflects what's actually happening to real calls, which is what matters for "can this machine answer right now."

I pulled the flag's logic out of the giant server file into a tiny, separately-testable function, so this two-signal rule (usage poll OR circuit) can't silently slip back to usage-only later. A disabled circuit breaker reports "available," so this never false-alarms.

## What changes for you

If one of your machines is rate-limited, I now route new conversations to a machine that can actually answer, instead of sending them into a dead end. The only case where nothing improves is when ALL your machines are rate-limited at once — then there's genuinely nowhere good to send it, and I say so honestly rather than pretending. The behavior is governed by the existing circuit-breaker config; there's no new knob to learn.

## How I'll know it's fixed

A machine with an open circuit now shows up in the machine list as "blocked — llm-circuit-open," and a new conversation lands on a machine that can serve it (a real reply comes back) instead of dying on the rate-limited one. The failing baseline — "blocked: false while the circuit was open" — is what the live test already recorded, so the before-and-after is the proof.
