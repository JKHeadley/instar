# Charter (DRAFT v2, awaiting the owner's own-words approval): Effort Process + Engine Optimization

- **Conversation:** telegram:141868
- **Owner:** Justin. Only Justin can confirm or change these goals.
- **Stage:** 0, charter. Pre-review done with three reviewers (`step0-meta-synthesis.md`), post-review in `step0-post-review.md`. v1 was sent 2026-11-11 14:26 PST. Justin replied that it "doesn't seem to cover the meta-level process that we discussed", so v2 makes the process a first-class goal.
- **Process decisions approved by Justin, 2026-11-11 10:55 PST ("yes to all"):**
  1. The Chief of Staff binding is the single record for an effort, and its linked initiative holds the stages.
  2. Multi-model review runs before and after every stage in this pilot.
  3. Only required process fixes block a stage.
  4. Discovery proposes efforts; Justin charters them.
  5. Justin settles material reviewer disagreements and decides whether to accept a degraded review.
  6. Pilot on Echo first, then roll out to user agents along the Maturation Path.
  7. Every engine-specific feature has a declared fallback on other engines.

This charter has two goals. Goal A is the general effort process. Goal B, Engine Optimization, is its first real use. Both run through the same stages, and every stage of B is also a test of A.

## Goal A: the effort process (meta level)

Instar has built-in, constitution-aligned infrastructure for running any effort, and runs it autonomously:

1. **Create the effort:** a charter (goal, non-goals, constitutional anchors, kill criteria, done checklist) confirmed by the owner.
2. **Research and brainstorm.**
3. **Spec design and review.**
4. **Build and test.**
5. **Maturation and deployment,** with anti-stall mechanisms and a clear path to full activation.
6. **Audit, logging, maintenance and evolution.**

Every stage is wrapped in the same meta loop:

- **Pre-review:** what does Instar already have for this stage, and how well is it actually applied? Improve the weakest part first (one small fix; anything bigger becomes its own tracked effort and runs in parallel, unless it is truly required).
- **Do the stage.**
- **Post-review:** what could have gone better? Act on each finding: fix it, or file it as a tracked item.

Rules for the loop:

- **Multi-model:** Fable 5.2 and GPT 6 Astra take part in both the pre-review and the post-review, with full context. Each writes their own view before seeing Echo's (sealed).
- **Constitutional:** each stage records which standards from both constitution books it was checked against (the 2.0 book is the master).
- **Fractal:** the same loop applies to sub-efforts, and one level up, to the process itself. The process's own improvements go through the normal dev gates. There is only one meta layer, so the recursion has a floor.
- **Structural, not willpower:** stage records and checks live in Instar (the Chief of Staff binding and its initiative), not in Echo's memory.
- **Anti-stall:** every stage has a time and round budget. It waits on the owner only for decisions the charter names as his. Any work those decisions don't gate keeps going, and a stalled stage gets flagged automatically.

### Done checklist (Goal A)

| # | Kind | Item |
|---|---|---|
| A1 | judgment (owner confirms) | The process (6 stages, the meta loop and the rules above) is written up and checked against both constitution books. Any constitution change is proposed to Justin, not made by Echo |
| A2 | deterministic | Sealed multi-model review for any artifact (sub-effort B) is merged into JKHeadley/instar |
| A3 | deterministic | Stage records plus a checker (sub-effort C) are merged. A stage can't advance without its pre-review, fix-or-reason, reviewer receipts, constitution check and filed post-review findings. Budgets and stall flags are included |
| A4 | deterministic | The one-tap charter confirm (sub-effort A, restarting from the simpler design) is merged |
| A5 | deterministic | A recurring stage-6 job audits finished stages and the process itself, and files improvements as proposals |
| A6 | judgment (owner confirms) | Goal B has run through every stage on this process, with records. A second effort has then used it, and Justin has decided whether to propose a new constitutional standard |
| A7 | judgment (owner confirms) | The process has reached the development-agent rung of the Maturation Path, with a graduation test and a deadline for rollout to user agents |

Until A2 to A4 ship, Echo does those steps by hand and records them in this folder. The manual run is itself the test.

## Goal B: Engine Optimization (first effort run on the process)

Instar detects which engine a session runs on (Claude Code, Codex and any others enabled) and automatically uses that engine's best features. Examples include the advisor tool, per-job effort and model, fallback models and least-privilege spawning. Each feature lives inside that engine's connector and has a declared fallback elsewhere. A standing discovery job keeps finding new engine features and proposes them as new efforts.

### Done checklist (Goal B)

| # | Kind | Item |
|---|---|---|
| B1 | judgment (owner confirms) | Research brief: an engine-feature inventory for every enabled engine, from a sealed three-model brainstorm that includes the March audit reconciliation |
| B2 | judgment (owner confirms) | The engine-optimization spec has converged (cross-model) and been approved |
| B3 | deterministic | The engine-capability layer is merged into JKHeadley/instar main |
| B4 | deterministic | The first batch of engine features (chosen in the spec) is merged, each inside its connector with a fallback |
| B5 | deterministic | A recurring engine-feature discovery job is registered, and it only proposes efforts |
| B6 | judgment (owner confirms) | The features have reached the development-agent rung of the Maturation Path, with a graduation test and a deadline |

## Non-goals

- Special-casing an engine anywhere except in its connector (2.0 Rule 30, Framework-Agnostic).
- Letting discovery start efforts by itself.
- Adding a new constitutional standard before two or three efforts have run through this process.
- Meta passes on meta passes (one meta layer only).

## Constitutional anchors

- **1.x:** Framework-Agnostic — and Framework-Optimizing (STANDARDS-REGISTRY.md:467), Structure beats Willpower, Close the Loop, Signal vs. Authority, No Unbounded Loops, Maturation Path, Tiered Development, Agent Proposes / Operator Approves.
- **2.0 (master):** Rule 30 (Framework-Agnostic), Rule 49 (Constitutional Traceability), Rule 2 (Self-Hosting), Rule 116 (simplest robust route), Rule 123 (team posture). Both books are snapshotted in `constitution/`.

## Kill or pause criteria

- B pauses after research if no engine feature shows a measurable benefit (quality, cost or reliability) over today's behaviour.
- An engine feature without a fallback doesn't ship.
- A process piece that adds ceremony without catching anything in two stages gets cut at the next post-review.

**Linked repos:** JKHeadley/instar, JKHeadley/instar-2 (constitution counterpart). **Check cadence:** 24h.

## Sub-efforts (each tracked as its own initiative)

- **A, one-tap confirm** (`cos-charter-confirm-tap`). The first spec failed convergence after 6 rounds; see `.worktrees/cos-charter-confirm-tap/docs/specs/reports/cos-charter-confirm-tap-convergence.md`. It restarts from a synchronous, machine-signed forward of the tap. Interim: the owner approves in his own words, recorded through Approval-as-Data.
- **B, sealed multi-model review** (`sealed-multimodel-review`).
- **C, stage records and checker** (`effort-stage-gate`), including the budget and stall rules from `step0-post-review.md`.

## Inputs already gathered

- `step0-meta-synthesis.md` plus both reviews, and `step0-post-review.md`.
- `march-audit-reconciliation.md`: 48 items. 23 built, 8 partial, 10 not built, 5 obsolete, 2 unknown.
