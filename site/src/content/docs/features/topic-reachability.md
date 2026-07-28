---
title: Verify-After Topic Reachability
description: After the agent shuts down or moves a conversation's session, it verifies you can still reach it — and if a conversation is genuinely orphaned, it surfaces one calm heads-up instead of letting your messages silently vanish.
---

When the agent kills, reaps, or moves a conversation's session, there is a narrow risk it
leaves that conversation with no working path for your next message — so the message
black-holes, silently. Most of the time this self-heals (your next message simply spins up
a fresh session), but specific failures defeat that self-heal: a session start-up that
*hangs*, or — on a multi-machine setup — a conversation handed to a machine that can no
longer serve it.

Verify-After Topic Reachability (postmortem fix F7) closes that gap with two pieces. It
ships dark on the fleet and live on a development agent.

## SpawningTopicsRegistry — the spawn-guard, made safe

The guard that prevents double-spawning a conversation used to be a plain set cleared only
when a spawn settled. A start-up that *hung* left the "currently starting" flag set forever,
silently skipping every later message for that conversation. The `SpawningTopicsRegistry`
replaces it with a token-tagged registry: each spawn gets a token, and the flag is cleared
only by the matching token — so a late completion from a superseded spawn can never delete a
newer one (the ABA fix). Crucially, **nothing auto-clears** the flag: review proved that
clearing a flag while the spawn body is still running just relocates the original
double-spawn race. A hung spawn keeps its flag and is **surfaced**, not raced.

## TopicReachabilityVerifier — the smoke alarm

The `TopicReachabilityVerifier` is a pure signal. After a session is killed or reaped, it
waits a short grace window (so a normal self-heal lands first) and then checks the
conversation is still reachable. If it genuinely is not, it raises **one calm, NORMAL-priority
heads-up** ("a conversation may be unreachable"). It **mutates nothing** — never kills,
spawns, moves, or clears. It is careful not to cry wolf: a conversation that simply has no
session right now but will spin one up on your next message counts as reachable, not
orphaned. It coalesces a burst of problems into one notice, backs off a flapping
conversation, and stays quiet during an emergency stop (re-checking once the stop lifts).

## Where to see it

The verifier registers in the guard posture, so `GET /guards` shows whether it is on. Because
it only watches and never acts, there is nothing to undo if it ever over-alarms — it is a
smoke alarm, not a firefighter.

## ColdStartFallbackReply — never silence on a failed start

When you message a topic and the agent genuinely cannot **start** (cold spawn) or **restart**
a session for it — the session limit is reached, the machine is under resource pressure, or an
unexpected start-up error — you no longer get silence or a bare error. The `ColdStartFallbackReply`
builder composes ONE plain-English reply on the **deterministic delivery path**
(`telegram.sendToTopic`, never the LLM tone gate that can fail closed under the very pressure it
would report) that: (a) says **why** the session couldn't start (classified: session-limit /
resource-pressure / generic start-failure), (b) points you to your always-alive **Lifeline**
topic, and (c) hands you a ready **copy-paste debug message** to drop in the Lifeline so the
agent can diagnose and free resources fast.

This is the user-facing (G1) arm of the constitutional standard *The Agent Is Always Reachable*
(corollary 2 — no silent resource rejection). It is an **always-on** safety floor (no flag — the
standard forbids dark-shipping reachability), wired into both inbound failure paths. If the
failing topic *is* the Lifeline it doesn't send you elsewhere; if no Lifeline is configured it
still states why and reassures you the message isn't lost.
