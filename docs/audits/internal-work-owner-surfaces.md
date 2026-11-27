---
audit: internal-work-owner-surfaces
standing-guard: tests/unit/internal-work-owner-surfaces.test.ts
blind-spot-class: internal-execution-leaks-through-owner-projections
standard-response-kind: no-change
standard-response-ref: docs/STANDARDS-REGISTRY.md
standard-response-article-id: iterative-audit-to-convergence
standard-response-article: Iterative Audit to Convergence
standard-response-rationale: Existing repeated-review and agent-carries-the-loop standards already require finding every owner projection; this defect needs shared classification and concrete regression guards rather than another constitutional rule.
converged: "2026-11-23T20:49:19.965Z"
rounds: "6"
standard-response-digest: "5505039f748ca3861ec2d399966503a57b5080138e073a3d87b7f31683b37c47"
meta-artifact-at: "2026-11-23T20:49:19.965Z"
meta-artifact-digest: "e4b33eeb750b6edcd0d53f133aac6a6a18f1b07df5580184d19f69d2850f7d81"
---

# Internal Work Owner-Surface Audit

Target pattern: purely internal agent execution appears as an owner conversation, decision, unread count or operational request without a structured person obligation. Search surface: folding, service/runtime, board routes, Needs model, Projects, source-linked cards, App creation/list/pins/search/unread, pooled peers, production initialization, optional hierarchy, web board and native read contract. No live policy change or release claim is made.

## Meta-insight

How it arose: execution state was treated as a person obligation, then screen-local fixes left other projections exposing the same durable card. The empty-chat reproduction led to discovery of pins, source lists, pickup summaries and retained hierarchy inventory.
Why prior controls missed it: older agentWork shorthand classified permitted recommendation shapes differently, and module-local tests did not traverse every human projection or the board-disabled initialization path. The existing Iterative Audit to Convergence article already requires repeated full-surface review; shared classification and meaningful standing regressions fix this implementation failure without another constitutional rule. Future owner-confirmed criteria remain conservatively person-facing because certification is an explicit person role.


## Round 1

Search angles: inspect real screenshot card records, original creation path, status precedence, owner lanes and console Needs derivation.
Surface delta: from the visible empty chat to its durable card provenance, execution policy and owner attention model.

| location | behavior | bucket | disposition |
| --- | --- | --- | --- |
| src/core/WorkBoardRuntime.ts:464 | Card creation eagerly materialized internal owner chats | internal-creation | fixed:tests/unit/internal-work-conversation-lifecycle.test.ts |
| src/core/WorkCardStore.ts:1026 | Agent-carried requests and pure internal origin were conflated | provenance-boundary | fixed:tests/unit/internal-work-owner-surfaces.test.ts |
| src/core/workBoardViews.ts:42 | Internal held/not-started execution described an owner obligation | false-owner-status | fixed:tests/unit/internal-work-owner-surfaces.test.ts |
| dashboard/console/work-model.js:531 | Not-started aggregate created artificial Needs rows | false-owner-count | fixed:tests/unit/internal-work-owner-surfaces.test.ts |

New findings this round: 4

## Round 2

Search angles: independent discovery review of old chats, local/pool pages, saved pins, keyword/meaning search and unread triggering fallback.
Surface delta: retained storage and peer response paths beyond freshly created cards.

| location | behavior | bucket | disposition |
| --- | --- | --- | --- |
| src/core/AppConversationStore.ts:1202 | Old internal conversations remained in owner discovery before cuts | retained-discovery | fixed:tests/unit/internal-work-discovery.test.ts |
| src/server/mobileConversationRoutes.ts:765 | Saved pins and old peer pages bypassed local owner projection | discovery-bypass | fixed:tests/integration/conversation-list-pins.test.ts |
| src/server/mobileConversationSearchRoutes.ts:343 | Scoped keyword and pooled hits could reintroduce hidden history | search-bypass | fixed:tests/unit/internal-work-discovery.test.ts |
| src/server/conversationMeaningSearch.ts | Scoped meaning and stale index hits escaped discovery rules | meaning-bypass | fixed:tests/unit/internal-work-discovery.test.ts |
| src/core/ConversationUnreadService.ts | Triggering-message fallback counted hidden conversation replies | unread-bypass | fixed:tests/unit/internal-work-discovery.test.ts |

