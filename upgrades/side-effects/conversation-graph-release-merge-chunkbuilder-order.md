# Side-effects: AgentServer option order after the main merge

## Summary

The main merge in 719a16366 combined both sides of the long `const server = new AgentServer({...})` line in `src/commands/server.ts`. Main had added `chunkBuilder: _chunkBuilder ?? undefined`, and the merge put it last in the object. The e2e wiring check in `tests/e2e/context-layer-chunks-alive.test.ts` looks for the text `chunkBuilder: _chunkBuilder ?? undefined,` (with a comma), so Local Verify on the M5 failed that one test (4,067 e2e tests, 1 failed; unit and integration all passed). This change swaps it with the option before it, so the same options are passed in a different order. Behaviour does not change: object property order has no effect on AgentServer.

## 1. Over-block
No issue identified.

## 2. Under-block
No issue identified.

## 3. Level-of-abstraction fit
Merge repair only; same options, same values.

## 4. Signal vs authority compliance
No authority changes.

## 5. Interactions
None. AgentServer reads options by name.

## 6. External surfaces
None.

## 7. Multi-machine posture
Not applicable.

## 8. Rollback cost
Revert the commit.

## Class-Closure Declaration
Defect class: n/a. Closure: n/a.

## Evidence
- Local Verify on the M5 for 719a16366: `failedFiles: ["tests/e2e/context-layer-chunks-alive.test.ts"]`, all other lanes green.
- After the swap, `grep -c 'chunkBuilder: _chunkBuilder ?? undefined,' src/commands/server.ts` is 1 and the type check is clean.

## Second-pass review
Not required: option reorder inside one object literal, no behaviour change.
