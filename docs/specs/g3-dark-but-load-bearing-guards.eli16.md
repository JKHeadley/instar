# Dark-but-Load-Bearing Guards — Plain-English Overview

> The one-line version: a safety system that ships turned-off-on-purpose looks exactly like one that's off but that a critical path secretly depends on — so this makes the second kind announce itself and force a decision, instead of sitting quiet while the thing it should protect runs unguarded.

## The problem in one breath

The agent keeps a list of "guards" — background safety systems (watchdogs, sentinels, reapers). Many ship DARK: deliberately turned off until they're proven out. That's fine when the guard is genuinely optional. But some dark guards protect a CRITICAL path — and in the inventory a critical-but-dark guard is indistinguishable from a harmless-and-dark one. So it sits silent, the path it should guard runs unprotected, and nobody is told. The July-1st silent-message-loss incident is the exact case study: the guards that would have caught it had shipped dark, and nothing surfaced that a critical path (your messages getting delivered) was leaning on them.

## What already exists

- **The guard inventory** (`GET /guards`) — grades every guard by what can actually be VERIFIED, not what the config wishes. An off guard is tagged either "dark by design" (normal, quiet) or "diverged from default" (it was supposed to be on — that's the load-shed alarm).
- **A background probe** that raises ONE calm, coalesced attention item when a guard is in a bad state, and an operator PIN for decisions that suppress a safety signal.
- **What's missing:** the inventory has no way to even SAY "this dark guard is load-bearing," so the critical-but-dark case falls through as ordinary quiet.

## What this adds

A guard can now be DECLARED load-bearing in the manifest, naming the critical path it protects and an optional grace period ("soak window"). A load-bearing guard that's sitting silently unguarded is then sorted into exactly one of three states:

- **Gap (loud):** it's dark or dry-run, past any grace period, and nobody has accepted the risk → a loud alert that forces a decision (turn it on, or record an owned acceptance).
- **Soaking (soft):** it's in a dry-run graduated-rollout window → surfaced gently on `/guards`, no nagging alert — but it automatically LAPSES into the loud Gap if it stalls past its window. You can't quietly soak forever.
- **Accepted (owned):** an operator recorded, behind the dashboard PIN, a named reason to accept running without it → fully suppressed, but shown as a VISIBLE "accepted risk" row with who accepted it and why. A recorded decision with an owner, never a shrug.

The critical-path name travels on every alert, so you see "a load-bearing path (message delivery) is unguarded," not a bare row.

## The safeguards

- **Observe-only.** G3 only classifies and surfaces — it never turns a guard on/off, never blocks anything.
- **The alert can't hide another alarm.** A load-bearing Gap is a deliberately long-lived signal (the decision can take days). The subtle fix from review: if it shared the general guard-alarm channel, an open Gap would MASK a fresh, separate emergency (a real guard load-shedding right now) — because the alert funnel refuses to re-post the same open item. So the load-bearing Gap rides its OWN dedicated channel, leaving the emergency channel free to fire independently.
- **Owned, not guessed.** Accepting a risk needs the dashboard PIN AND a named owner — the PIN alone only proves "a PIN-holder," so the person's name is required and written into the visible row.
- **Cheap and reversible.** The classification is pure read-only logic (no disk work on the hot path), the alert ships behind a flag, and the "which guards are load-bearing" list is a reviewed manifest edit, easily changed.

## Open questions

None left open — the operator pre-approved this project's decisions (topic 29836). Every reviewer-contested choice is resolved in the spec: soaking is a time-bounded graduate arm that always lapses loud (never a silent-forever shrug), the accept path is PIN-gated with a required owner, the masking risk is closed by giving the load-bearing alert its own channel, and both classifier functions stay pure by having the caller read the accept-file once and pass it in. The initial set of load-bearing guards and their soak windows is a reviewed manifest curation finalized at build time against the current guard list.
