# Circuit Breaker "Reset After" Fix — ELI16

Viewable private artifact:
https://echo.dawn-tunnel.dev/view/bfae9763-aa22-4486-bc7d-9b7b2e470658?sig=72ade47ad66400b09f8ef262b0a5055fbf5f099684c0b45bb2da1b08b6977743

When an AI provider like Gemini runs low on capacity, it usually tells you when to come back:
"your quota will reset after 8 seconds." Instar has a safety switch — a **circuit breaker** — that
briefly pauses AI calls after a rate limit so it doesn't keep hammering an overloaded provider.

The breaker is smart enough to read the provider's "come back in N seconds" hint and only pause that
long. But it was only listening for the phrase **"reset IN N seconds."** Gemini says **"reset AFTER
N seconds."** That one-word difference meant Instar couldn't read Gemini's hint at all — so it used
its blunt fallback: pause **everything for 15 minutes.**

The result: Gemini would say "I'll be ready in 8 seconds," and Instar would freeze the whole agent
for **15 minutes** — about **110× longer** than needed. On the live Gemini agent this happened over
and over, making it look stuck.

The fix teaches the breaker to also understand **"reset after N."** Now an 8-second reset means
roughly a 30-second pause (a sensible floor), not 15 minutes — so the agent recovers quickly instead
of sitting idle.

_Tier-1 fix · branch `echo/circuit-breaker-reset-after` · 3 unit tests + full breaker suites green._
