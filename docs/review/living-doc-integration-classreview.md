# Class-Review — Living-Doc Integration (Justin directive, 2026-07-19 ~20:43 PDT)

**Artifact status:** Canonical review input. The source living document is now
`docs/CROSS-RUNG-COORDINATION.md`; the infrastructure proposals below remain future build
scope unless separately approved.

**Directive:** "make sure this document [cross-rung / coherence foundational doc] is plugged in to our processes via infrastructure such that it's impossible to miss opportunities to update/improve it AND/OR to leverage its wisdom during operations and development."

This is Structure > Willpower turned on the living doc itself, and a live instance of the WS1 correction→class-review loop. Per the meta-rule, the class-review runs BEFORE the instance fix.

## Class question
What standard/process makes a FOUNDATIONAL / LIVING doc structurally impossible to (a) miss updating and (b) miss leveraging — via infrastructure, not willpower?

## (1) Standard missing / upgrade → propose **"Living-Doc Integration" standard**
Today a foundational doc is written and then relies on someone REMEMBERING to update it and to consult it. Instar has ~15 features that IMPLEMENT cross-rung coordination piecemeal but NOTHING that keeps a designated living doc bidirectionally wired.

**Living-Doc Integration standard:** any doc marked `living: true` / foundational MUST declare — and a registry + conformance check MUST verify — BOTH arms, each bound to named infrastructure:
- **Update-triggers** (flow INTO the doc): named structural events that force a "review-this-doc-for-update" step.
- **Leverage-surfaces** (flow OUT of the doc): named decision points where its wisdom is injected during ops/dev.
A living doc that declares NEITHER arm FAILS the check. (Structure > Willpower: presence in `docs/` is not enough; the wiring must exist and be verified — the same shape as the spec-converge multi-machine-posture check.)

## (2) Dev-process gap
No process step forces either direction today. Process fix = wire both arms to REAL infra:

### ARM 1 — UPDATE-CAPTURE (can't miss opportunities to update/improve)
- **1a — correction→class-review loop (WS1):** the class-review template gains a mandatory checkpoint — "Does this lesson touch a foundational/living doc? → register a doc-update review." (Recursion: the SAME WS1 loop that captures corrections now captures doc-update opportunities.)
- **1b — Close-the-Loop cadence:** the doc carries a registered review cadence (evolution action / scheduled review) so it's revisited even absent a correction. Untracked = Abandoned. **← DONE NOW (evolution action registered below).**
- **1c — rung-limit / coherence-gap discovery trigger:** hitting a rung ceiling or closing a coherence-axis gap — the exact events the doc is ABOUT — structurally files a "does this update the doc?" item. (Codey's 4-worktree ceiling already fed §5 by hand; make it automatic.)
- **1d — cartographer doc-freshness:** as a canonical `docs/` node, the freshness sweep flags it stale when its subject-area code changes.

### ARM 2 — WISDOM-LEVERAGE (can't miss opportunities to leverage it)
- **2a — Playbook context item:** the doc's core wisdom (5-rung model + "grow the rung whose ceiling binds" + the coherence axes) becomes a curated playbook item, surfaced at session-start and on parallelization/scaling triggers. Primary "leverage during operations" surface.
- **2b — spec-converge reviewer lens:** add a "cross-rung / coherence posture" lens (like the multi-machine-posture check) that consults the doc — so every spec is checked against its wisdom during development. Primary "leverage during development" surface.
- **2c — session-start hook injection:** a compact pointer to the doc + its placement rule injected at session boot (like the operator-binding / preferences blocks) so every session knows to consult it when deciding how to parallelize.
- **2d — Coherence Gate reference:** since the doc is now framed as ONE axis of coherence, the gate's reflection references the relevant axis on high-risk actions.

## The dogfooding recursion (worth naming to Justin)
The doc ABOUT coherence gets integrated via the coherence infrastructure: Playbook = context coherence, spec-converge lens = intent↔action coherence, Close-the-Loop = time coherence, session-start injection = identity coherence. The mechanism proves the thesis.

## Delegation split (delegation-default — I orchestrate + design, Codey builds)
- **MINE (overseer, now):** this class-review + the immediate Close-the-Loop registration (1b) so the doc can't rot before the permanent infra lands.
- **CODEY (ceremony, folded with the already-queued canonicalization):** the Living-Doc Integration standard + hooks 1a, 1c, 1d, 2a, 2b, 2c, 2d as real source — spec through full /instar-dev ceremony → converge → Justin approves → build. Queued behind his current lanes (respect the 4-worktree ceiling — the SCALE finding; do NOT thrash a 5th concurrent worktree).

## Instar-general (applies to me + Luna, not just this doc)
The standard makes EVERY future foundational doc (the constitution, standards registry, Luna's org playbooks) plug-in-by-construction. This is the class-level fix; this specific doc is the instance.
