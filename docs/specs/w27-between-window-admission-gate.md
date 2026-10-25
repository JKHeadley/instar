---
slug: w27-between-window-admission-gate
title: W27 Between-Window Admission Gate
author: echo
project: pathway
parent-principle: Structure beats Willpower
status: pending-operator-approval
approved: true
approval-provenance: "adopted from verified operator handoff: Telegram topic 36966, message row 58529, timestamp 2026-08-26T12:14:23Z, text \"Approved\"; local laptop store did not independently contain/re-read this row"
eli16-overview: w27-between-window-admission-gate.eli16.md
lessons-engaged:
  - P2-signal-vs-authority
  - P5-agent-awareness
review-convergence: "2026-08-26T07:43:08.112Z"
review-iterations: 3
review-completed-at: "2026-08-26T07:43:08.112Z"
review-report: "docs/specs/reports/w27-between-window-admission-gate-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex-cli and gemini-cli were detected but all attempted external passes degraded with reason error"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 4
contested-then-cleared: 0
---

# W27 Between-Window Admission Gate

## Status

This is the technical companion to
`docs/specs/w27-between-window-admission-gate.eli16.md`. It documents the W27
admission gate as built in the candidate clone. It is not an operator approval
record. It does not mark this work approved.

The gate is a bounded preflight for the W27 charter-opening evidence package.
It is implemented as one shared evaluator, one CLI command, and one
authenticated HTTP route:

- `src/core/BetweenWindowAdmissionGate.ts`
- `src/commands/gate.ts`
- `src/cli.ts`
- `src/server/routes.ts`

The evaluator reads a Telegram JSONL message store and validates that the
submitted admission package has the receipt shape and store-backed references
required by the W27 charter. The gate writes no durable state, performs no
Telegram/network calls, posts no topic messages, and does not reconcile the
observer corpora.

## Problem statement

Between-window charter opening needed a deterministic preflight that refuses
packages missing the specific W27 evidence surfaces: both observers'
full-history receipts, three tenet reaffirmation receipts, store-backed message
references, and the two known corpus mismatches. The built gate is that
preflight. It is intentionally narrower than approval, truth adjudication, or
release certification.

The result is structural-store-presence-only. `admitted: true` means the
package passed the implemented shape checks and all referenced rows were present
in the selected local Telegram JSONL store. It is non-authoritative for
semantic truth, quote accuracy, receipt authenticity, observer assessment
correctness, operator intent, corpus reconciliation, release readiness, or
Zero-Failure. The response object does not include an `admissionScope` field;
that absence is an as-built limitation, so callers must not infer a wider scope
from `admitted: true`.

## Proposed design

As built, the design is a shared evaluator with two caller surfaces:

- CLI: `instar gate between-window --package <file> [--store <path>] [--json]`.
- HTTP: `POST /gate/between-window-admission`.

Both surfaces call `evaluateBetweenWindowAdmission()`. The evaluator loads one
local Telegram JSONL store, validates the package object, emits structured issue
codes for refusals, and returns the result without writing state or contacting
Telegram.

## Decision points touched

The gate touches only the W27 charter-opening admission decision: can this
package proceed past the between-window structural preflight. It does not touch
operator approval, spec approval, observer truth reconciliation, canonical
corpus selection, production deployment, release records, or full-suite
certification.

## Scope

In scope:

- Structural validation of the W27 between-window admission package.
- Store-presence checks against `.instar/telegram-messages.jsonl`, or an
  explicit store path passed by the CLI.
- Refusal issues surfaced as structured issue codes.
- CLI refusal by nonzero process exit.
- HTTP refusal by `409`, and HTTP pass by `200`.
- Disclosure that the two known corpus mismatches were surfaced.

Out of scope:

- Choosing which observer corpus is correct.
- Proving quote text semantically matches the whole corpus.
- Judging operator intent or observer assessment quality.
- Writing approval records, spec approval marks, plan-page results, release
  records, or deployment proof.
- Claiming a clean certifying full-suite run.

This is intentionally a hard structural gate, not a meaning reviewer.

## Multi-machine posture

The admission route is machine-local and safe only on the machine whose local
store is the intended evidence authority. `POST /gate/between-window-admission`
uses `ctx.config.stateDir` and does not accept a `storePath` override, so it
evaluates against that server's local `.instar/telegram-messages.jsonl`.

