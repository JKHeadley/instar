# Side-Effects Review: C4 — canary live-config drift detector + B1 runtime-verified

## Change
1. **C4** — new `checkInstalledCodexHookTrust(projectDir, codexHome?)` in codexHookContractCanary.ts:
   reads the ACTUAL installed `.codex/hooks.json` + `$CODEX_HOME/config.toml [hooks.state]` (reusing
   codexHookTrust) and reports `ok` / `drift` / `skip` — asserting the Stop review trio is present
   AND every instar slot is trusted (not enabled=false), and that deferral-detector is NOT on Stop.
   Layer A asserts the BUILDER output; Layer C catches reality drifting (clobbered hooks.json,
   dark/untrusted agent, user-disabled guard). Runtime/per-agent (skip when no hooks.json).
2. **B1** — spec updated: response-review/claim-intercept Codex Stop-payload is now RUNTIME-VERIFIED
   (captured a real Codex 0.133 Stop payload; `last_assistant_message` held the exact reply). No code.

## Why
Convergence review §7 C4 + B1. C4 makes the drift-alarm check reality, not just the blueprint —
the reviewer's point that a hardcoded-trio assertion would encode the next drift as correct. B1
closes the schema≠runtime gap for the two Stop review-checkers.

## Scope / blast radius
- C4 is a new read-only function (no mutation); reuses codexHookTrust (pure). Imported at top
  (no lazy require — that broke under the ESM test runner). Not yet wired into a scheduled health
  check — it's a building block a runtime caller (G5 arming canary / health) can use. RULE 3:
  the canary module already carries a Rule 3.1 rationale; this extends it (read-only config parse).
- B1: docs-only (spec status update).

## Signal vs Authority / Rollback
- Read-only check, no authority. Rollback: remove the function + tests + revert the spec line.

## Tests
- codexHookContractCanary.test.ts: +5 (skip/drift-untrusted/ok/disabled/clobbered-trio). 11 green.
  installCodexHooks + codexHookTrust unaffected. tsc clean.

## Publish
- PR to JKHeadley/main (codex-parity-followups). Squash-merge.
