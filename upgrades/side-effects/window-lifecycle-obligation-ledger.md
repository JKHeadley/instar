# Side-Effects Review — Window Lifecycle Obligation Ledger

**Version / slug:** `window-lifecycle-obligation-ledger`  
**Date:** 2026-08-28  
**Author:** Codey (Echo Window-28 build lane)  
**Second-pass reviewer:** independent reviewer — concern raised

## Summary of the change

Adds an Echo-only, content-compiled lifecycle obligation ledger in `src/core/WindowLifecycleObligationLedger.ts`, wires it into `AgentServer` and the guarded mutation routes, and covers it at unit, integration, and E2E tiers. It verifies source coverage, evidence binding, executor liveness, admission/closure census, exact operator waivers, native between-window gate records, local persistence, and rollback. No templates, migrations, hooks, defaults, or other-agent state change.

## Decision-point inventory

- Source operative-clause classification — add — deterministic structural compiler with fail-closed coverage.
- Executor-class selection/liveness — add — deterministic authority over enumerable runtime facts.
- Admission and closure — add — deterministic state-machine authority over obligation dispositions.
- Waiver validity/reach — add — deterministic cryptographic/scope/core-duty policy.
- Semantic assessment quality — pass-through — remains owned by the named contextual authority; the ledger verifies bound evidence only.

## 1. Over-block

An operative source sentence using vocabulary outside the declared normative forms can be missed by clause discovery. The complete source/challenge and coverage model makes known operative lines fail closed, but authoring conventions remain a boundary. Runtime heartbeat tolerances can reject a legitimate but stale-reporting executor; freshness is explicit per binding so the duty owner must choose it from the compiled deadline/grace.

## 2. Under-block

The library does not independently judge whether an observer's synthesis is insightful or whether an 80/20 decision was wise. It requires evidence from the named semantic authority. The native adapter truthfully proves only local-store presence; stronger semantic/authenticity evidence must come from separate verifiers.

## 3. Level-of-abstraction fit

This is the policy authority at the lifecycle layer, built over lower-level native-gate, runtime-registry, source, and evidence facts. Structural checks do not compete with a conversational authority. Semantic judgments remain external rather than being approximated by regexes.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — the change holds deterministic blocking authority over a closed, enumerable invariant domain.

It does not infer message meaning. It blocks only on schema/scope, cryptographic binding, source coverage, runtime liveness, deadline, exact state transition, and terminal census facts. Contextual semantic decisions are accepted only as authority-bound evidence.

## 4b. Judgment-point check

No new static heuristic resolves competing semantic signals. The spec's `## Decision points touched` section separates enumerable lifecycle floors from semantic judgment-candidates and names the latter as external authority inputs.

## 5. Interactions

- **Shadowing:** native admission remains unchanged and runs as a structural preflight; ledger semantics cannot be attributed to it.
- **Double-fire:** the owned 60-second controller deduplicates surfaced issue strings before emitting Observer-topic escalation; mutation routes may also request an immediate tick, but cannot re-emit an already-surfaced issue.
- **Races:** persistence uses same-directory temporary-file rename. A future multi-writer caller must serialize at a higher layer; none is introduced here.
- **Feedback loops:** a recovered executor cannot erase a missed interval; it can only satisfy a later/current instance.

## 6. External surfaces

Echo-local authenticated `/window-lifecycle/*` API routes are added for compile, evidence, evaluate, tick, transition, native admission, waiver, rollback, re-enable, and read status. Persistent state exists only below Echo's state directory. Blocking issues can produce a deduplicated Observer-topic notice. The routes refuse foreign agent/scope before state access and are not advertised or migrated to other agents.

## 6b. Operator-surface quality

The waiver, rollback, and re-enable routes are operator-adjacent surfaces. Waiver/rollback approval must be a live re-query of the locally bound operator's exact post-created digest message; re-enable reads the fixed local repair artifact and dry-run result rather than caller verdict booleans.

## 7. Multi-machine posture

**Machine-local BY DESIGN:** this Window-28 ledger is explicitly scoped to Echo's local agent home and the locally installed native store/runtime registry. It must not be replicated, proxied, or applied to another agent under the approved non-leakage rule. It emits no user-facing notices, generates no URLs, and does not claim state continuity on topic transfer. A future fleet/multi-machine authority requires a separately converged spec.

## 8. Rollback cost

Rollback is Echo-local and audited: set state to `rolled_back`, preserve the complete ledger read-only, and record operator evidence/reason/time. Reverting the code is a normal hot-fix. No migration or other-agent repair is required because no shared schema/default is changed.

## Conclusion

**Clear to ship** (updated 2026-08-28 ~18:45 PDT by Echo/Observer 1 at commit time; the hold above dated from cycle 8 and both outstanding items have since completed):

- **Independent concurrence:** reached at cycle 22 (behavior/security — reviewer independently reran all six focused files, 158/158 green including the two-lifecycle production AgentServer E2E), re-confirmed at cycle 24 (route/capability/write-domain corrections — reviewer independently reran capability discoverability 166/166 and write-domain registry/conformance/admission E2E 33/33), and at cycle 27 (test-fixture isolation — reviewer independently reran session-management-e2e 33/33).
- **Full suite:** complete `npm run test:all` exited 0 with zero failures (final E2E phase 341 files passed / 1 skipped; 3,107 tests passed). Final `npm run build` and full lint chain green; `git diff --check` clean.
- The build ledger (`.instar/w28/build-progress.md` in the agent home) records all 27 review-fix cycles, including every rejection and its disposition.

## Second-pass review (if required)

**Reviewer:** independent Window-28 reviewer (separate codex session, read-only)  
**Independent read of the artifact:** **Concur with the review** — final verdict at cycle 22, re-confirmed cycles 24 and 27 (see Conclusion). The cycle-8 concern list below is retained as the honest history of what the loop found and fixed; every item was verified closed by the reviewer's own reruns before concurrence:

- ~~No production initialization or lifecycle entry point invokes the module~~ — closed: enforcement middleware wired over live AgentServer mutation doors; production-wiring E2E proves it.
- ~~Compiler/coverage discovery shares one regex, incomplete Section 7 catalog~~ — closed: source-derived AST compilation with explicit duty catalog and mutation negatives.
- ~~Evidence and executor authority accepted as caller labels~~ — closed: independently re-queried against real stores/registries (CommitmentTracker, SessionWatchdog inspection authority, Playwright registry, live Telegram rows) with HMAC-bound adjudication.
- ~~Admission, closure census, native adapter, waiver, transition, timestamp gaps~~ — closed: signed census with hash chain, exact-digest waivers, pinned native-adapter contract, per-class executor predicates.
- ~~Section 12 attack/omission/production-wiring/live-dry-run coverage incomplete~~ — closed: full attack matrix, per-duty omission negatives, controlled-omission cloned replay, and the 2026-08-28 executor-liveness incident test, all green in the final suite.

## Evidence pointers

- `tests/unit/window-lifecycle-obligation-ledger.test.ts`
- `tests/integration/window-lifecycle-ledger-store.test.ts`
- `tests/e2e/window-lifecycle-executor-incident.test.ts`

## Class-Closure Declaration (display-only mirror)

- `unbounded-self-action` — closure: **gap**, tracked as **ACT-320** (due 2026-09-04). The ledger's owned 60-second controller tick is a self-triggered loop; it is bounded in code (owned single ticker, dedupe-before-emit, mutation-route ticks cannot re-emit an already-surfaced issue) but has no faithful convergence model in `src/testing/selfActionRegistry.ts` yet. ACT-320 authors that model and flips this declaration to closure: guard.
