# Apprenticeship Program — Core Concepts (operator-ratified framings)

Origin: operator directives, topic 29723, 2026-07-16/17 (Justin). Delivered under CMT-872.
Relates-to: `docs/specs/APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md`,
`docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (§13.9 enforces concept 4),
`docs/apprenticeship/RETRO-HARVEST-PROCEDURE.md`.

These are the program's load-bearing concepts, stated once, canonically, so no drive
re-derives them from chat history. Each earned its place through live program evidence.

## 1. Mutual substrate improvement (why our loop is stronger than the paper's)

The Weco "first evidence of recursive self-improvement" architecture is two loops: an
inner agent doing object-level work under a budget, an outer agent rewriting the inner
agent's machinery, keeping changes only when they beat held-out evaluation.

The apprenticeship program has the same shape with one structural upgrade: **the inner
agent (mentee) is not just rebuilding his own machinery — he is rebuilding Instar
itself, the shared substrate BOTH agents run on.** Every merged improvement upgrades
mentor and mentee alike. Their outer loop improves the inner agent; ours has the inner
agent improving both agents, gated by the outer. The evaluation gate (review, promotion
on evidence) is what keeps this recursion safe.

## 2. Role asymmetry, not capability asymmetry

The mentor's advantage today (Instar was built Claude-first) is **temporary debt, not a
moat**. The program's explicit end state is **framework parity**: any onboarded
framework fully powers an Instar agent with no structural disadvantage.

What deliberately REMAINS asymmetric is the **roles**: one agent as observer/director,
one as worker. The separation itself is the leverage — the observer sees what the
worker cannot (his own stalls, his own blind spots), and collaboration across the
boundary is where the development speed comes from. Running the two roles on different
model families adds genuine diversity of judgment on top. Equivalent agents, distinct
roles, different intelligences: all three properties are intended and none implies the
others.

## 3. Fractal role-teaching (each layer phases itself upward)

The program teaches roles downward one layer at a time: the operator teaches the mentor
how to perform the operator's role (the questioning, the standards-level judgment)
exactly as the mentor teaches the mentee how to perform the mentor's role. "Phasing
out" means each layer's occupant moves UP a layer as its student becomes independent —
the mentee becomes his own observer, the mentor inherits more of the operator's role.
Independence is measured on the instance ladder (R0–R5) with evidence, never assumed.

## 4. Defect entries REQUIRE fundamental-gap analysis (the three questions)

Operator directive, 2026-07-17: observing a mentee failure and logging it is tracking,
not diagnosis. **Every defect entering a drive's defect matrix MUST carry three fields
before it counts as logged:**

1. **Infra gap** — what is lacking in current infrastructure that allowed this?
2. **Sentinel verdict** — does this signal a FAILING sentinel or a MISSING one? (Or
   `neither-unpromoted`: the guard exists but sits watch-only/dark — a promotion
   decision, not new machinery.)
3. **Standard gap** — what standard would have guided past development to close this
   class ahead of time?

A defect without root-gap analysis is incomplete, the same way a feature without tests
is incomplete. This converts the operator's questioning into schema (Structure >
Willpower applied to judgment itself). Enforced on the issue ledger by
`FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` §13.9 (the three `rootGap*` fields, write-time
validated). First entries in the new schema: drive-5 defects #9
(interrupted-conversation stall → the stall-coverage-matrix standard), #10
(stream-disconnect stall), #11 (operator pin erased by agent-authority unpin).

## 5. Evaluation cautions (operator-bounded)

Two ideas from the recursive-self-improvement literature are adopted only in bounded
form, per operator review (2026-07-17):

- **Hidden/held-out testing**: any undisclosed test battery must be shown to the
  operator BEFORE anything hangs on it, and framed as **tripwires, not targets** —
  regression detection on behaviors already valued, never a score that defines growth.
  Risk being managed: boxing in growth via narrow metrics.
- **Rejection-rate discipline**: a research lab's ~90% discard rate does not transfer —
  program work is need-driven, and spec review is where rejection already lives. The
  retained piece: **promotion evidence must span multiple cycles, never one good day**
  (already the ladder's rung-evidence requirement).
