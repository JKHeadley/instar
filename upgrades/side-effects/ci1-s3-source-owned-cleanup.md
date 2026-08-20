# Side-Effects Review — CI1 S3 source-owned cleanup

**Version / slug:** `ci1-s3-source-owned-cleanup`  
**Date:** `2026-08-18`  
**Author:** `Instar-codey`  
**Second-pass reviewer:** `not required`

## Summary of the change

The unreadable-file attribution ratchet now constructs and removes its synthetic `src/` tree under an OS temporary directory rather than under the repository source tree. `scripts/lint-llm-attribution.js` accepts an optional test fixture source root while retaining the repository root as the production default. The nested checker ratchet explicitly requests TAP output so its exact count assertions remain stable on Node 20 through newer runtimes. SourceTreeGuard and all production cleanup policy remain untouched.

## Decision-point inventory

- `runLint source-root selection` — modify — test callers may supply the root used only to derive repository-relative paths; production callers continue to use the repository root.
- `nested test reporter selection` — modify — the test harness requests TAP before parsing exact totals.
- `SourceTreeGuard cleanup authority` — pass-through — the guard is neither modified nor bypassed; cleanup now targets test-owned temporary space.

## 1. Over-block

No new production block/allow surface. The explicit source root could exclude files outside a supplied fixture root, but only direct programmatic callers can opt in and the only opt-in caller is the isolated test fixture.

## 2. Under-block

The lint still cannot prove content for an unreadable file; it intentionally reports that file as blind. A caller could misuse `sourceRoot` in future, so the default remains fixed to the real repository and the unit control proves the intended isolated use.

## 3. Level-of-abstraction fit

Fixture ownership is fixed at the caller that created the temporary bytes. The production lint owns relative-path classification, so accepting the synthetic root at that boundary is narrower than weakening the filesystem safety layer. Reporter stability is fixed at the harness that parses reporter text.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The attribution lint’s existing enforcement behavior is unchanged. The new option only supplies path context for an explicitly isolated test invocation, and SourceTreeGuard retains all of its blocking authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Temporary-directory ownership and explicit TAP selection are deterministic test-harness mechanics.

## 5. Interactions

- **Shadowing:** No guard is shadowed. SourceTreeGuard still sees cleanup, now over a safe temporary root.
- **Double-fire:** The fixture is removed once in the existing `finally` path.
- **Races:** `mkdtempSync` creates a unique directory, preventing parallel tests from sharing cleanup state.
- **Feedback loops:** None; the lint result does not alter subsequent configuration.

## 6. External surfaces

No user, agent, network, persistent-state, or operator surface changes. Tests write transient files under the host temporary directory and remove them. The TAP flag only stabilizes nested test output consumed by the ratchet.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local BY DESIGN:** each test process creates its own host-local temporary fixture because unreadability and cleanup are local filesystem facts. It emits no notices, holds no durable state, generates no URLs, and cannot strand state during topic transfer.

## 8. Rollback cost

Pure script and test change. Reverting restores the previous fixture location and reporter default; there is no migration or agent-state repair. That rollback would reintroduce the CI failure on guarded source cleanup and newer Node output.

## Conclusion

The repair changes the unsafe caller rather than the correctly functioning guard, keeps all blind-input and hollow-checker discriminations intact, and introduces no production authority change. The focused ratchets and exact preflight test are the shipping evidence.

## Second-pass review

Not required: no message flow, session lifecycle, coherence, trust, sentinel, guard, gate, or watchdog implementation is modified.

## Evidence pointers

- `tests/unit/llm-attribution-ratchet.test.ts`
- `tests/unit/checker-blind-input-ratchet.test.ts`
- `tests/e2e/dev-preflight-cli.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller — not applicable.
