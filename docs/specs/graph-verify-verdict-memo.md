---
title: "Conversation graph: remember each stored row's verification verdict until the row or the verifier changes"
slug: "graph-verify-verdict-memo"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "graph-verify-verdict-memo.eli16.md"
status: "converged"
approved: true
approved-by: "echo under the standing grant that only constitution changes need the operator (Justin 2026-10-22: I should ONLY have to approve constitution changes); no constitution or CODEOWNERS files touched; autonomous run pre-approved by the Chief of Staff go (topic 144007 to 144559)"
created: "2026-11-18"
parent-spec: "brief .instar/autonomous-briefs/graph-event-loop-blocks-1118.md (topic 144559); PRs 3341, 3350"
review-convergence: "2026-11-18T02:57:11.281Z"
review-iterations: 5
review-completed-at: "2026-11-18T02:57:11.281Z"
review-report: "docs/specs/reports/graph-verify-verdict-memo-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Conversation graph: remember each stored row's verification verdict

## Problem

`ConversationGraphReplication.certifiedUnion` verifies every stored row on every call: `verify(row, origin)` (signatures, membership, lease bridge, certificates, receipts, erasure proofs), then `fullyPersisted(row)` (verifies each member's persistence receipt, up to three times per own row), then `canonicalHash(descriptorFor(row))`. At ~550 rows one pass costs 1-3 s of synchronous CPU on a loaded Studio. `certifiedUnion` runs once per source-observation revalidation (once per record continued during Accept all), once per read-view build, and in the source inventory runner and `readerHash`. After PRs 3341 (revalidation 3 passes → 1) and 3350 (one read view per page read), one full pass per call remains, so one step still holds the event loop for seconds during Accept all. Rig profile 2026-11-18 (6 × 75 s during a real Accept all, ~550 rows): inside `certifiedUnion`, `verify` ≈ 49%, `reader.readAll` ≈ 21%, `fullyPersisted` ≈ 9%, descriptor hashing ≈ 7%, `cloneGraphRecord` ≈ 4%.

Between two calls usually one row changed (the record just written). Re-verifying the other rows repeats work whose answer is already known, provided neither the row nor anything the verifier reads changed.

Why this layer: the read-view cache (`readViewMarker`) is null while any write is in flight, which during Accept all is nearly always, and revalidation calls `certifiedUnion` per record regardless; making the marker write-aware would still leave one full pass per write. Memoizing the per-row work makes every caller of `certifiedUnion` cheap on unchanged rows, whether or not a view cache hits.

## Scope

In scope: the per-row work in `certifiedUnion`'s first loop and its own-row loop, on the stored row object (`this.records.get(key).record`): `verify(row, origin)`, `fullyPersisted(row)`, `canonicalHash(descriptorFor(row))`. `readerHash` (a rare member-loss path) is left unchanged. Everything else keeps calling `verify` directly: `verifyHistoricalRecord` on clones, `envelope`, `openVerifiedPayload`, and all write paths.

Not in scope, recorded as remaining cost: `reader.readAll` (~21% of a pass, it re-reads every key from the replicated store) and `cloneGraphRecord` of accepted rows (~4%). Expected effect: a pass on an unchanged ~550-row graph drops by roughly 50-60%, i.e. from 1-3 s to about 0.5-1.4 s on the loaded Studio. What stays per pass: `readAll` (~21%), the descriptor hash of the side read from the store, `isDenied` in the accept loop, the two `canonicalHash(immutable(...))` per own row, and `fullyPersisted` on own rows' accept-loop clones (to keep that one cheap too, the accept loop reuses the `persisted` result of the stored row a clone was built from, recorded when the clone is built in the same pass (a map keyed by the clone object); the clone differs from that row only in `erasure`, `encryptedSourceBundle` and `rewrap`, which `fullyPersisted` does not read; in check mode the reuse is compared with a fresh `fullyPersisted` of the clone). The rig proof (§Tests 4) measures this. The `readAll` cost stays part of this work: it is inside the same autonomous run's completion condition (no graph step over ~1 s), so if the rig still shows a step above ~1 s after this ships, that run makes the next change against it.

## Design

### 1. What the per-row work reads

Established from the code of `verify`, `fullyPersisted`, `descriptorFor` and every helper they reach (`validAdoption`, `validMaterialization`, `validPreparation`, `validErasedControl`, `validErasure`, `validCancellation`, `validCancellationCertificate`, `validCertificate`, `validMemberLossNegativeCustody`, `verifyCommitProofDeliveryReceipt`, `certificateMembership`, `certificateContext`, `receiptContext`, `effectiveMembership`, `terminal`, `immutable`, `isErased`):

| Input | Where it lives | How the memo stays correct |
|---|---|---|
| The row's content | stored row object | Fingerprint (§3). Rows change only by `records.set` (open, `appendLocal`/receive paths) or top-level field reassignment/delete in this class (`attachCertificate`, `recordCertificateReceipt`, `persistAdoption`, `applyErasure`, delivery-receipt and cancellation writers). No nested value of a stored row is mutated in place (checked: no `.push`/`.splice`/nested assignment on stored rows; stored rows never leave the class except through `cloneGraphRecord`/`exportRecord`). The one in-class mutator of nested objects, `retainHeldPrivateView`/`clearHeldPrivateObject` (deletes keys inside the objects it is given), receives only clones today. It deletes through `Reflect` (no throw on a frozen object), so in check mode it counts a divergence when a value it fails to clear is one the memo froze (tracked in a module WeakSet); the test-setup assertion (§5) then fails the test. |
| `origin` | argument | part of the hit check |
| `pendingErasureTargets`, `erasureProofs`, `controlTargets` (erasure preflight is cross-row) | this class | `verifierEpoch` bumped in `retainPendingErasure`, `releasePendingErasure`, and the `erasureProofs.push` in `persistErasure` (its only mutation). `controlTargets` is deliberately NOT bumped: `rememberControl` runs on every write, so a bump there would empty the memo after each record (round-4 finding), and `controlTargets` is read only by `erasureHashPreflight` inside `validErasure`, which only excluded erasure rows reach (pinned by the reachability test) |
| Member-loss import state: `historicalImportAuthority`, `historicalImportActivationHash`, `historicalImportMembership`, `historicalReopen` | this class | `verifierEpoch` bumped in `installHistoricalImportAuthority` and every `historicalReopen` assignment (conservative: only excluded member-loss rows read these) |
| Materialization contexts, `verifiedContexts`, paged scope (files, `Date.now()`) | this class | rows that reach them are excluded (§2) |
| Local deny fence (`options.localErasure.isDenied`) | `NegativeRootState`, shared by every `ConversationGraphLocalErasureFence` for the same state root (module-level `negativeRoots`) | per-pass signature from the fence's new `answerSignature()` getter: `${rootValid()}:${corrupt}:${denied.size}` (rootValid first, since it can set `corrupt`). Complete because the shared state only grows: `denied` is never deleted or cleared (by design: "never evict/clear a deny"), `corrupt` is never reset to false, and `negativeRoots` keeps one state object per root. Same size means the same deny set, so the same answers. No mutation site needs instrumenting. |
| Erasure authority store (`has`, `verificationKey`, `currentKeys`, custody lineage on disk) | `ConversationGraphErasureAuthorityStore` | only `validErasure` reads it; rows with `erasure` are excluded (§2) |
| `options.witnessPublicKeys` | a Map owned by the runtime, mutated later (`installNegativeCustodyRole` adds/replaces keys) | per-pass signature: `canonicalHash` of sorted `[witnessId, sha256(SPKI DER)]` pairs, a PEM string or Buffer is hashed as-is (the runtime stores PEM strings), a KeyObject is exported to SPKI DER first; a few witnesses, so a few microseconds per pass |
| `options.installedMembership` | a reference to the runtime's `config.membership` | per-pass `canonicalHash` |
| `options.ownerPublicKey`, `options.agentId`, `options.machineId` | constructor options | constant for the instance |
| `options.validateCore` | injected; production value `validateGraphOperationCore(coreType, value) !== null` (runtime), pure | contract: pure function of its arguments; the divergence guard (§5) checks it in tests |

### 2. Rows the memo never covers

Always computed fresh (no memo read or write): rows with `materialization` (clock and file dependent), `adoption?.activation?.memberLoss` (member-loss authority internals), `erasure` (authority store keys and custody lineage on disk), `erasedControlProof`, `custodyMembership` or `custodyActivations` (custody lineage). The memo is also off for the whole pass when `options.localErasure` is set but is not an instance of `ConversationGraphLocalErasureFence` (no `answerSignature` to read).

### 3. The memo

```ts
private verifierEpoch = 0;
private readonly rowMemo = new WeakMap<ConversationGraphReplicationRecord,
  { context: string; keys: string[]; values: unknown[];
    verified: Map<string, boolean>;          // origin → verify(row, origin)
    persisted?: boolean; descriptorHash?: string }>();
```

- **Per-pass context**, computed once at the start of `certifiedUnion`, before any row is looked at: `${verifierEpoch}|${fence ? fence.answerSignature() : 'none'}|${witnessKeySignature}|${canonicalHash(options.installedMembership ?? null)}`. `answerSignature()` calls `rootValid()`, the same realpath + open + fstat check `isDenied` already makes on every call; it now also runs once per pass, so a root changed on disk changes the context even if nothing else noticed. If computing the context throws, the pass runs with the memo off.
- **Row fingerprint**: `Object.keys(row)` and the value of each key, compared by identity (`===`), computed once per row per pass (a per-pass map reset at the start of every `certifiedUnion` call, never shared between passes).
- **Hit**: same row object, same context, same keys, identical values → reuse the cached result for that call (`verified.get(origin)`, `persisted`, `descriptorHash`; each is filled on first use). **Miss** on any difference: discard the entry, compute, store.
- The WeakMap drops entries with their row objects; an entry's `values` keep the previous top-level values alive until the row is next seen (bookkeeping of a few hundred bytes per row, ~0.2 MB at 550 rows; replaced top-level values are additionally retained until the row is next seen, i.e. until the next pass).

### 4. Why a stale result cannot be served

A cached result is returned only when every input in §1 is unchanged: row content by identity of every top-level value (no nested in-place mutation exists, §1); class-local verifier state by `verifierEpoch`; the shared fence by its per-pass answer signature; witness keys and installed membership by per-pass signatures; constants are constant; every input that depends on the clock, files or the authority store's lineage belongs to an excluded row class (§2). Direction: only row content, `installedMembership`, witness keys and `releasePendingErasure` can turn a covered row's TRUE into FALSE (the dangerous direction for a stale entry); the fence, `erasureProofs` and `retainPendingErasure` can only turn FALSE into TRUE (they matter only through `isDenied` for bodyless rows). The both-direction tests (§Tests 1) aim at the TRUE-into-FALSE inputs first. Consistency boundary: the context is sampled at the start of each synchronous pass, so a fence root that changes on disk in the middle of one pass is seen at the start of the next pass (before, `isDenied` could notice it a few rows later in the same pass). This cannot certify a row the live check would reject: an invalid root makes `isDenied` answer "denied", which inside `verify` can only admit a bodyless row (FALSE into TRUE; `validateGraphReplicationRecord` accepts a null bundle only when the target is denied), so a verdict cached before the change can only be stale in the refusing direction; and the accept loop's own `isDenied` filter on every candidate stays a live call, unmemoized; no await happens inside a pass, so no other in-process change can land within one.

### 5. Keeping the enumeration true over time

- **Field-read test (structural):** a unit test, using the TypeScript compiler API (already in `node_modules`), starts from `verify`, `fullyPersisted` and `descriptorFor` in the class source and follows every `this.<method>(` call transitively, so a helper newly called from any of them is analyzed automatically. Across that closure it collects every `this.<field>` and `this.options.<field>` read and every call into another object (`this.options.localErasure.isDenied`, `this.erasureAuthorities.*`, `this.contexts.*`, `this.historicalImportAuthority.*`), including reads inside arrow functions passed to free functions (`{isDenied:target=>this.isErased(target)}`), and compares them with the classified list in §1, which also names reads reachable only from excluded row classes (`currentHistoricalImportMembership`, `historicalImportAuthority`, `contexts`, `pagedScope`). Syntax it does not follow (computed member access on `this` or `this.options`, aliasing `this` or `this.options` to a local) is flagged and fails the test rather than being skipped. A new direct read or a new call into another object fails the test until it is classified (bump site, per-pass signature, or exclusion). What it checks mechanically: no read of class or option state, and no call into another object, from the per-row work goes unclassified (it stops at the excluded-only helpers, whose unreachability from covered rows is pinned by the reachability test). What stays a maintained assumption: that each classification's invalidation rule is right. What it does not prove: what those other objects read internally, or that free functions are pure. Those are covered by the §1 classification of each external object (each is either excluded, signed per pass, or signed per pass by its grow-only answer signature), by the module-level free functions being pure transforms of their arguments (signature and structure checks), and by the divergence guard, which is evidence on exercised paths, not a general proof.
- **In-place edit guard:** with `INSTAR_GRAPH_VERDICT_MEMO_CHECK=1`, when a row's entry is created or refreshed, each of the row's top-level values is deep-frozen, test-only (production never freezes; a test that shares a value with a row by reference may throw where production would not, which is the point), recursing under already-frozen parents and skipping typed arrays (stored rows are JSON-derived and hold no binary values; a binary value added to rows later would need its own ownership rule) (the row object itself is not, since top-level reassignment is the legitimate way rows change). Any later nested edit of a stored row (for example a `.push` into a receipts array) then throws in every suite that touches it, not only on paths that happen to hit the memo. A unit test shows a nested edit after a memo fill throws in check mode.
- **Divergence guard:** with `INSTAR_GRAPH_VERDICT_MEMO_CHECK=1`, every hit also recomputes; on any difference it increments a process-global divergence counter (exported as `graphVerdictMemoDivergences()`) and throws `graph-verdict-memo-divergence`. Because many callers of `certifiedUnion` catch errors and degrade to `held`/`partial`, the throw alone could be swallowed, so `tests/vitest-setup.ts` asserts in a global `afterEach` and `afterAll` that the counter is zero (tests of the guard itself read and reset it). The env var is set in that file after its `INSTAR_*` strip loop (which would otherwise delete it). Every vitest config that touches the graph loads the file. It catches a missed bump only on paths those suites exercise with a warm memo, so §Tests adds targeted warm-memo cases for each input, in both directions.
- **Kill switch:** `INSTAR_GRAPH_VERDICT_MEMO=off` (read at construction; takes effect after a server restart) turns the memo off.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| `certifiedUnion` per-row admission (`verify` ok and descriptor match → candidate; else blocked/partial), and `fullyPersisted` → pending/partial | invariant; basis: enumerable-domain; evidence: the predicates are the existing cryptographic/structural checks, unchanged; the memo reuses a result only when every input those checks read is unchanged, and that input set is enumerated in §1 and enforced by the field-read test (§5) | Same predicates and the same answers whenever external verifier state is stable within a pass (the one observation-timing change is the fence root boundary in §4), computed less often. No new heuristic, no new authority. |
| Memo hit vs miss | invariant; basis: enumerable-domain; evidence: a hit requires identity-equality of every top-level row value plus equality of the per-pass context string; any difference, any excluded row class, or an unreadable context recomputes | No competing signals; the conservative default is recompute. |


## Fixed limits

fixed-limits: none (no rate, count, size, threshold or quota is introduced).

## Multi-machine posture

Not a state surface: the memo is derived, process-local and behaviour-identical apart from the fence-root observation boundary in §4. It holds nothing that is not recomputable from the machine's own stored rows and verifier state, and it is never persisted, replicated, served or shown; dropping it (restart, kill switch) changes no answer. So no machine-local justification key applies. The existing posture is unchanged: the graph is replicated and each machine verifies its own copy. Notices: none. Durable state: none. URLs: none.

## Frontloaded Decisions

1. Scope: per-row work in `certifiedUnion` on stored row objects, including the accept loop's `fullyPersisted`; `readerHash` and everything else verify directly.
2. Excluded row classes as listed in §2; memo off for a pass whose fence is not the fence class.
3. The fence is signed per pass through a new read-only `ConversationGraphLocalErasureFence.answerSignature()` (root check, corrupt flag, deny-set size of the shared state); no counter, no instrumented mutation sites. A unit test pins the grow-only property (no `denied.delete`/`clear`, no `corrupt = false`).
4. Witness keys and installed membership are signed per pass, not tracked by bumps.
5. Field-read test, in-place edit guard (deep-freeze of top-level values) and divergence guard, the last two on via `tests/vitest-setup.ts`; off in production.
6. Kill switch `INSTAR_GRAPH_VERDICT_MEMO=off`, read at construction.

## Tests

1. Unit, warm memo (`tests/unit/conversation-graph-verdict-memo.test.ts`): a warm pass makes no `verify` call (check mode off); a top-level reassignment misses for that row only while the other row still hits; a different origin misses once; a replaced witness key and an in-place `installedMembership` change each make the next real pass recompute; the per-pass context changes for the epoch, witness keys and membership; a deny through another fence instance for the same root changes the fence signature; the fence stays grow-only; an unreadable context or the kill switch turns the memo off; excluded rows never enter the memo; check mode freezes stored values and a tampered cached verdict counts a divergence. The real bump sites are pinned structurally (every class-local verifier-state write is immediately preceded by the bump); the existing graph unit suites run with check mode on and exercise those sites with recomputation on every hit.
2. Field-read test (§5), plus a reachability test: verifying covered certified rows calls none of the dependencies classified as excluded-only (`validMaterialization`, `validErasure`, `validErasedControl`, `currentHistoricalImportMembership`, `validMemberLossNegativeCustody`), checked with spies.
3. Divergence guard on for all suites; existing graph unit and integration suites stay green with it on.
4. Rig (acceptance for this change: the memo removes the per-row verification cost on unchanged rows; the run's broader "no graph step over ~1 s" goal is judged separately): two real Accept all runs on the same rig state and build, memo on and `INSTAR_GRAPH_VERDICT_MEMO=off`, check mode off (production settings), each with the same CPU-profile windows; report for each the longest uninterrupted graph step and `certifiedUnion` inclusive time. Report the memo hit rate during Accept all (hits / covered row lookups). Each run starts from the same restored rig snapshot (seeded projects pending); the first pass after start is a cold memo and is reported separately from warm passes; after warm-up, no repeated `verify`/`fullyPersisted` for eligible rows that are unchanged under an unchanged context (excluded-class rows and context changes are reported separately); the remaining per-pass cost and the share of rows in excluded classes are reported with numbers.

## Maturation plan

- **test-agent-live:** the accept-all rig (two throwaway agents, Studio + M5, ~550 graph rows): two real Accept all runs from the same restored snapshot, memo on and `INSTAR_GRAPH_VERDICT_MEMO=off`, check mode off, CPU-profiled (§Tests 4).
- **dev-agent-live:** live on this agent from the release that carries it. For one week, watch the Studio log for `graph-verdict-memo-divergence` (must be zero; production never throws it unless check mode is set, so this is checked by running the graph suites in Local Verify with check mode on) and the `SleepWakeDetector` event-loop BLOCK lines during graph work.
- **fleet:** the same release; ungated, with the `INSTAR_GRAPH_VERDICT_MEMO=off` kill switch for any machine.
- **graduation criterion:** on the rig, memo-on shows no repeated `verify`/`fullyPersisted` for unchanged eligible rows after warm-up and a lower longest graph step than memo-off on the same snapshot; and the dev-agent week shows no divergence in check-mode suites. A run with zero Accept all records is not a pass.
- **dark-window:** none, live on release; if the rig criterion is not met within 7 days of merge, the reason and a new date are recorded in topic 144559 and the kill switch is set on the Studio.
- **ladder:** not applicable: no config flag, live on release, an environment kill switch is the step back

## Rollback

`INSTAR_GRAPH_VERDICT_MEMO=off` plus a restart, or revert. No persisted state.

## Open questions

*(none)*