Safe use is:

- Call the HTTP route only on the authoritative store-holder machine for the
  evidence package being checked.
- When checking against a different intended store, use the CLI with
  `--store <path>` on the machine that can read that store.

Wrong-machine or stale-store situations are not separately coded as their own
refusal class. They can currently collapse into ordinary refusals such as
`STORE_UNREADABLE` or `RECEIPT_NOT_IN_STORE`, depending on what the local store
contains.

## Frontloaded Decisions

- The gate is a structural admission preflight, not a semantic or authenticity
  verifier.
- HTTP evaluation is local-store-bound; CLI `--store` is the override path for
  checking a specific non-default store.
- Operator approval remains an out-of-scope authority boundary after
  convergence. It is not a live builder decision and is not granted by this
  spec.

## Open questions

*(none)*

## Future Work

Future work could choose to add cryptographic binding, route-specific rate
limits, package cardinality caps, or a response `admissionScope`, but none of
those are claimed as built here.

## Package Contract

`evaluateBetweenWindowAdmission()` accepts:

```ts
{
  stateDir: string;
  package: unknown;
  storePath?: string;
}
```

Unless `storePath` is provided, the evaluator reads
`<stateDir>/telegram-messages.jsonl`. Store rows are JSONL objects from which
the gate uses `topicId` or `topic_id`, `messageId` or `message_id`, and `text`.
Malformed JSON or an unreadable store is a refusal.

The admission package must be a JSON object with:

- `fullHistoryReceipts`: at least two entries, including one receipt for
  `observer-1` and one receipt for `observer-2`.
- `tenetReaffirmationReceipts`: receipt entries covering `start`, `middle`, and
  `end`.
- `knownCorpusMismatches` or `corpusMismatches`: entries surfacing both known
  mismatches.

Each full-history receipt is evaluated against the between-window observer
topic encoded by `BETWEEN_WINDOW_OBSERVER_TOPIC_ID` (`43003`). As built, if a
full-history receipt omits `topicId`/`topic_id`, the evaluator defaults it to
`43003`; any explicit non-`43003` topic is refused. Each full-history receipt
must name a stored `messageId`; the message must exist in the Telegram JSONL
store.

Each full-history receipt's embedded `receipt` object must provide:

- `historyScope: "full-history"`.
- `canonicalSource` naming a source by `name`, `uri`, or `path`.
- `canonicalStore` naming a store by `name`, `uri`, `path`, or `type`.
- `dateSpan` with non-empty `from` and `to`.
- `population` with positive message and author counts.
- `extractionContract.rule`.
- `dedupeContract.rule`.
- `semanticAuthorArtifact.agentThroughOperatorRows`.
- `semanticAuthorArtifact.justinRows`.
- `corpusHash` in `sha256:<64 hex characters>` form.
- Non-empty `quotes`.
- `assessment.summary`.
- `storedMessageIds` whose referenced messages exist in the store.

If `assessment.status` is `posted`, `assessment.storedMessageIds` must also
point to messages that exist in the store. Agent account rows in the semantic
author artifact must not be classified as Justin.

Each tenet reaffirmation receipt must name `topicId`, `messageId`, and a
receipt with `canonicalStore` or `store` as a non-empty string, plus a
`corpusHash` or `textHash` in `sha256:<64 hex characters>` form. The named
message must exist in the store. Unlike full-history receipts, the built tenet
receipt path does not accept an object-valued `canonicalStore`; that is an
as-built package-shape limitation.

## Binding and authenticity limits

Full-history receipts are not cryptographically or textually bound to the
referenced stored row. The gate verifies that referenced rows exist and that
embedded receipt fields are structurally present and valid. It does not
recompute corpus hashes, verify that quote text appears in the stored message,
compare receipt JSON against the stored message text, verify signatures, or
bind receipt JSON to the row it references.

`corpusHash` and `textHash` are format checks only: `sha256:<64 hex
characters>`. Passing the check does not prove the digest matches any corpus or
stored row.

## Cost and input bounds

Built bounded-cost posture:

