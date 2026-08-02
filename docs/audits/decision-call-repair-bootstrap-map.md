---
artifact: "decision-call-repair-bootstrap-map"
schema: "repair-bootstrap-map-v1"
source-audit: "docs/audits/full-decision-visibility-enactment.md"
source-commit: "a64af3084bf796db94f75b556606480756d87ca4"
typescript-version: "5.9.3"
normalization-profile: "repair-bootstrap-source-ast-v1"
finding-count: "9"
origin-count: "16"
---

# Decision-call repair bootstrap map

This is the immutable migration input required by
`docs/specs/decision-quality-enforcement-teeth.md` before its compiler inventory
implementation begins. It binds the enactment audit's nine repair-first findings
to the exact physical in-scope provider call edges observed at the pinned
pre-generator source commit.

This artifact does not claim that the nine semantic identity repairs are complete,
that the compiler inventory exists, or that the 16 physical call edges are 16
final decision identities. It changes no executable source. Its only authority is
to bound which current call edges the first compiler-backed census may temporarily
mark `repair-required` under the migration exception.

## Pinned boundary

- **Source commit:** `a64af3084bf796db94f75b556606480756d87ca4`
- **Source audit:** `docs/audits/full-decision-visibility-enactment.md` at that
  commit
- **Compiler parser:** repository-pinned TypeScript `5.9.3`
- **Closed baseline:** exactly 9 findings and 16 physical in-scope call edges
- **Review authority:** an authenticated reviewer independent of the later
  inventory implementation must approve the exact head containing this artifact

The artifact cannot record its own future merge commit without becoming
self-referential. Increment A must pin both the eventual merge commit of this
prerequisite and the SHA-256 digest of this file's bytes at that commit. It must
also prove that commit is an ancestor of its merge base.

The map itself is immutable after merge. “Shrink-only” applies to the generated
`repair-required` set that consumes this map: an origin may disappear only by
becoming an exact decision identity. The consumer must refuse additions,
substitution, cardinality growth, marker reuse, or fingerprint drift. Those checks
belong to Increment A; putting a mutable consumer or generator in this prerequisite
would collapse the independence boundary this artifact exists to create.

## What cardinality means

`expected origin cardinality` counts the physical in-scope provider call edges at
the pinned source commit. It does not bless their present semantic aggregation.
A generic call edge may still conceal several domain prompts, while two physical
edges may be alternate plumbing for one broader component. Both are precisely why
these rows are repair debt rather than exact identities.

Follow-on repair PRs must split, route, or rename these into exact decision origins.
They may reduce `repair-required`; they may not use this map to preserve a vague
component identity or to admit a new or changed callsite.

## Finding-level closure

| finding key | legacy census decision point | declared component | observed runtime attribution | expected origin cardinality | repair reason |
|---|---|---|---|---:|---|
| `a2a-checkin` | `a2a-checkin-summarize` | `a2a-checkin` | `server:a2a-checkin` | 1 | Declared and runtime component identities disagree. |
| `coherence-review` | `coherence-review` | `CoherenceReviewer` | `CoherenceReviewer` | 1 | One generic provider call services multiple named review prompts; its final semantic identity must be split or made explicit. |
| `correction-distillation` | `correction-distill` | `correction-learning` | `server:correction-learning` | 1 | Declared and runtime component identities disagree. |
| `pipe-session-spawn` | `pipe-session-spawn` | `PipeSessionSpawner` | `PipeSessionSpawner` | 2 | Intent classification and history summarization are two distinct judgments hidden by one component row. |
| `presence-review` | `presence-stall-judge` | `PresenceProxy` | `PresenceProxy` | 2 | The generic proxy helper has two physical provider edges and services several prompt objectives without exact per-origin identity. |
| `relationship-extraction` | `relationship-extract` | `RelationshipManager` | `RelationshipManager` | 2 | Identity matching and duplicate confirmation are distinct judgments hidden by one component row. |
| `session-activity` | `session-activity-digest` | `SessionActivitySentinel` | `SessionActivitySentinel` | 3 | Unit digestion, session synthesis, and pending-item retry are distinct physical judgments hidden by one row. |
| `standards-conformance` | `standards-conformance-review` | `StandardsConformanceReviewer` | `StandardsConformanceReviewer` and `StandardsConformanceReviewer/fit` | 2 | Conformance findings and constitutional-fit judgment use separate prompts and result contracts. |
| `tree-triage` | `tree-triage` | `TreeTriage` | `TreeTriage` | 2 | Layer triage and node triage are distinct judgments hidden by one component row. |

