# Side-Effects Review — Conversations hierarchy core (increment A, local part)

**Version / slug:** `conversation-graph-core-increment-a`
**Date:** `2026-11-05`
**Author:** `Dawn (claude-code), building for Echo's Conversations run`
**Second-pass reviewer:** `independent reviewer subagent (claude-code) — see below`

## Summary of the change

Adds the deterministic core of the Conversations hierarchy from `docs/specs/conversation-effort-hierarchy-v3.md` (§3.1–3.3, §7.2, §7.5), plus that spec and its imported review record. Three new modules, none of them wired into the server, routes, boot, or any existing path:
`src/core/conversationGraph.ts` (typed `NodeRef`, event validation, the receipt-first reducer, the viewer-filtered projection), `src/core/ConversationGraphStore.ts` (append-only fsynced `conversation-graph/events.jsonl`), and `src/core/EffortHeaderStore.ts` (versioned, erasable effort titles in `conversation-graph/effort-headers.json`). A new state-registry category `conversation-graph` declares both files. Tests: `tests/unit/conversation-graph.test.ts` (40), `ConversationGraphStore.test.ts` (6), `EffortHeaderStore.test.ts` (7) — 53 in all.
Tier 2 (risk floor 2: new durable state + authority rules). Size ~1,000 LOC across 7 source/test files plus imported spec docs. Effort: one rewrite after an executable review of the first draft (6b7f81aa2) found six reducer defects, then four second-pass rounds that found and closed nine more (id-collision poisoning before verification, owner corrections held by unverified predecessors, a front-door fallback that dropped the subject, unreported cycles and agent-head losers, a history-based then a time-based front-door guard, a certified-but-unguarded front door, and a temp file that could keep an erased title). Every one has a regression.

## Decision-point inventory

- `reduceGraph` authority precedence — **add** — which placement or front-door event decides a subject (owner > delegation > import > inference; a lower tier can never replace a higher head).
- `reduceGraph` receipt gate — **add** — an event whose authorization receipt the caller cannot verify is set aside and never reduced.
- `reduceGraph` cycle / front-door guard — **add** — which placement is set aside when a cycle or a move of a certified front door would result. The guard is causal: a `set-front-door` choice names the placement heads it observed (`observedPlacementEventIds`); it is certified only if that observed history puts the conversation directly under the effort and every observed head is an accepted placement of that conversation, and then any placement outside that history that would move it away is refused, whatever its timestamp.
- `GraphProjection` viewer filter — **add** — which nodes a viewer sees; applied before counts, search, paths and children. Effort items carry `metadata.frontDoor` only when the reducer certified the front door and the viewer may see that conversation; it is local certification, not an all-member commit, and every projection reports `replica-lag` until replication lands.
- `validateGraphEvent` / `validateNodeRef` — **add** — schema validation for untrusted events and refs.

None of these is reachable from any running path in this change.

---

## 1. Over-block

The validators refuse anything off-schema by design. Legitimate shapes they refuse today:
- A Slack channel id outside `^[CDG][A-Z0-9]{2,30}$` (e.g. a future Slack id format) — refused as an invalid ref. Acceptable while the single-workspace rule holds; a schema-versioned v2 ref is the spec's upgrade path.
- An effort id that is not a lowercase UUID — refused; v3 specifies opaque UUIDs.
- A concurrent owner move that the front-door choice did not observe is refused and the conversation stays under the effort. This is the spec's "refused" outcome (§3.2) and it is deterministic, but it means an owner who moves a conversation on one device while choosing it as front door on another loses the move until they clear the front door.
- With no receipt verifier wired, EVERY event is unverified and set aside. That is the intended "scaffolding, not state" behaviour, not an over-block bug: nothing is exposed until increment-A proofs exist.

## 2. Under-block

- Receipt *verification* is not here: `verify` is caller-supplied. A caller that passes `() => true` would make declared authority authoritative. Mitigation: no production caller exists in this change; the increment-A delegation/owner-proof owners supply the real verifier, and the read routes (increment B) are not built.
- Project-scope compatibility (§3.3, cross-project placement refusal) is not yet checked by the reducer: `projectScope` is carried on `create-effort` but no placement is refused for a scope mismatch. Tracked as part of increment C (corrections), where owner placement is first accepted from a route. <!-- tracked: Echo topic 137342, increment C cross-project table -->
- Erasure is local: `EffortHeaderStore.forget` removes the text from this machine's file only and reports `local: true`. All-member erasure completion is the replication owner's work. <!-- tracked: Echo topic 137342, graph_replication worker -->

