<!-- bump: patch -->

## What Changed

Adds a new constitutional standard, **"Verify the State, Not Its Symbol"**, to
`docs/STANDARDS-REGISTRY.md` (Substrate family), and registers it as **P20** in
`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` so the `/spec-converge` lessons-aware
reviewer fires on every future spec. Lesson L5 is re-pointed to P20 as its parent.

The standard names a class of blind spot that has bitten the fleet repeatedly under
different disguises: a detector, gate, verifier, or sentinel that trusts a *symbol*
of a state (a string on a pane, a marker, the presence or absence of a proxy signal)
instead of confirming the *state itself* — in both directions, where the presence of
a symbol is taken as the condition being true and the absence of a signal is taken as
the condition being true. When the evidence needed to decide is unavailable, the result
is **unknown**, and unknown must fail toward the least-harmful action for that specific
detector — which is not always "closed".

Documentation-only: this change adds no runtime, gate, or `src` surface. The companion
fix for the crystallizing instance (the RateLimitSentinel false-positive) is specified
and review-converged in `docs/specs/ratelimit-sentinel-false-positive-hardening.md`,
which this change also lands so the standard's enforcement-first citation resolves to a
real file; the implementation of that fix ships as a separate, tracked follow-on PR.

## What to Tell Your User

- **A new "verify the real state, not a sign of it" rule**: "I added a standard to how I'm
  built so that my own watchers can't cry wolf at a word on the screen, or go silent because
  they looked for proof in the wrong place. From now on, anything I build that watches for a
  problem has to confirm the problem is really happening before it acts — and when it genuinely
  can't tell, it errs toward the quiet, least-harmful choice instead of the loudest one. This
  came straight out of the false 'you're throttled' alarms you saw tonight."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| "Verify the State, Not Its Symbol" standard (P20) | automatic — the `/spec-converge` lessons-aware reviewer now flags any future spec whose detector fires on a single uncorroborated symbol, reads a self-writable channel, or treats absence as the bad state |

## Evidence

Earned from a live recurrence, not a hypothetical. On 2026-06-24 (topic 16566) the
RateLimitSentinel fired "this turn died on an API error" because the literal words
`API Error:` were on the session pane — placed there by the session *investigating* API
errors, with nothing actually failed — then cried wolf for ~11 minutes because its recovery
verifier looked for the session transcript in one Claude account home while the session ran
under another, reading absence-of-file as "never recovered". The detector that diagnosed the
bug was, live, tripped by the bug. The same class had recurred 4+ times before under different
disguises (2026-06-06 stale-transcript-pointer crying-wolf, the AUP-rejection wedge, the origin
of lesson L5), each patched point-wise without ever naming the class — the registry's promotion
signal. The companion code fix's reproduction + before/after is carried in its own spec and
follow-on PR; this PR is documentation-only and changes no runtime behavior to reproduce.
