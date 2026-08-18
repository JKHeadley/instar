# Exact population assertions for phase acceptance

## What Changed

Phase acceptance manifests can now require a versioned JSON document and exact typed field values. The Codex parity CLI exposes its existing typed results as a summary containing total, passed, failed, and skipped counts. Phase 4 uses that structured contract instead of matching `0 fail` as a floating substring, and its Vitest commands disable their results cache.

The parity manifest also uses the repository-pinned `vite-node` entry rather than the undeclared `npx tsx` runtime.

## Evidence

- The pre-repair checker accepted an exit-zero runner whose complete output was `10 fail`.
- Marker-backed controls reject `10 fail`, reject one structured failure despite exit zero, reject zero scenarios despite exit zero, and accept exactly seven all-passed scenarios.
- The real structural parity CLI emits seven accounted results: five passed, zero failed, and two skipped.
- TypeScript, syntax checks, patch hygiene, the focused controls, and the Phase 4 structural acceptance path pass.

## What to Tell Your User

No user action is required. This strengthens an internal release-acceptance assertion.

## Summary of New Capabilities

Phase acceptance gates can assert exact machine-readable result populations instead of relying on ambiguous output substrings.