- The production `AgentServer` installs `express.json({ limit: '12mb' })`, so
  the HTTP body parser has a global 12 MB JSON body limit before this route.
- The route is behind global bearer authentication and global request-timeout
  middleware.
- The evaluator is synchronous, local, and performs no network calls.

Limits not built:

- No route-specific rate limiter is attached to
  `POST /gate/between-window-admission`.
- The evaluator does not enforce hard cardinality caps for receipt arrays,
  mismatch arrays, `storedMessageIds`, or `quotes`.
- The evaluator does not enforce per-string length caps inside the package.
- The CLI reads the package file and store into memory without an explicit
  package-size or store-size cap beyond host/runtime limits.

The safe caller posture is therefore low-QPS operator/orchestrator use with
trusted local package files and stores. It is not documented here as a
high-volume, internet-facing, or adversarial-upload endpoint.

## Required Corpus Mismatches

The gate requires both known mismatches to be explicitly surfaced. It refuses a
package that omits either mismatch or gives an invalid mismatch shape.

The required mismatch constants as built are:

| Scope | Observer 1 side | Observer 2 side |
| --- | --- | --- |
| `pathway` | source `union archive`, `2469` messages, `137` authors | source `store`, `2809` messages, `122` authors |
| `observer-1-topic-36966` | source `union archive`, `1448` messages, `299` authors | source `store`, `1503` messages, `289` authors |

This only proves disclosure. It does not resolve the mismatch.

As built, mismatch inputs are read from `knownCorpusMismatches` first, otherwise
`corpusMismatches`. Each entry must include `scope`, `observer1`, `observer2`,
and non-empty observer/source labels plus positive message and author counts.
The observer labels are required shape fields and must be non-empty, but the
required-match comparison uses `scope`, both source labels, and both count
pairs; it does not compare the observer label strings to required constants
after shape validation. Invalid entries are reported with
`KNOWN_CORPUS_MISMATCH_NOT_SURFACED` at a `knownCorpusMismatches.*` issue path
even when the caller used the `corpusMismatches` alias.

## Refusal Behavior

The evaluator returns:

```ts
{
  admitted: boolean;
  issues: AdmissionIssue[];
  checked: {
    observerReceiptTopicId: 43003;
    fullHistoryReceipts: number;
    tenetReceipts: number;
    storePath: string;
    storeMessages: number;
  };
  corpusMismatches: CorpusMismatch[];
}
```

The built issue code set is:

- `PACKAGE_SHAPE_INVALID`
- `STORE_UNREADABLE`
- `WINDOW_ONLY_READ`
- `RECEIPT_NOT_IN_STORE`
- `RECEIPT_FIELD_MISSING`
- `OBSERVER_RECEIPT_MISSING`
- `COUNT_WITHOUT_HASH_OR_RULE`
- `POSTED_ASSESSMENT_MISSING_FROM_STORE`
- `AGENT_ACCOUNT_CLASSIFIED_AS_JUSTIN`
- `TENET_RECEIPT_MISSING`
- `KNOWN_CORPUS_MISMATCH_NOT_SURFACED`

`instar gate between-window --package <file>` reads the package JSON, calls the
same evaluator, prints either `between-window admission: PASS` or
`between-window admission: REFUSE`, and exits nonzero when `admitted` is false.
It also accepts `--store <path>`, `--json`, and `-d/--dir <project>`.

`POST /gate/between-window-admission` calls the same evaluator with
`ctx.config.stateDir` and the request body. It returns `200` when admitted and
`409` when refused. The route is covered by the server's normal authentication
middleware because it is registered on the ordinary authenticated router. The
new `/gate` route prefix is classified in `src/server/CapabilityIndex.ts` as an
internal operator admission-check namespace, not as a user-facing
`/capabilities` entry.

The HTTP response is the evaluator result as shown above; it does not include
`admissionScope`, a machine-authority marker, a stale-store distinction, or a
cryptographic receipt-binding proof.

## Must-Fail Controls Proven

The unit tests in `tests/unit/between-window-admission-gate.test.ts` prove that
the gate refuses:

- A window-only read, by emitting `WINDOW_ONLY_READ`.
- Population counts without a valid hash and extraction/dedupe rule, by
  emitting `COUNT_WITHOUT_HASH_OR_RULE`.