The cardinalities sum to 16. A generator result of 15 or 17 is a failure, not an
occasion to edit this map inside the implementation PR.

## Origin map

Ordinals below are zero-based among direct canonical provider calls in the named
enclosing symbol after parse normalization. Line numbers are deliberately absent:
they are review conveniences, not identity.

| finding key | unique repair marker | repository-relative source | enclosing symbol | invocation ordinal | normalized source-AST SHA-256 |
|---|---|---|---|---:|---|
| `a2a-checkin` | `REPAIR_A2A_CHECKIN_01` | `src/commands/server.ts` | `summarize` | 0 | `87c14a8e61b060a660ce56c984efc954f37e6681958e3351664580e75e305762` |
| `coherence-review` | `REPAIR_COHERENCE_REVIEW_01` | `src/core/CoherenceReviewer.ts` | `CoherenceReviewer.callApi` | 0 | `b3d75de75b4785a934763e596c5958a219e226a62e9c0c036800b1c643d17759` |
| `correction-distillation` | `REPAIR_CORRECTION_DISTILLATION_01` | `src/commands/server.ts` | `correctionDistill` | 0 | `ac35cc99cbf585ed1dbbabb4b986aa8314626609ad22a909296a58ea1767f7df` |
| `pipe-session-spawn` | `REPAIR_PIPE_SESSION_SPAWN_01` | `src/threadline/PipeSessionSpawner.ts` | `classifyIntent` | 0 | `1759fe14732978236da31ec72ac72b1c5d75dcc21951e76d2c4b5946fc588ed3` |
| `pipe-session-spawn` | `REPAIR_PIPE_SESSION_SPAWN_02` | `src/threadline/PipeSessionSpawner.ts` | `summarizeThreadHistory` | 0 | `775a313755c34eaed5e76308075fe2f65486c73bdaff6ea57d7a9f9f8206b653` |
| `presence-review` | `REPAIR_PRESENCE_REVIEW_01` | `src/monitoring/PresenceProxy.ts` | `PresenceProxy.callLlm` | 0 | `1021f83db703a60bf1c3ef156010bf5b618c5f289911466f367294d22d11f56b` |
| `presence-review` | `REPAIR_PRESENCE_REVIEW_02` | `src/monitoring/PresenceProxy.ts` | `PresenceProxy.callLlm` | 1 | `97b85f6374eb2b18e5f731e76482b9555d6aed7ae2768c4f944aa25571980801` |
| `relationship-extraction` | `REPAIR_RELATIONSHIP_EXTRACTION_01` | `src/core/RelationshipManager.ts` | `RelationshipManager.askIdentityMatch` | 0 | `571c7f11d79766e463581a98c807b446248cba3e759c0fc79aab19993216b712` |
| `relationship-extraction` | `REPAIR_RELATIONSHIP_EXTRACTION_02` | `src/core/RelationshipManager.ts` | `RelationshipManager.askDuplicateConfirmation` | 0 | `5b1c0391c15d58033c4d97d0e74fdf723df60a5c4bc2541e37d9a268d0cc0c8c` |
| `session-activity` | `REPAIR_SESSION_ACTIVITY_01` | `src/monitoring/SessionActivitySentinel.ts` | `SessionActivitySentinel.digestUnit` | 0 | `61ab436e2b66081b5c6f9d92a144f20b62cef9057dab87fd942e029d4103c351` |
| `session-activity` | `REPAIR_SESSION_ACTIVITY_02` | `src/monitoring/SessionActivitySentinel.ts` | `SessionActivitySentinel.buildSynthesis` | 0 | `9210897c3a9308ca8fe48c5c20acd68caf0d006eec93f7e9b9786496eb938652` |
| `session-activity` | `REPAIR_SESSION_ACTIVITY_03` | `src/monitoring/SessionActivitySentinel.ts` | `SessionActivitySentinel.retryPending` | 0 | `734676546806ec435094dc931bb88ea2d7844c226c6e4c1f10dc1474efda9136` |
| `standards-conformance` | `REPAIR_STANDARDS_CONFORMANCE_01` | `src/core/reviewers/standards-conformance.ts` | `StandardsConformanceReviewer.review` | 0 | `3ba700fc733574349fb29dd5da9c5c985683c494545a52c779993062cfd13c07` |
| `standards-conformance` | `REPAIR_STANDARDS_CONFORMANCE_02` | `src/core/reviewers/standards-conformance.ts` | `StandardsConformanceReviewer.judgeFit` | 0 | `f540dc343a405a37e594dffa110d255edfad581252897b7911a558f2cb8a8969` |
| `tree-triage` | `REPAIR_TREE_TRIAGE_01` | `src/knowledge/TreeTriage.ts` | `TreeTriage.llmNodeTriage` | 0 | `c50c8307303fec2c99f9bace399a30e96ed576c63b7fb7aafedebacf938e6961` |
| `tree-triage` | `REPAIR_TREE_TRIAGE_02` | `src/knowledge/TreeTriage.ts` | `TreeTriage.llmTriage` | 0 | `ce401a1e0548ef01e07bdb962c8359a4b760d3a2850dc1d3ebb35f2912c077c8` |

