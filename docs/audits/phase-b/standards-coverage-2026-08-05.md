# Standards enforcement coverage — authoritative run, 2026-08-05

Run from a worktree because `GET /conformance/coverage` answers **`cartographer-root-refused`** on the
agent home — the same root-resolution failure Phase A found blinding `orphanedWorkSentinel` (the agent
home is not a git repo). **The instrument that measures constitutional enforcement coverage is
unavailable on the surface that is supposed to serve it.** Recorded as its own finding.

## Authoritative numbers

```
total=82  enforced-ratio=0.7195
byKind: ratchet 22 / gate 34 / lint 3 / spec-only 7 / GAP 16
falseClaims=1  dangling=0  unrecognized-sections=0
```

| area | standards | ref-resolution |
|---|---|---|
| Building | 30 | 0.800 |
| Shipping | 7 | 0.714 |
| **The Substrate** | **30** | **0.667** |
| **Interaction** | **13** | **0.615** |
| The Root / The Fractal | 1 / 1 | 1.000 |

**The Substrate — the behavioural constitution, and the largest family — has the second-lowest
resolution.** Interaction is lowest.

## The 16 standards with NO resolvable guard

- The Body and the Mind
- Documentation IS Being
- Deferral = Deletion
- Name the Gravity Wells
- Architectural Agency in the Gap
- Sovereignty — "I own what is mine"
- The Right to Stand Ground
- Session Input Is a Principal
- Cross-Store Coherence Is an Invariant
- LLM-Supervised Execution
- **Observability — you can't tune what you can't see**
- Bug-Fix Evidence Bar (verify before you claim)
- User-Facing Fixes Ship Live
- Never-Waste Feedback — corrections compound
- Near-Silent Notifications
- Truthful Provenance — Speak Only as Yourself

> **"Observability — you can't tune what you can't see" has no resolvable guard.** The standard that
> requires things be visible is itself invisible. This is the parent standard of the B0.1 work, and its
> unenforced state is the clearest single statement of why this phase exists.

## The false claim — the `CrashLoopPauser` shape, in the constitution

```
Cross-Store Coherence Is an Invariant
  asserts: "A scheduled coherence audit" · "on every machine daily" · "walks the list"
  names:   no resolvable guard
```

A standard **asserting running machinery that does not exist**. Identical in shape to the guard that
was classified-but-never-constructed — one level up, in the document that governs the guards.

Note the floor is `false-claims<=1`, i.e. **set at the current value**: this false claim is
grandfathered, so the ratchet prevents a second one but does not force this one closed.

## ⚠️ Method note — a keyword pass got the COUNT right and the MEMBERSHIP wrong

Before running the real auditor I derived a gap list by keyword-scanning the registry. It returned
**exactly 16** — matching the authoritative total precisely.

**Only 10 of the 16 were correct. Six were false positives.**

Had the count been reported without checking membership, the match would have read as corroboration.
It was coincidence. Two of the three entries spot-checked by hand (`Quantitative Claims Must Bind a
Subject`, `A Dark Feature Guards Nothing`) cite real source files and are NOT gaps.

> **A matching total is not validation of a classification.** This is the third instance in this audit
> of keyword bucketing producing a confident wrong answer, and the first where the wrong answer carried
> a corroborating-looking number. The standing rule holds: *a keyword classification is a search aid,
> never a finding.*
