# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**fix(monitoring): native-module heal failures now surface on the DegradationReporter alert path.**
`NativeModuleHealer` already rebuilds better-sqlite3 when a NODE_MODULE_VERSION
mismatch breaks `SemanticMemory` / `TopicMemory` / `MemoryIndex` / `TokenLedger`,
but a *failed* rebuild only landed in `<stateDir>/native-module-heals.jsonl`
and a `console.error` line — the agent then silently ran with the affected
feature unavailable and no Telegram alert ever fired. The healer's own jsdoc
already named `DegradationReporter` as a consumer ("consumed by health checks
and DegradationReporter") but no consumer was wired. This PR adds the missing
bridge: a tiny `onHealEvent(listener)` registration surface on the healer
and a `NativeHealDegradationBridge` subscriber wired in `AgentServer` boot
that translates failure events into `DegradationReporter.report(...)` calls
with component-specific impact lines (per-component dedupe; success events
intentionally silent). No change to the heal path itself, no change to the
jsonl log, no new dependencies.

## Evidence

Prior to this PR, `src/memory/NativeModuleHealer.ts` writes a `HealEvent`
row to `<stateDir>/native-module-heals.jsonl` and `console.error`s on
failure, but `grep -rn "DegradationReporter\|degradation"` against
`src/memory/NativeModuleHealer.ts` and
`src/remediation/runbooks/node-abi-mismatch.ts` returns zero call sites
— the heal-failure event never reached the existing Telegram alert path.
After this PR, nine new unit tests in
`tests/unit/NativeHealDegradationBridge.test.ts` pin the wiring (reports
on failure, silent on success, dedupes per component, returns an
unsubscribe handle that detaches the listener, swallows listener errors,
and exercises `NativeModuleHealer.onHealEvent` through the real
`healBetterSqlite3Sync` early-exit path with a mocked install-prefix
resolver) and `AgentServer` calls `bridgeNativeHealToDegradation()` next
to the existing `NativeModuleHealer.configure(...)` call so every
server boot gets the subscriber. Pre-existing `NativeModuleHealer`
(17 tests) and `degradation-reporter*` (22 tests) suites pass
unchanged.

Spec: `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (DegradationReporter
is the v1 signal producer per §A28 / §A33; this PR adds the missing
emit-site for heal-failure events the W-1 runbook already implied).
Side-effects review:
`upgrades/side-effects/native-heal-degradation-bridge.md` with
second-pass independent audit appended (concurred).

## What to Tell Your User

- "When the agent's database driver gets out of sync with your Node version and can't repair itself, you now get a Telegram alert telling you what broke. Previously the agent quietly kept running with persistent memory turned off and you only found out by noticing things weren't sticking."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Native-module heal failures alert the user | Automatic. `AgentServer` wires `NativeHealDegradationBridge` at boot; any `NativeModuleHealer` rebuild that fails surfaces as a `DegradationReporter` event (Telegram alert via the agent-attention path, structured row in `<stateDir>/degradations.json`). Success heals stay silent. |
| `NativeModuleHealer.onHealEvent(listener)` | New public registration point on the healer singleton — listener fires after every persisted heal event. Returns an unsubscribe function. Errors thrown by a listener are swallowed so observability cannot break the heal path. |
