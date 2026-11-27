# Side-Effects Review — Cartographer startup file I/O

**Version / slug:** `cartographer-boot-scaffold-io`
**Date:** 2026-11-27
**Author:** Echo
**Second-pass reviewer:** Independent Cartographer build reviewer.

## Summary of the change

Cartographer's startup refresh reads and atomically replaces individual node files through asynchronous filesystem operations. A tree shares an in-progress scaffold with its inline summary route so that a summary saved through the route cannot be overwritten by the same refresh.

## Decision-point inventory

The startup scaffold shares one active operation per tree. Inline summary requests return a retryable HTTP 503 while that operation is active. The existing authorization, validation and rate-limit decisions still apply.

## 1. Over-block

An authenticated inline summary request can receive a retryable HTTP 503 during startup. The response includes Retry-After and makes no write. Read and health routes can continue to answer.

## 2. Under-block

The change addresses the synchronous node operations measured in the incident profile. A slow directory traversal or final index publication still has synchronous operations and requires its own measurement. The profile started after the listen queue drained and does not identify the callback behind the earlier Laptop timeout.

## 3. Level-of-abstraction fit

The tree owns its in-process writer order. The route checks the tree before applying the existing summary validation and mutation. The sweep already waits for boot population.

## 4. Signal vs authority compliance

The writer ordering enforces a filesystem consistency invariant. It uses the active operation itself as evidence and leaves user authority in the existing authenticated route. See [Signal vs Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

There is no new heuristic at a decision with competing signals. The in-progress promise identifies a specific writer in the same process.

## 5. Interactions

Node publication remains atomic. Each async write has a unique temporary path. The inline author reads the node only when the scaffold is idle and then validates and writes without yielding. The authority is resolved and applied in that same request. The existing rate limit applies when an attempt proceeds. An unsuccessful scaffold is reported by the boot logger and clears the busy state. Independent filesystem actors still follow the existing cache ownership contract.

## 6. External surfaces

During startup the inline API can return HTTP 503 with Retry-After. The success response and validation remain the same. File names, contents and formats remain compatible with the existing cache reader. There is no external network call.

## 6b. Operator-surface quality

There is no operator-facing screen or approval action.

## 7. Multi-machine posture

Machine-local by design. Each machine builds the cache from its own verified checkout and serializes writers to that cache in its own server. No notice, URL, topic transfer state or status response changes.

## 8. Rollback cost

Revert the code and release a patch. Node and index formats are compatible. A normal restart rebuilds the cache from the verified checkout if needed.

## Conclusion

The review added per-tree writer ordering after identifying the inline authoring race. A route test holds active scaffolding, verifies the retry response, and then verifies an authenticated summary write after completion. Independent review concurred. Compiled verification still gates publication.

## Independent review

Concur. The synchronous refresh route at `src/server/routes.ts:11454` preserves authorization and writer ordering. The single-flight marker clears for success and failure at `src/core/CartographerTree.ts:343`. Per-node replacement is atomic at `src/core/CartographerTree.ts:433`. The retry and successful write are covered at `tests/integration/cartographer-refresh-route.test.ts:171`. The existing synchronous enumeration, pruning, and index synchronization remain measurable limits, and fleet-scale startup duration still needs qualification.
