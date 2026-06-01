---
title: "Tier classifier + Tier-1 PR path (Step A of the tiered development process)"
date: 2026-06-01
author: echo
review-convergence: pending
approved: false
eli16-overview: tier-classifier-and-tier1-path-spec.eli16.md
---

# Tier classifier + Tier-1 PR path (Step A)

> **Status:** Step A of the **Tiered Development Process** project
> (`docs/projects/tiered-dev-process/PROJECT.md`, project shape approved by Justin
> 2026-06-01). This is a Tier-2 change: it needs spec-review-convergence and Justin's
> approval before build. `review-convergence` and `approved` are intentionally not yet
> set — they flip when convergence runs and Justin approves.

## Goal

Teach the instar-dev commit gate (`scripts/instar-dev-precommit.js`) to (1) **compute a
tier signal** from a staged change and **surface it**, (2) let the agent **declare the
tier** (informed by the signal) and **record** signal + choice + reasoning to an audit
trail, and (3) enforce the **chosen tier's** requirement set — adding a **Tier-1 path**
where a small/low-risk change may commit with an ELI16 + side-effects + tests/lint and
**no pre-approved converged spec**.

This is the first executable instance of the constitution's **The Body and the Mind**
(The Substrate): the gate (body) **informs**; the agent (mind) **decides**; the decision
is **audited**. It deliberately does **not** make the gate decide the tier — an earlier
draft of the parent project proposed exactly that and was caught as unconstitutional.

## Current behavior (what Step A modifies)

`instar-dev-precommit.js` today applies ONE requirement set to **every** in-scope staged
change (`src/`, `scripts/`, `.husky/`, `skills/*`): a fresh trace (`phase: complete`,
`coveredFiles ⊇` staged in-scope) → a side-effects artifact (staged, sha-matched) → a
`specPath` whose spec carries `review-convergence` + `approved: true` → an ELI16 overview.
There is no notion of size, risk, or tier; a one-line observability fix pays the same
cost as a new subsystem (the friction this project removes).

## Design

### 1. The tier signal (computed by the gate, surfaced, never authoritative)

A pure function `classifyTier(stagedInScopeFiles, diffStat, repoRoot)` returns
`{ suggestedTier: 1|2|3, sizeTier, riskFloor, reasons: string[] }`:

- **Size** → a base tier. `sizeTier = 1` when in-scope additions+deletions ≤ `SIZE_LOC`
  (default 40) across ≤ `SIZE_FILES` (default 3); else `2`. (Tunable constants.)
- **Risk floor** → may only *raise*, never lower, the tier. Risk signals (each emits a
  reason string):
  - **Safety-invariant proximity** — staged path or hunk matches a configured
    invariant-bearing set: SecretDrop (`*secret*`, never-on-disk), the relay/delivery
    path (`*Relay*`, `*Telegram*Adapter*`, delivery-robustness), auth/tokens
    (`*auth*`, `*token*`), the destructive-op funnels (`SafeFsExecutor`,
    `SafeGitExecutor`, `SourceTreeGuard`), the session lifecycle/reaper. → `riskFloor ≥ 2`.
  - **Irreversibility** — touches a migration, a data-format/schema, or a
    `PostUpdateMigrator` path. → `riskFloor ≥ 2`.
  - **New capability** — adds a new route, a new exported subsystem/class, or a new
    config surface (heuristic: net-new `router.<verb>(` / `export class ` / config key).
    → `riskFloor ≥ 2`.
- `suggestedTier = max(sizeTier, riskFloor)`. Tier **3** is never auto-suggested — it is
  *declared* when a change is a step of an approved project (the project is what is
  Tier-3; its step-specs are Tier-2 each).

The gate **prints** `suggestedTier` + every reason. This is signal only.

### 2. The agent's declaration (the mind decides) — via the trace

The agent records its decision in the trace JSON (the gate already reads a fresh trace):
- `tier: 1|2|3` — the agent's **chosen** tier.
- `tierReasoning: string` — why (one or two sentences).
- For **Tier 1**: `eli16Path` + `sideEffectsPath` (no `specPath`).
- For **Tier 2+**: the existing `specPath` (+ `artifactPath`/`artifactSha256`) as today.

**No trace, or no `tier` field → default to Tier 2** (today's full requirement set). This
makes the change strictly additive and back-compatible: an unaware caller behaves exactly
as before.

### 3. Enforcement (the chosen tier's requirement set)

- **Tier 1:** require a staged ELI16 (the "request" ELI16) + a staged side-effects
  artifact (sha-matched, as today) + the project's tests/lint pass. **No converged
  approved spec.** The PR is the review surface (and, per the Tier-1 merge policy,
  auto-merges on green CI with operator spot-check — out of scope for *this* gate, which
  governs the commit, not the merge).
- **Tier 2 / 3-step:** the **current** requirement set unchanged (fresh trace +
  coveredFiles superset + staged sha-matched artifact + `specPath` with
  `review-convergence` + `approved: true` + ELI16). A Tier-3 *project step* is a Tier-2
  spec; nothing new is enforced for "Tier 3" at the gate.

### 4. The audit (closes the loop — what makes "the mind decides" safe)

On every in-scope commit the gate appends one JSON line to
`.instar/instar-dev-decisions.jsonl`: `{ ts, slug, suggestedTier, declaredTier,
riskFloorReasons, belowFloor: boolean, files, loc }`. When `declaredTier < riskFloor`
(the agent chose under the risk-signaled floor), the gate **prints a loud notice and
records `belowFloor: true`** — it does **not** block (the mind holds authority), but the
override is now a visible, reviewable record. This is the audit trail the constitution
requires; a later step may surface `belowFloor` overrides for operator review.

## Safety / blast radius

Additive and back-compatible: with no `tier` declaration the gate enforces exactly
today's Tier-2 requirement set, so every existing flow is unchanged. The **only**
relaxation is the new Tier-1 path, and it still requires ELI16 + side-effects + green
tests/lint — it drops only the *pre-approved converged spec*. The risk floor is a loud,
audited signal, not a silent auto-downgrade. The classifier is pure and unit-testable;
the gate's existing checks are untouched for Tier-2+.

## Testing

- **Unit (`classifyTier`):** size→tier boundaries (≤/> SIZE_LOC, SIZE_FILES);
  each risk signal raises the floor (a 1-line change touching a `*secret*` path →
  suggested Tier 2); `max(size, risk)`; Tier-3 never auto-suggested.
- **Unit (gate enforcement):** Tier-1 trace (ELI16 + side-effects, no spec) → commit
  allowed; Tier-1 trace missing ELI16 → blocked; no `tier` field → Tier-2 requirement
  set enforced (back-compat); `declaredTier < riskFloor` → `belowFloor:true` recorded +
  not blocked; Tier-2 path unchanged (existing tests stay green).
- **Audit:** a commit appends exactly one well-formed `instar-dev-decisions.jsonl` line.

## Migration parity

`instar-dev-precommit.js` is the gate for agents *developing instar*; it ships in the
instar repo, not installed into arbitrary agent homes by `init`. No `PostUpdateMigrator`
change is required for end agents. The instar-dev skill (Step C) documents the new tier
declaration so the developing agent knows to set it.

## Out of scope (later steps)

Tier-1 PR **auto-merge** policy (the merge, not the commit — config + CI wiring); the
codex-CLI cross-model review (Step B); the skill/docs/CLAUDE.md-template awareness
(Step C); migration of any deployed gate (Step D). Per the project breakdown.
