# Development decision records now retain their work-item identity

## What Changed

The canonical development trace writer now stores the same work-item identity inside the trace that it already uses in the trace filename. The commit gate also derives that identity from the bound review artifact for older traces and records the exact staged source files plus added/deleted-line basis behind its compact file and line counters.

## Evidence

- Trace-writer and commit-gate focused suites pass together.
- A legacy-shaped trace without an explicit identity is correctly bound from its side-effects artifact.
- Decision records expose both their compact counters and the concrete scope used to compute them.

## What to Tell Your User

Internal development audit records are now easier to trace back to the reviewed change and explain exactly what their size counters measured.

## Summary of New Capabilities

- Stable, self-describing development decision evidence across current and legacy trace shapes.
