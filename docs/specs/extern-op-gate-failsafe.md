---
title: External Operation Gate — fail-safe classification on unknown input
slug: extern-op-gate-failsafe
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-self-review-2026-05-31 + independent adversarial security review (verdict SOUND, concurred)
approved: true
parent-principle: "Signal vs. Authority"
approved-by: Echo under the 12h autonomous deploy mandate (self-approved; flagged in PR). Surfaced by the codex mentee (Codey) during the live mentorship loop — exactly the "drive Codey → find real issues → fix as fleet PR" mandate.
approval-note: >
  computeRiskLevel fell through to 'low' (which maps to the 'proceed' action)
  for any UNRECOGNIZED mutability / reversibility / scope, so an operation the
  gate cannot classify BYPASSED the gate (fail-open). It is reachable from
  untyped runtime boundaries (POST /operations/evaluate and the
  external-operation-gate PreToolUse hook), where the three dimensions arrive as
  arbitrary strings despite the TypeScript enum types. Now fails CLOSED:
  unrecognized mutability → critical (→ show-plan/approve), unknown
  reversibility → irreversible, unknown scope → bulk. Independently
  adversarially reviewed: SOUND — no valid (known-enum) input is reclassified,
  and 'critical' is the correct severity (no autonomy profile maps it to proceed).
second-pass-required: true
second-pass-status: concurred — independent adversarial security review returned verdict SOUND. It also surfaced the SYMMETRIC hook-layer fail-open (the hook's verb-classifier defaults unrecognized action verbs to 'read' → fast-exits with no gate call); that mirror gap is tracked as issue-628 (a coupled hook PR). <!-- tracked: issue-628 -->
eli16-overview: extern-op-gate-failsafe.eli16.md
---

# External Operation Gate — fail-safe classification on unknown input

## The bug, grounded (found by the codex mentee, Codey)

During the live mentorship loop, Codey (the codex mentee agent) audited the
External Operation Gate and surfaced two real issues. This PR fixes the
higher-value one: a **fail-open** in the static risk classifier.

`computeRiskLevel(mutability, reversibility, scope)` (`src/core/ExternalOperationGate.ts`)
is the gate's static classification layer (born from the OpenClaw incident where
an agent deleted 200+ emails autonomously). Its risk matrix handles the known
combinations, then ends with a permissive `return 'low'` for "single reversible
writes/modifies". The problem: that bottom `return 'low'` is also the fall-through
for **unrecognized** input. An operation whose `mutability` (or
`reversibility`/`scope`) is not one of the known enum values is not caught by any
explicit case and falls through to `'low'` → which maps to the `proceed` action →
the operation **bypasses the gate**.

This is reachable in production: `computeRiskLevel` runs on input from **untyped
runtime boundaries** — `POST /operations/evaluate` (raw JSON, cast with `as`) and
the `external-operation-gate.js` PreToolUse hook. The TypeScript enum types are
NOT enforced at runtime, so a malformed, novel, or adversarial `mutability` value
(e.g. `"execute"`, `"force_delete"`, `""`, `undefined`) classified as `low` and
auto-proceeds. For a *safety* gate, failing open on the exact case it cannot
classify is the worst failure mode.

## Fix

Add a fail-safe guard at the top of `computeRiskLevel`, before any matrix logic:

```ts
const KNOWN_MUTABILITY = ['read', 'write', 'modify', 'delete'];
const KNOWN_REVERSIBILITY = ['reversible', 'partially-reversible', 'irreversible'];
const KNOWN_SCOPE = ['single', 'batch', 'bulk'];
if (!KNOWN_MUTABILITY.includes(mutability)) return 'critical';
if (!KNOWN_REVERSIBILITY.includes(reversibility)) reversibility = 'irreversible';
if (!KNOWN_SCOPE.includes(scope)) scope = 'bulk';
```

- An operation whose **type** we cannot classify (`mutability`) is treated as
  maximally dangerous → `critical`. Critical maps (across all three shipped
  autonomy profiles) to `approve` (→ `show-plan`, surface to the human) or, in
  the supervised profile, `block` — **never** `proceed`/`log`. So an
  unclassifiable operation can never auto-proceed, and is not silently dropped
  either (the user is asked).
- Unknown **risk-modifiers** (`reversibility`, `scope`) are pinned to their most
  dangerous valid value (`irreversible`, `bulk`), so the existing matrix computes
  a conservative — never under-stated — risk.
- The `read` fast-path (reads are always low) is preserved: `read` is a known
  mutability, so it passes the guard and short-circuits to `low` as before.

## Safety / why it's correct

- **No valid input is reclassified.** For all 4×3×3 = 36 valid enum combinations,
  every guard is a no-op and execution reaches the original matrix byte-for-byte
  unchanged. Locked in by a "valid-input classifications unchanged" test.
- **`critical` is the right level**, not over-conservative: `high` would have been
  *weaker* (the autonomous profile maps `high → log → proceed`), which would have
  left a residual auto-proceed for unknown ops. `critical` is the only level that
  never auto-proceeds in any profile.
- **Independently adversarially reviewed** (verdict: SOUND). The reviewer walked
  the full matrix + the evaluate()/classify() pipeline + the autonomy profiles +
  the HTTP route and confirmed: no surviving fail-open-to-low for unclassifiable
  input, no valid input perturbed, correct severity, and `Array.includes` is safe
  on `undefined`/`null`/non-string (returns false → fail-closed).

## Known related gap (hook layer, tracked as issue-628) <!-- tracked: issue-628 -->

The adversarial review surfaced the **symmetric** fail-open one layer up: the
`external-operation-gate.js` hook classifies `mutability` by prefix-matching known
destructive verbs and **defaults everything else to `read`** (then fast-exits with
no gate call). So a destructive MCP verb that doesn't prefix-match (e.g.
`force_delete_all`, `expunge`, `wipe`, `truncate`, `revoke`) is classified `read`
and never reaches the gate. That is the same class, in the primary path, and is
fixed in a coupled hook PR, tracked as issue-628 (read-verb allowlist + unknown
verb → `modify`, with migration parity for the installed hook). <!-- tracked: issue-628 --> This server-side fix is
defense-in-depth that also closes the HTTP-boundary path.

## Migration parity

N/A — code-only, compiled into `dist`; ships in the normal release. No
agent-installed file / config / template change. (The hook PR, issue-628, DOES need
migration parity — the hook is a built-in always-overwritten file.) <!-- tracked: issue-628 -->

## Agent Awareness

N/A — internal gate-classifier hardening; no new endpoint or capability.

## Test plan

Unit (`tests/unit/ExternalOperationGate.test.ts`, +5 cases):
- unknown `mutability` (`'execute'`, `''`, `'purge-everything'`, `undefined`) → `critical` (each was `low` pre-fix).
- unknown `reversibility` → pinned to irreversible (write→medium, delete→high; each was lower pre-fix).
- unknown `scope` → pinned to bulk (→critical; was low pre-fix).
- `read` stays `low` even with unknown reversibility/scope (read is inherently safe).
- a spot-check that valid-input classifications are unchanged.

The existing 12 known-input matrix tests stay green (the guards are no-ops for valid input). `tsc --noEmit` clean; `npm run lint` (all custom rules) clean.
