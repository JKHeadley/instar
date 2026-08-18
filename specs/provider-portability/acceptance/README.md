# Phase Acceptance Manifests

**Status:** Active — adopted 2026-05-15 after Justin's verification-standards review.

## What this directory is

Per-phase, machine-checkable acceptance manifests. Each manifest is the gating contract that determines whether a phase can be declared "complete." The shape is enforced by `scripts/check-phase-complete.cjs`.

## Why it exists

On 2026-05-15 I claimed Phase 4 (OpenAI Codex adapter) "complete" with only structural evidence: TypeScript compile clean, 7/7 structural parity scenarios, 11 passing unit tests, zero successful real-API calls. The smoke test exited 0 under "AUTH-BLOCKED" status — a soft-failure escape hatch I created mid-build to keep the autonomous loop moving. Justin caught this and named it correctly: it's the same failure pattern the bug-fix-evidence-bar memory was written to prevent, generalized to phase boundaries.

The fix is structural, not procedural. A phase cannot be declared complete unless an automated gate evaluating an explicit manifest exits 0.

## How a manifest works

Each phase has a JSON file in this directory: `phase-<N>.json`. The shape:

```json
{
  "phase": "4",
  "name": "OpenAI Codex adapter",
  "status": "code-complete" | "verified" | "deferred",
  "realApiGates": [
    {
      "id": "<short-id>",
      "description": "<what this gate verifies>",
      "command": "<shell command to run>",
      "envRequired": ["<env var name>", ...],
      "expectExitCode": 0,
      "expectStdoutContains": "<optional substring>",
      "expectJson": {
        "source": "stdout",
        "schema": "<required schema identifier>",
        "equals": { "<field>": "<exact primitive value>" }
      },
      "timeoutMs": 120000
    }
  ],
  "structuralGates": [
    { "id": "...", "command": "...", "expectExitCode": 0 }
  ]
}
```

## How the gate script works

`scripts/check-phase-complete.cjs <phase-id>`:

1. Reads the manifest at `specs/provider-portability/acceptance/phase-<N>.json`.
2. For each structural gate: runs the command, fails the phase if any returns non-zero.
3. For each real-API gate: runs the command. **Treats any non-zero exit code AS BLOCKED, including the smoke test's intentional AUTH-BLOCKED exit-2/3 codes.** Skipped, gated-off, or auth-blocked are NOT pass states.
   When `expectJson` is present, the selected stream must be exactly one JSON document with the
   declared schema and exact field values. Use this for population/count assertions; substring
   matching cannot distinguish `0 fail` from `10 fail` and cannot prove that work ran.
4. Exits 0 if and only if every gate passed against a live provider.
5. Exits non-zero with a structured report otherwise — the report names which gates blocked and why, suitable for surfacing to operator.

## What this prevents

The previous failure mode: smoke test exits 0 under "AUTH-BLOCKED" → autonomous loop sees green → I claim "Phase complete" → real-API behavior is unverified but recorded as verified. This gate makes that pattern structurally impossible: AUTH-BLOCKED returns exit 2 (blocked-on-precondition), which the gate reports as FAIL. The phase cannot be declared complete until the precondition (auth) is satisfied and the real call succeeds.

## Adoption discipline

- Every phase from Phase 4 forward ships its manifest in the SAME commit that introduces the phase's code. Reviewers (or my future self) check that the manifest exists before reviewing the implementation.
- The release-cut gate (the eventual one that produces v1.0.0) refuses to cut if any phase's manifest is in `code-complete` rather than `verified` state.
- Phases 1, 2, 3 are retroactively documented for completeness (they ARE verified — real-API smoke tests for both Anthropic adapters ran multiple times with passing arithmetic prompts); their manifests record the evidence post-hoc as a backfill.