- An assessment marked `posted` whose stored assessment id is absent from the
  store, by emitting `POSTED_ASSESSMENT_MISSING_FROM_STORE`.
- An agent-account row classified as Justin, by emitting
  `AGENT_ACCOUNT_CLASSIFIED_AS_JUSTIN`.

The same unit file also proves refusal when the two full-history receipts come
from the same observer, and refusal when required mismatch disclosure is absent.

`tests/integration/between-window-admission-route.test.ts` contains route
coverage for a complete package passing with `200`, and for an absent posted
assessment id refusing with `409`. `tests/e2e/between-window-admission-lifecycle.test.ts`
contains app-level HTTP refuse-then-pass lifecycle coverage. This lifecycle is
not classified here as canonical production-init Tier 3 coverage because this
spec does not cite proof that it mirrors `server.ts` production initialization.

Evidence limitation: the candidate evidence records that listener-backed
focused runs for the route and lifecycle files were blocked in this sandbox by
`EPERM` listener binds. The same behavior is still represented by the tests, but
this spec does not claim a live deployed listener proof for the admission route.

## Lane 1 Relationship

Lane 1 repairs are separate from the admission gate. They address state
lifecycle truth after a window is already in motion. They do not change the
admission package contract above.

As built in the candidate, lane 1 behavior includes:

- `JobScheduler.triggerJob()` calls `refreshJobs()` before admission and refuses
  with `job_skipped` events when a job is missing, disabled, or the job set
  cannot be reloaded.
- `processQueue()` also refreshes before draining and refuses queued jobs that
  are missing or disabled in the live job set.
- The reload is disk-authoritative for the MANIFEST only (existence, `enabled`,
  schedule, priority, machine scope). The agentmd BODY keeps its trigger-boundary
  ownership: a validated on-disk edit takes effect on the run being triggered
  (logged once per change), while an enabled manifest whose body cannot be
  loaded right now (deleted, unreadable, malformed frontmatter, oversize,
  symlinked) is rehydrated from the current manifest plus the LAST VALIDATED
  body instead of vanishing from the live set — with the existing warning,
  deduped by disk state. `enabled` still comes from disk, so a disable or a
  manifest removal is refused exactly as above; a job that never had a
  validated body stays dropped. A prose-only body edit therefore does not
  rebuild the cron tasks. (Observer 2 final ruling, finding A.)
- The body fallback is bound to the path the CURRENT manifest resolves to
  (`<jobsRoot>/<origin>/<slug>.md`): an origin change on the same slug with a
  broken new body drops the job rather than running the old origin's file.
- Only the first load prints the loader's boot-time audits; every later
  trigger-boundary reload is quiet. The loader still returns every line it
  would have printed (all classes: missing jobs file, invalid legacy entries,
  legacy-shadowing, grounding, deprecation, agentmd problems), and the
  scheduler reports each once per transition — again on recurrence after it
  clears — rather than once per trigger. Body-class agentmd problems are
  reported only by the trigger-boundary body refresh.
- `PATCH /jobs/:slug` writes the enabled flag, refreshes the live scheduler, and
  returns failure if the live scheduler still reports the old enabled state.
- `POST /jobs/:slug/trigger` and `POST /jobs/:slug/run` return `409` when
  `triggerJob()` reports `skipped`.
- `notifyJobComplete()` saves the authoritative job state before recording run
  history completion.

The focused evidence cited by the gate-three package maps this to:

- `tests/unit/job-toggle-route-must-fail.test.ts`
- `tests/unit/JobScheduler.test.ts`
- `tests/integration/scheduler-live-state-lifecycle.test.ts`
- `.instar/w27/deploy-evidence/candidate/fix-no-silent-fallbacks.md`

The candidate package reports focused green evidence for these checks, not a
clean certifying full-suite release.

## Lane 2 Relationship

Lane 2 repairs are also separate from the admission gate. They address admission
and delivery truth under saturation. They do not relax or expand the
between-window package validator.

As built in the candidate, lane 2 behavior includes:

- `/sessions/spawn` validates lane, orchestrator, and Pathway-style spawns with
  `resolveSessionSpawnTopicBinding()`. If a topic binding is required and no
  positive `topicId` is provided, the route refuses instead of spawning an
  unbound session.
