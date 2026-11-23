# Side-Effects Review — Secret Drop Consume After Persistence Opt-Out

**Slug:** secret-drop-consume-persistence
**Date:** 2026-11-22
**Author:** Instar Agent (echo)
**Second-pass reviewer:** /root — independent source, tests and artifact review concurred

## Summary

Repair the approved Secret Drop store-first invariant: successful consume cleans both memory and an existing encrypted copy. The current persistDrops flag still controls new writes and fallback reads; it no longer exempts cleanup of an earlier stored copy. SecretStore.deleteIfStoreExists skips only actual ENOENT and avoids generating storage or keys for a never-persisted submission. Existing corrupt/unreadable/write failures propagate into the route's existing503 response before memory consumption. Browser passwords remain on their established never-stored path.

Authorization: Chief handoff d2cef5cc-5f53-4f73-b0c3-89f0a2af2857. Governing approved/converged spec: docs/specs/secret-drop-store-first.md, consume-cleans-both. This is separate from the stopped native Secret Drop/owner-decision feature designs. No new native target, tombstone, approval or context registry.

## Decision-point inventory

- Existing consume cleanup — modified: current write-policy opt-out no longer bypasses deletion of prior stored data.
- Stored-file absence — factual ENOENT bypass only; permission, malformed storage and write errors refuse through the existing route.
- Existing explicit consume query, bearer access, browser exception and fallback read policy — passed through unchanged.

## 1. Over-block

With persistence off, a corrupt/unreadable existing vault now refuses non-browser consumption because the route cannot establish that its stored copy was deleted. Memory remains retrievable and retryable. This is required by the approved consume-cleans-both invariant. Absent storage succeeds without a new vault/key. No message-content filtering.

## 2. Under-block

No new uncertainty is silently treated as deletion success. This repair retains the existing SecretStore atomic replacement semantics; it does not add a power-loss durability barrier or a new discard transaction. Three capped native feature lanes remain stopped under topic144636; this repair does not claim to implement them. No additional issue identified within the narrow policy-toggle defect.

## 3. Level-of-abstraction fit

SecretStore owns its configured storage path and distinguishes absent storage from actual errors. The existing retrieval route owns consume-before-memory order and its established503 error. No duplicated hard-coded vault path or parallel approval authority.

## 4. Signal vs authority compliance

Reference: [Signal vs Authority](../../docs/signal-vs-authority.md). No heuristic authority is introduced. Successful explicit consume requires factual removal/absence of an existing copy under the approved deterministic one-time retrieval contract; the new method does not inspect message meaning or choose an owner.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Storage success, ENOENT and thrown errors are enumerable filesystem outcomes.

## 5. Interactions

Cleanup remains synchronous from peek through delete and memory consume. Existing delete exceptions refuse503 and preserve retry. persistDrops=false continues preventing new durable writes and fallback reads. Browser passwords still never touch the vault. Unrelated encrypted credentials survive selected-key deletion. No session/dispatch/controller changes.

## 6. External surfaces

The existing route now refuses a consume whose prior stored copy cannot be deleted even after persistence was disabled. The response remains the same503 wording without bearer token or secret values. No new API, permission, device path or agent-facing feature; existing awareness already teaches explicit consume and secure storage.

## 6b. Operator-surface quality

No new operator surface. Existing503 wording says the stored copy could not be removed, nothing was consumed and the caller can retry. The successful consume response and existing caller retry behavior are unchanged. No UI redesign, new choice, unexplained label or approval prompt.

## 7. Multi-machine posture

Machine-local BY DESIGN: Secret Drop values and their encrypted storage stay on the receiving machine. This repair deletes only the serving machine's existing local copy; it creates no synchronization, remote forwarding, URLs or notifications. No status/health/capabilities/channels surface changes.

## 8. Rollback cost

Revert the two source changes in a patch. No schema, config default, installed file or migration. Reverting restores the defect for future policy-toggle consumes; already consumed copies are intentionally unrecoverable. No live state manipulation occurs in this work.

## Conclusion

The targeted regression failed before the repair: after persistence was disabled, consume succeeded but restart recovered the supposedly consumed value. Focused unit5, route13 and real AgentServer lifecycle3 checks passed and verify absence, deletion failures, unchanged fallback policy and no resurrection. Full verification remains the shared verifier's responsibility; no full-green claim is made here.

## Second-pass review

Reviewer /root independently read source, tests and this artifact and concurred. Verified ENOENT-only absence, no constructor key/vault creation, propagation before memory consume, unchanged auth/fallback/write policy/browser exception, actual vault/route/restart tests and preservation of unrelated credentials. Parent required the operator-surface quality section, now included. Existing atomic replacement semantics remain; no power-loss or native-feature claim.

## Evidence pointers

- Unit: tests/unit/secret-store-existing-copy-delete.test.ts.
- HTTP: tests/integration/secret-drop-store-first.test.ts.
- Production lifecycle: tests/e2e/secret-drop-store-first-lifecycle.test.ts.
- Original reproduction: unit4fail/1pass, route2fail/11pass, lifecycle1fail/2pass before source repair.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. No self-triggered controller is added or modified. This is runtime consume storage cleanup under an already approved invariant.