New findings this round: 5

## Round 3

Search angles: adversarial review of lifecycle transitions, admitted recommendation shapes, classifier failure and older peer unread claims.
Surface delta: startup gaps, note drain/restart, approval withdrawal and cross-version hints.

| location | behavior | bucket | disposition |
| --- | --- | --- | --- |
| src/core/WorkCardStore.ts:1026 | Nonempty recommendations made pure internal cards escape old agentWork shorthand | classifier-shape | fixed:tests/unit/internal-work-owner-surfaces.test.ts |
| src/core/workBoardViews.ts:43 | Withdrawn internal work instructed the owner to approve again | false-owner-status | fixed:tests/unit/internal-work-owner-surfaces.test.ts |
| src/server/AgentServer.ts:7413 | Enabled but unavailable runtime silently supplied empty hidden keys | unavailable-fail-open | fixed:tests/e2e/agent-work-cards-alive.test.ts |
| src/core/WorkBoardRuntime.ts:536 | Drained durable notes lost their explicit history availability | durable-history | fixed:tests/unit/internal-work-conversation-lifecycle.test.ts |
| src/server/mobileConversationRoutes.ts:809 | Legacy unread hint certified hidden internal unread as owner unread | cross-version-hint | fixed:tests/integration/conversation-list-pins.test.ts |
| src/server/mobileConversationRoutes.ts | Async list and fallback visibility failures lacked an honest HTTP failure | error-boundary | fixed:tests/integration/conversation-list-pins.test.ts |

New findings this round: 6

## Round 4

Search angles: repeat attention sweep across operational summaries and automatic cards attached to source history.
Surface delta: summaries and automatic contextual components outside board lanes.

| location | behavior | bucket | disposition |
| --- | --- | --- | --- |
| src/core/WorkBoardPickupController.ts:120 | Mixed pickup totals exposed internal parked work on owner board | summary-leak | fixed:tests/integration/agent-work-cards-routes.test.ts |
| src/core/workSourceCards.ts:26 | Automatic source-card lists exposed internal cards and changed revisions | contextual-discovery | fixed:tests/unit/internal-work-owner-surfaces.test.ts |

New findings this round: 2

## Round 5

Search angles: full discovery re-sweep including dark/enabled hierarchy, retained certified inventory and fleet-disabled initialization.
Surface delta: optional graph presentation and absent-runtime semantics on normal installations.

| location | behavior | bucket | disposition |
| --- | --- | --- | --- |
| src/server/conversationGraphViewer.ts:14 | Owner graph presentation admitted retained internal nodes | graph-discovery | fixed:tests/unit/conversation-graph-viewer-review.test.ts |
| src/core/workFrontDoorsGraph.ts:31 | Proposed graph placements included internal cards | graph-proposal | fixed:tests/unit/work-front-doors-graph.test.ts |
| src/server/AgentServer.ts:7413 | Enabled-null guard also blocked legitimate board-disabled native chats | disabled-regression | fixed:tests/e2e/mobile-native-conversations-alive.test.ts |

New findings this round: 3

## Round 6

Search angles: final independent discovery and attention reviews repeated classification, real requester exceptions, lanes/counts/cuts, Projects, source revisions, pickup totals, local/pool pins, scoped keyword/meaning search, unread triggers/hints, graph visibility, runtime enabled/off/null states and durable note restart. Root rechecked the same changed surfaces and preserved execution gates.
Surface delta: none; the expanded surface from the prior rounds was repeated. Independent reviewers concurred with zero new source defects. Targeted tests and four sample-data normal Chrome cases passed. Full-suite and installed behavior remain outside this source-audit claim. Historical classification cannot be asserted where no board runtime or records exist; a genuinely disabled board preserves ordinary chats rather than guessing from titles.

| location | behavior | bucket | disposition |
| --- | --- | --- | --- |

New findings this round: 0