## 3. Level-of-abstraction fit

Right layer: a pure, I/O-free core that every surface (dashboard, mobile, chat, replication) consumes, so placement logic exists once (v3 §7.1: "one shared projection module, not separate placement logic"). Durability lives in the two stores; authentication and receipt verification stay with the callers that hold the evidence. It does not duplicate an existing gate: no conversation-hierarchy store exists in Instar today; `ConversationRegistry` (routing identity) and `InitiativeTracker` (work status) are deliberately not touched (§3.1 source-of-truth split).

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface on any live path.

The reducer decides graph state from a set of events; that decision is deterministic replay (every machine must compute the same graph), not a judgment over live context, so a smart gate is not the right owner of it. It holds no authority over messages, sessions, or dispatch.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals judgment point is added. Placement precedence is a fixed, spec-mandated floor (owner beats agent, conflicts surface for the owner to resolve) precisely so that deterministic replay converges; the owner's resolution event is where judgment enters.

## 5. Interactions

None at runtime: nothing imports these modules outside their tests. The state-registry entry makes `lint-state-registry` accept the two write sites. `SafeFsExecutor` is used for both unlinks (cleanup after a failed header write, and the stale temp-file sweep on load). No shadowing, no double-fire.

## 6. External surfaces

None. No route, no capability entry, no config key, no dashboard or mobile change, no release behaviour change. The imported spec documents are documentation only.

## 6b. Operator-surface quality

Not applicable — no dashboard renderer, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local today, migrating to unified.** machine-local-justification: migrating-to-unified <!-- tracked: Echo topic 137342, graph_replication worker owns the CoherenceJournal conversation-graph-event kind, source outbox, repair and all-member receipts --> The event file is designed for union replication (immutable events keyed by `eventId`, duplicate-with-different-bytes quarantined, deterministic reducer) and the header store for all-member erasure, but neither replication path is wired in this change. Because of that, NOTHING built on these stores may be exposed: v3 §8.1 requires increment-A proofs before increment B. The projection reports `replica-lag` on every response so a premature consumer cannot present local state as agent-wide.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Revert the commit. No data migration: the modules are not wired, so no machine writes the two files in normal operation. A test run writes only to temp directories.

## Conclusion

A dark, unwired core that encodes the v3 identity, event, authority and projection rules with regressions for the six review defects. Safe to land: it changes no behaviour. It is not a feature: increment A still needs the witness, replication, and receipt verification owned by other workers, and nothing here may be presented as compliant or activated.

## Second-pass review (if required)

**Reviewer:** independent-verifier (Claude Code subagent, fresh context, 2026-11-05; five rounds)
**Independent read of the artifact: concur**

Round 1 raised a concern (id-collision poisoning before verification, owner corrections held by unverified predecessors, a front-door fallback that dropped the subject, unreported cycles and agent-head losers, store test and temp-file gaps). Rounds 2–4 each found one problem in the fix (a history-based guard, a time-based guard that backdated or late-replicated events could bypass, a certified-but-unguarded front door). All were fixed with regressions. Round 5, verbatim ending: "Concur with the review" — after re-running every reproduction and a 300-permutation determinism check, and correcting three factual errors in this artifact (per-file test counts, a stale evidence count, and the number of unlinks), which are fixed above. Round 6 (the `metadata.frontDoor` follow-up on top of a5190cf2b): "Concur with the review" — it cannot leak a hidden conversation, cannot appear for an uncertified front door, and always agrees with the conversation item's role.

## Evidence pointers

- `npx vitest run tests/unit/conversation-graph.test.ts tests/unit/ConversationGraphStore.test.ts tests/unit/EffortHeaderStore.test.ts` → 53 passed.
- `node scripts/run-lint-parallel.mjs` → 51/51 lint steps passed (pre-commit run, 2026-11-05).
- Spec: `docs/specs/conversation-effort-hierarchy-v3.md` (approved: true; review-convergence imported, see `conversation-effort-hierarchy-provenance.md`).

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration)
- **Reason:** No self-triggered action: the change adds pure reducer/projection functions and two stores that write only when a caller invokes `append` / `write` / `forget`; there is no timer, loop, retry, restart, spawn or notification, and nothing is wired to call them.