- Topic-bound spawns pass the topic id to `SessionManager.spawnSession()`, then
  register the topic/session binding through `TelegramAdapter.registerTopicSession`
  or the disk fallback `topic-session-registry.json`.
- `relayOutbound()` only returns success when the holder returns a positive
  `messageId` and `destinationStoreConfirmed: true`; a holder `2xx` without
  destination-store confirmation is treated as undelivered.
- `POST /telegram/reply/:topicId` checks recent topic history after
  `sendToTopic()` and returns `destinationStoreConfirmed`.
- The session-pool activation wiring tests assert that failed owner-side resume
  paths call `reportPeerInjectError()`.

The focused evidence cited by the gate-three package maps this to:

- `tests/unit/session-spawn-topic-binding.test.ts`
- `tests/unit/telegram-relay-timeout-observability.test.ts`
- `tests/unit/session-pool-activation-wiring.test.ts`
- `tests/unit/telegram-tokenless-relay.test.ts`
- `tests/unit/session-telegram-inject.test.ts`
- `.instar/w27/deploy-evidence/candidate/fix-relay-kind-forward.md`
- `.instar/w27/deploy-evidence/candidate/fix-session-pool-activation.md`

Evidence limitation: the gate-three package explicitly records that lane 2's
listener-backed route/E2E proof could not run in this sandbox because listener
binds were refused with `EPERM`. The accepted candidate evidence is
helper/unit/destination-store evidence, not listener-backed green proof.

## Lessons engaged

P2 Signal vs Authority: the gate is a hard invariant for a narrow structural
boundary because a missing receipt, missing store row, invalid hash shape,
window-only read, or undisclosed known mismatch must refuse deterministically
before charter-opening proceeds. Its authority is limited to that structural
admission preflight; the spec separately states that semantic truth, receipt
authenticity, observer correctness, corpus reconciliation, and approval remain
outside the gate's authority.

P5 Agent Awareness: the HTTP route is an internal operator/orchestrator surface
behind the existing server bearer auth and omitted from user-facing capability
discovery. This is an internal-only exception, not a new user or general-agent
runtime affordance.

## Evidence Basis

Evidence available in this candidate clone:

- `.instar/w27/deploy-evidence/gate-three/GATE-THREE-PACKAGE.md`
- `.instar/w27/deploy-evidence/candidate/CANDIDATE-GREEN-EVIDENCE.md`
- `.instar/w27/deploy-evidence/candidate/COMPOSE-STATUS.md`
- `.instar/w27/deploy-evidence/candidate/focused-checks.exit-summary.txt`
- `.instar/w27/deploy-evidence/candidate/rerun-red-classification.md`
- `.instar/w27/deploy-evidence/candidate/fix-no-silent-fallbacks.md`
- `.instar/w27/deploy-evidence/candidate/fix-relay-kind-forward.md`
- `.instar/w27/deploy-evidence/candidate/fix-session-pool-activation.md`
- `upgrades/side-effects/w27-between-window-admission-gate.md`
- Source and tests listed in the sections above.

The gate-three package says the candidate status is "candidate
regression-green by evidence." It also says there is no clean-suite claim. The
evidence record includes classified full-suite failures. The rerun-red
classification records `6` contention failures, `1` wake-socket
long-temp-path `EINVAL` failure classified outside the W27 candidate defects,
and `0` W27 candidate defects for the second counting run. This spec does not
itself certify Zero-Failure and does not claim a clean certifying full-suite
run.

The inspected candidate file list produced no
`.instar/w27/deploy-evidence/item0/` files. Although the side-effects artifact
lists item0 evidence paths, those files are absent from this clone and are not
used as substantiating evidence in this spec.

The same candidate file inspection found
`upgrades/side-effects/w27-between-window-admission-gate.md`, but no same-PR
ordinary upgrade or "next fragment" artifact for this work. This spec therefore
does not claim L10 release-fragment satisfaction.

## Approval Boundary

This spec records that the gate exists and what it validates as built. It does
not claim the W27 release can complete without an operator approval action,
because this repository's spec approval mark is structurally the operator's.
No agent should change the approval field to the true value or forge
`approved-by` for this spec.
