# Side-Effects Review — Tiered-dev awareness + migration parity (Steps C + D)

**Slug:** `tiered-dev-awareness-stepCD`
**Date:** 2026-06-01
**Author:** echo
**Spec:** `docs/specs/tiered-dev-awareness-stepCD-spec.md`
**Project:** Steps C + D (final) of the Tiered Development Process

## Summary of the change

Makes the instar-*developing* agent **aware** of the tier system shipped in Step A (#666) —
the gate's size+risk tier SIGNAL, the agent's tier DECLARATION in the trace, the Tier-1
light path (ELI16 + side-effects, no converged spec), the Tier-1 auto-merge policy, and the
`belowFloor` decision audit — and records the **migration-parity** analysis closing the
project. Documentation-only; no runtime code, no gate/classifier/trace-writer change.

**Files changed (in-scope):**
- `skills/instar-dev/SKILL.md` — adds one focused **"Tiered development (tier signal → you
  decide → audited)"** section before "What this skill explicitly does NOT do". It states:
  the gate prints `suggestedTier` (size + risk floor, from `scripts/lib/classify-tier.mjs`)
  but the agent declares the tier (`write-trace.mjs --tier <1|2|3> --tier-reasoning ...`,
  `--eli16-path`/`--side-effects-path` for Tier-1); Tier-1 requirement set (ELI16 +
  side-effects, no pre-approved converged spec) vs Tier-2+ (the full chain); no-declared-tier
  → Tier-2 (back-compat); the Tier-1 auto-merge policy (clean Tier-1 on green CI + operator
  spot-check); the audit (`.instar/instar-dev-decisions.jsonl`, the loud `belowFloor`
  override). Cross-links **The Body and the Mind**. 9 added lines (Tier-1 by the very
  classifier it documents).

**Files changed (not in-scope for the commit gate):**
- `docs/STANDARDS-REGISTRY.md` — adds a concise **Tiered Development** standard in the
  **Building — engineering discipline** family (house format: Rule / Derives from / In
  practice / Earned from / Traces to the goal / Applied through), framed as deriving from
  **The Body and the Mind** (the gate informs, the agent decides, the decision is audited;
  formality scales with size AND risk).
- `docs/specs/tiered-dev-awareness-stepCD-spec.md` + `.eli16.md` — the design record.
- `upgrades/next/tiered-dev-awareness-stepCD.md` — the release fragment.

## The seven side-effects questions

1. **Over-block** — N/A. No filter, gate, or block is added or changed. This is prose.
2. **Under-block** — N/A. No detection logic. The Step-A audit's honest blind spot
   (heuristic-evasion is not flagged) is unchanged and already documented in the Step-A spec.
3. **Level-of-abstraction fit** — Correct layer. Awareness for the *developing* agent
   belongs in its skill (`/instar-dev`) and the constitution it is governed by, not in the
   end-agent CLAUDE.md template (a customer bot never runs the instar-dev gate). Confirmed
   against code (see Migration parity).
4. **Signal vs authority compliance** — Compliant, and the documented system *is* the
   canonical instance: the gate informs (signal), the agent decides (authority), the
   decision is audited. The docs add no authority of their own.
5. **Interactions** — None. The SKILL.md section sits beside the existing phases; it does
   not change any phase or the gate's behavior. The constitution entry derives from an
   existing standard (The Body and the Mind) whose "Applied through" already names the
   tier-classifier, so the cross-link is consistent both directions — no contradiction.
6. **External surfaces** — None visible to end users, other agents, or other systems. No
   runtime, no API, no timing or conversation-state dependency. Dev-facing docs only.
7. **Rollback cost** — Trivial. Revert two documentation edits + the artifacts. No deployed
   state to repair, no migration to unwind.

## Migration parity

**None needed — verified against code.** This is dev-tooling, not an agent-installed file.

- **`package.json` `files[]`** ships only `.claude/skills/{setup-wizard,secret-setup,autonomous,build}`.
  The top-level `skills/` directory (home of `skills/instar-dev/SKILL.md`) is **not** in
  `files[]`, so it is never published to npm or landed in an end-agent home.
- **`installBuiltinSkills()`** (`src/commands/init.ts`) installs a fixed end-agent allowlist
  (`evolve`, `learn`, `gaps`, `commit-action`, `feedback`, `triage-findings`, `reflect`,
  `coherence-audit`, `degradation-digest`, `state-integrity-check`, `memory-hygiene`,
  `guardian-pulse`, `session-continuity-check`, `git-sync`, `rollback-from-artifact`).
  `instar-dev` and `spec-converge` are **not** in it.
- **`generateClaudeMd()`** (`src/scaffold/templates.ts`) is **untouched** and the tiered
  process is absent from it today. The Agent-Awareness Standard it serves governs *end-agent*
  capabilities; the instar-dev commit gate is not one, so it correctly stays out.

Therefore **no `PostUpdateMigrator` / `migrateClaudeMd` change is required** — every changed
file is dev-repo-only (skill, constitution doc, spec) or a release artifact, and no
agent-installed file is touched. (Mirrors Step B's `/spec-converge` migration-parity
conclusion.)

## Tests / lint

`npx tsc --noEmit` exit 0 (no TS changed); `npm run lint` green. No runtime behavior changed,
so no new unit/integration/E2E tests — the SKILL.md section was verified for accuracy against
the live gate (`scripts/instar-dev-precommit.js` Steps 3.5/4.5/4.6 + `classify-tier.mjs`).
