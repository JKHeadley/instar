---
slug: blindspot-class-symbol-vs-state
companion-eli16: blindspot-class-symbol-vs-state.eli16.md
status: ratified
approved: true
approved-by: "justin (topic 16566, 2026-06-24): 'Yes, if that constitutional rule actually feels a gap that we don't have currently then let's add it' — gap independently verified (recurred across 4+ incidents) before adding."
ratified: STANDARDS-REGISTRY standard "Verify the State, Not Its Symbol" (Substrate) + design-principles P20; L5 re-pointed to P20
proposes: STANDARDS-REGISTRY standard "Verify the State, Not Its Symbol"; design-principles P20
origin-incident: "topic 16566, 2026-06-24 — RateLimitSentinel false-positive (idle-error fired on incidental error TEXT; recovery verifier read absence-of-transcript as failure)"
companion-fix: ratelimit-sentinel-false-positive-hardening
requested-by: "justin (topic 16566, 2026-06-24): 'this represents a class of blind spots… analyze this at a meta level to determine what the class of errors/blind spots this represents that isn't currently represented and enforced through our standards and constitution'"
---

# Blind-Spot Class — Verify the State, Not Its Symbol

## Why this document exists

Justin reported the "API error" detection firing when nothing was wrong. We fixed the
two concrete defects (companion spec: `ratelimit-sentinel-false-positive-hardening`). But
he asked for the harder thing: **name the CLASS of blind spot these two bugs are instances
of, and encode it constitutionally so we never again build anything with the same latent
failure.** This document is that meta-level analysis and the proposed standard.

## The two bugs, reduced to their logical shape

**Bug 1 (false alarm).** The detector decided "this turn DIED on an API error" by scanning
the terminal for the *string* `API Error:` / `fetch failed`. Those strings were on screen
because the session was *investigating and displaying* API errors. → It matched a **symbol
of the condition** (the word) and treated it as proof of **the condition itself** (a dead
turn). No independent signal confirmed the turn had actually failed.

