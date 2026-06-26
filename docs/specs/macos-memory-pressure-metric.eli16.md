# ELI16 — Why sessions vanished and never came back (a wrong memory gauge)

## The problem in plain terms

The agent has a janitor (the "reaper") that closes idle sessions when the machine is low on memory, and a "revival queue" that brings sessions back once the machine is calm again. Both rely on one number: how much memory is free.

The trouble is HOW that number was measured. The code asked Node.js for "free memory" (`os.freemem()`). On a Mac, that returns only the tiny sliver of memory that's *completely* untouched — because macOS deliberately keeps that near zero and uses the rest for cache and compression that it can reclaim instantly. So on a perfectly healthy Mac with tons of usable memory, this number reads about **0.1%** — and the code thought memory was permanently in crisis.

Two bad things followed:
1. The reaper, thinking memory was always critical, closed idle sessions too eagerly.
2. The revival queue only brings sessions back when memory looks "normal" — which, with this broken gauge, it never did. So once a session was closed, it **never came back, silently**. A whole topic would go quiet and the user would just see no replies. That's exactly what happened to the "machine swapping" topic (28744).

## The fix

Measure memory the way macOS itself does: real *available* memory = free + the reclaimable inactive and purgeable memory. The codebase already had this correct calculation in one place (the health checker, which reads `vm_stat`); it just wasn't being used by the reaper. The fix lifts that correct calculation into one shared helper and points the reaper at it. On Linux it uses the kernel's "MemAvailable" figure, which is the right one there too.

On the actual machine where this broke: the old number said 0.17% (crisis), the correct number is about 20% available (healthy). So with the fix, the reaper sees the truth, stops over-closing sessions, and the revival queue brings them back.

## Safety

- The change can only make the reaper **less** aggressive and revival **more** available on macOS — the safe direction. It never makes the system close more or revive less.
- It reuses the exact calculation already trusted by the health checker, now in one shared, unit-tested place (no more two copies that could drift apart).
- The memory reader is bounded (a 5-second limit) and never throws — if it can't read, it falls back to a rough estimate, never freezing the janitor.
- No thresholds or gates were loosened — on a real machine the corrected number already reads "normal," so the existing gates work correctly once they're given the truth.
- One machine only; nothing crosses between machines.

## What this does NOT cover (a separate, bigger follow-on)

The operator also asked for a stronger guarantee: every agent should ALWAYS keep at least one session (the lifeline) the user can reach, no matter how tight resources get, and any time a session IS denied for resource reasons the user must be told clearly with guidance — never silence. That guaranteed "the agent is always reachable" floor is its own piece of work and standard, coming next; this fix removes the false-alarm metric that caused the silent denial in the first place.
