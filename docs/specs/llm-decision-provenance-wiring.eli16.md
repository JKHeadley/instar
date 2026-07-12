# ELI16 — LLM-Decision Provenance Wiring

## What this is, in plain English

Instar lets AI models make lots of small decisions all day: "should this outbound message be sent or held?" (the tone gate), "should this runaway process be killed?" (the hog classifier), "should this autonomous run keep going or stop?" (the completion judge). Right now the system records *how often* each of those AI decisions fires and *what it cost* — a good cost meter — but it almost never records *what the decision was actually looking at* or *what it decided*. The audit you approved found this gap and split the fix into three tracked pieces. This spec builds the FIRST and most foundational piece: turning on a durable record of each important AI decision — the context it was handed and the choice it made — so it can later be graded ("was that the right call?") and fed back into the benchmark. You can't grade or benchmark a decision you never wrote down, so this comes first.

## What actually changes

The recording *mechanism* already exists and is well-built (it scrubs credentials, keeps files locked-down and machine-local, auto-deletes after 14 days, and never slows the decision down). Today it's only hooked up to ONE place. This spec hooks it up to the three highest-stakes AI decisions first, and — importantly — leaves behind an automated tripwire (a "ratchet") so the coverage can only grow, never silently shrink. That tripwire is the real fix: the audit existed *because* a rule was honored in words but nothing in the code enforced it. Now the code enforces it.

## The main tradeoffs (what you're actually signing off on)

1. **Breadth.** This ships the three highest-stakes decision points, not all ~60. Widening later is technically easy (a small allowlist edit behind an off-by-default flag) but is NOT operationally free — logging more decisions means more of their context sits on disk as plaintext (credentials are stripped, but ordinary text like message bodies is not). So the spec makes any future widening require your explicit privacy sign-off, not just a code change.

2. **Privacy posture.** The records live only on the machine that made the decision, in locked files, deleted after 14 days, and are never served raw. A redacted view is readable over the dashboard/API (behind your PIN), and the spec now treats every piece of logged text as untrusted — HTML-escaped for the browser and safely wrapped when later replayed to a grading model — so a decision's own context can't turn into a hidden instruction that fools the grader. For the tone gate specifically, it logs a short derived fingerprint, not the full message body.

3. **It never changes the decision.** Logging is observability only. The spec proves this: if writing the record ever fails, the decision still proceeds unchanged (a held message is never caused by a logging hiccup).

## Where it sits

This is the keystone of the three-part fix (ACT-562). After it lands, the next pieces are the periodic "grade these decisions with the strongest model" review (ACT-563) and making the benchmark test the real production prompt plus your real-data reevaluation loop (ACT-564). It ships ENABLED on the development machine (so we live with it first) and OFF on the fleet until it's proven. Nothing about how the agent behaves for you changes when this lands — it's a recorder, not a new gate.

---

_Status: approved by Justin (topic 11960, 2026-07-12 — "approved, lets proceed with this"). Shipping dark-gated: ENABLED on the development agent, DARK (constructed-but-idle) on the fleet._
