# Side-effects: conversation inventory follows the graph runtime

## Summary

A removal replaces the graph runtime while the server keeps running. The inventory worker stayed on the old, stopped runtime, so "Some original history is unavailable" stayed on until the next restart. A real Studio and M5 pair with Echo's development setting showed this after a dashboard removal. `GraphSourceInventoryBinding` now keeps one worker on the runtime in use: the old worker finishes, then the replacement starts on the new runtime.

Decision point: none. The worker records observations; the read still decides whether history is partial.

## 1. Over-block
No issue identified. Nothing is refused that was accepted before. The repeat call for the same runtime stays a no-op.

## 2. Under-block
If the old worker's close never returned, the replacement would not start and the warning would stay on, which is the earlier behavior and stays honest. The warning keeps saying coverage is partial; nothing claims completeness.

## 3. Level-of-abstraction fit
`onRuntime` already fires when the surface mounts a new runtime. The worker's life belongs at that point, so the fix sits in the server's start function and a small class that can be tested alone.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: no blocking authority added. The worker produces evidence for an existing read.

## 5. Interactions
Old and new workers never write together. A new worker has an empty committed-row memo, so it observes each conversation once more. These are idempotent observations, the same as after a restart. Server shutdown waits for any opening worker and starts nothing afterwards.

## 6. External surfaces
The warning clears about a minute after a removal instead of at the next restart. No route or wire change.

## 7. Multi-machine posture
Machine-local by design: each machine runs its own worker for its own conversations and replicates through the graph as before.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: n/a. One worker per runtime, started only by a runtime replacement; no new trigger or loop.

## Evidence
Before: warning still on five minutes after a removal, cleared by restart. After: same real pair, removal through the dashboard at phone size, warning cleared within about a minute, stayed clear, and the page loaded at phone and desktop size with no errors. Unit: `tests/unit/graph-source-inventory-binding.test.ts`, six cases.

## Second-pass review
Not required: one small lifecycle helper for a background observer; no session, gate or message decision touched.

The failure path keeps the @silent-fallback-ok marker from the code it replaced: the caller reports the failure.