**Bug 2 (crying wolf).** The recovery verifier decided "did it recover?" by watching the
transcript file grow. It looked in ONE home (`~/.claude`); the session lived under a
different account home, so the file was *invisible*. → It read the **absence of its signal**
(can't find the transcript) as proof of **the alarming state** (never recovered), and that
unknown failed toward the LOUD action (escalate), not the safe one.

Strip the specifics and one root remains, in both directions:

> **A detector trusted a *symbol* of a state instead of verifying the *state*.**
> Presence of a symbol ⇒ "condition is true" (Bug 1). Absence of a symbol ⇒ "condition is
> true" (Bug 2). In neither case was the actual referent — the territory — confirmed.

This is the *map–territory* error, mechanized into a gate. It is not currently a first-class
standard. The closest existing articles each cover one *facet* but not the class:
`No Silent Degradation` (a *provider* failure → fail-closed, but says nothing about a
detector firing on a string); `Observation Needs Structure` (a *duty to look* needs an
artifact, but not *what the look must verify*); L5 `State-detection robustness` (a worked
instance — parsers need canaries — which is sub-clause 3 below applied to version strings).

## The class — three failure modes of one root

### Mode A — Symbol-presence is not state-truth (proxy-as-truth)
Firing on the textual / labelled *appearance* of a condition without an independent signal
that **only the real state can emit.** The robust sibling already in our codebase shows the
fix: the genuine-`throttle` path requires the pane to be **byte-identical across two polls**
(a settled, frozen turn) before acting — a corroborating signal a live, animating session
*cannot* fake. The generic idle-error path had no such second signal, so a single substring
sighting was enough. **The cure is corroboration: a second, causally-tied signal that the
real state produces and an impostor state cannot.**

### Mode B — The observer must not feed its own sensor (self-referential contamination)
A detector whose input channel can be polluted by its own subject. Here the agent was
*investigating* API errors, which put the error words on the very pane the error-detector
reads — so the act of working tripped the alarm. This is the same family as our existing
AUP-wedge rule ("keep adversarial payloads in files, reference by path — never paste them
into the conversation, or the API's policy classifier fires on your own test content"). A
sensor's evidence must be **causally downstream of the real event**, not merely *co-present
with talk about* it. **The cure: read a channel the subject cannot write into incidentally**
(the turn's actual exit state, the structured event — not free terminal text the work emits).

### Mode C — Signal-absence is not alarm-truth; missing evidence is UNKNOWN, and UNKNOWN fails toward least-harm
When the evidence needed to decide is unavailable, the result is **unknown**, never a silent
collapse into the loud / destructive verdict. Two parts:
- **Direction.** "Fail safe" is not universally "fail closed." For a *security gate* the
  harmful action is *allow*, so unknown → block. For a *notice / recovery sentinel* the
  harmful action is the *nag / escalation itself*, so unknown → **stay quiet**. Every
  detector must name which direction is least-harmful and fail that way — explicitly.
- **Manufactured absence.** A **single-canonical-source assumption** against a plural
  reality is what fabricates the false "absence" (one Claude home vs many account homes).
  This is exactly L5's drift-canary lesson generalized: if your map assumes one source and
  the territory has several, you will read "not found" as "not there." **The cure: resolve
  the signal by its real, attributed location (the account home you launched it under), and
  treat genuine not-found as unknown — never as the bad state.**

## Proposed constitutional standard (for `docs/STANDARDS-REGISTRY.md`, "Building" section)

> ### Verify the State, Not Its Symbol
> **Rule.** A detector, gate, verifier, or sentinel must confirm the **state of the world**
> it claims to detect — never accept a **symbol** of that state (a string, label, marker,
> filename, or the mere presence/absence of a proxy signal) as proof the state holds. The
> failure runs in both directions: *presence* of a symbol is not the condition being true,
> and *absence* of a signal is not the condition being true. Missing evidence resolves to
> **unknown**, and unknown must fail toward the **least-harmful** action for that specific
> detector — which is not always "closed."
> **In practice.** Three teeth, one per failure mode. (A) **Corroborate** every fire with a
> second signal *causally tied to the real state and unfakeable by an impostor state* — the
> idle-error path now requires a settled/frozen pane, the signal only an actually-ended turn
> emits, mirroring the genuine-throttle path that was robust for exactly this reason.
> (B) **Isolate the sensor from its subject** — a detector must read a channel its own
> subject cannot write into incidentally (a turn's structured exit state, not free terminal
> text the work happens to print); the AUP-wedge rule (payloads in files, not conversation)
> is the same article. (C) **Name the fail-direction and resolve signals by attributed
> location** — every detector states which direction is least-harmful and fails that way on
> unknown; signals are resolved by their real plural location (per-account home), and a
> genuine not-found is *unknown*, never the alarming state. Enforcement: the `/spec-converge`
> lessons-aware reviewer flags any spec whose detector fires on a single uncorroborated
> symbol, reads a self-writable channel, or treats absence as the bad state; where the
> detector is CI-expressible, a `no-uncorroborated-symbol-fire` ratchet holds the line.
> **Earned from.** 2026-06-24 (topic 16566): the RateLimitSentinel fired "this turn died on
> an API error" because the words `API Error:` were on the pane — put there by the session
> *investigating API errors* — and then cried wolf for 11 minutes because its recovery
> verifier looked for the transcript in one Claude home while the session ran under another,
> reading absence-of-file as never-recovered. The detector that diagnosed the bug was, live,
> tripped by the bug. Justin: *"this represents a class of blind spots… analyze at a meta
> level… [so] we don't develop anything that has the potential for this blindspot to exist."*
> **Traces to the goal.** A self-evolving agent acts on what it believes is true about
> itself and the world. A detector that confuses the *description* of a state for the *state*
> feeds the self-model falsehoods that feel like facts — every decision built on them
> compounds the drift. This is `Structure beats Willpower` applied to the agent's senses, and
> the parent principle under which L5 (state-detection robustness) and the AUP-wedge rule are
> special cases. Sibling to `No Silent Degradation` (which governs *provider* failure;
> this governs *evidentiary* failure — what the detector is allowed to conclude from what it
> can and cannot see).

## Enforcement (so it is structure, not a wish)

Per *How a new standard joins this registry* (enforcement first, constitution second):
1. **Instance fixed** — companion spec `ratelimit-sentinel-false-positive-hardening`
   (corroborated idle-error + account-home, fail-safe-by-direction verifier).
2. **Design-pipeline guard** — register as **P20** in `INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`
   with a backtrack-tell, so the `/spec-converge` lessons-aware reviewer fires on every future
   spec: *"detector/gate fires on a symbol's presence/absence with no corroborating,
   subject-isolated, real-state signal; or treats missing evidence as the alarming state."*
3. **CI ratchet (where expressible)** — a `no-uncorroborated-symbol-fire` style test for
   detector callsites that fire on a bare `recentOutput.includes(pattern)` with no settle /
   second-signal corroboration, mirroring `no-silent-llm-fallback.test.ts`.

## ELI16
See `blindspot-class-symbol-vs-state.eli16.md`.
