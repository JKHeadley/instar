# Structured Codex smoke acceptance

<!-- bump: patch -->

## What Changed

Phase 4's live Codex smoke gate now consumes a versioned JSON result with an exact passed status
and an explicit non-empty-response fact. It no longer decides acceptance by searching human output
for the word `PASSED`. The ordinary developer command keeps its existing readable progress and
success text; only the automation contract changes.

The smoke process also sets its exit code and lets Node drain stdout and stderr naturally instead
of forcing an immediate process exit after writing. This keeps the machine result and diagnostics
intact when their streams are redirected. Missing or rejected credentials, evaluation errors,
empty provider output, malformed or non-success JSON, and non-zero process exits remain
fail-closed.

## Evidence

- Against the old checker at runner exit zero, the original `PASSED` sentence was accepted while a
  cosmetically reworded success sentence was rejected. The process outcome was identical.
- Marker-backed controls now reject legacy prose at exit zero, reject a structured non-success at
  exit zero, reject a valid-looking receipt at non-zero exit, and accept only the exact structured
  success result.
- Child-process controls observed the complete JSON result on stdout and diagnostics on stderr
  before natural exit. The finished no-credential CLI emitted both refusal diagnostics, no success
  result, and exit 2.
- A production-manifest control reads the real Phase 4 gate and requires JSON mode, the exact schema
  and fields, and removal of the legacy text assertion. The focused suites passed 13 tests and the
  TypeScript no-emit check passed.
- This repair made no live provider call and does not refresh the manifest's historical live-API
  evidence.

## What to Tell Your User

No action is required. The internal Codex release check now reads a clear machine result instead of
depending on one display word, so harmless wording changes cannot block an otherwise valid smoke
run. Credential, provider, empty-response, and process failures still stop acceptance.

## Summary of New Capabilities

| Capability | How to Use |
| --- | --- |
| Consistent Codex smoke acceptance | Automatic during Phase 4 verification; the gate checks a structured non-empty-response result together with the process outcome. |