## Fingerprint normalization

`repair-bootstrap-source-ast-v1` is deterministic and content-local:

1. Parse the pinned repository-relative source with TypeScript `5.9.3` as a TS
   source file. Parse diagnostics are a failure.
2. Resolve the named logical owner. A method or function uses its declared name;
   an arrow/function expression uses its variable or object-property name. The
   source path plus owner name must identify exactly one owner.
3. Enumerate direct canonical `evaluate` calls within that logical owner in source
   order and select the recorded zero-based ordinal. Missing, extra, computed,
   extracted, bound, `.call`, or `.apply` forms fail rather than hashing.
4. Traverse the entire logical-owner AST in preorder with `forEachChild`. Emit each
   node's `SyntaxKind`; additionally emit decoded text for identifiers, string and
   numeric literals, and template-literal tokens. Positions, comments, whitespace,
   quote style, and line endings are excluded.
5. SHA-256 the UTF-8 bytes of these NUL-separated fields:
   `repair-bootstrap-source-ast-v1`, repository-relative path, enclosing symbol,
   decimal invocation ordinal, TypeScript version, and the compact JSON token
   stream from step 4.

Hashing the whole logical owner, rather than only the call expression, is
intentional. Inserting or replacing a call inside that owner changes the owner AST
and prevents a new call from inheriting an old ordinal. Including the ordinal keeps
the two `PresenceProxy.callLlm` edges distinct even though they share one owner.

## Independent review bars

The prerequisite is approvable only if an independent reviewer verifies all of the
following against the pinned source commit:

1. the nine finding keys exactly equal the audit's repair-first list;
2. all 16 mapped edges resolve to direct canonical provider calls at the recorded
   source owner and ordinal;
3. no additional physical provider edge belongs to any of the nine findings;
4. finding cardinalities equal the origin table and sum to 16;
5. repair markers are unique and used once;
6. both declared/runtime attribution mismatches are preserved rather than silently
   normalized away;
7. every fingerprint reproduces under
   `repair-bootstrap-source-ast-v1` and TypeScript `5.9.3`;
8. this change contains no generator, census rewrite, runtime enrollment, or source
   repair; and
9. the reviewed head descends from the pinned source commit without changing any
   mapped source file.

Approval certifies this closed migration baseline only. It does not approve
Increment A, any later semantic disposition, or a universal-coverage claim.
