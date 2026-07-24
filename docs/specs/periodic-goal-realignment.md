---
title: "Periodic Goal Re-Alignment (automatic topic-goal resync)"
slug: "periodic-goal-realignment"
author: "Echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "periodic-goal-realignment.eli16.md"
status: converged
review-convergence: "2026-07-24T13:02:55.412Z"
review-iterations: 6
review-completed-at: "2026-07-24T13:02:55.412Z"
review-report: "docs/specs/reports/periodic-goal-realignment-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 18
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Periodic Goal Re-Alignment (automatic topic-goal resync)

## Problem statement

Long-running work drifts. On 2026-07-23 the operator course-corrected a 14-hour
autonomous drive: its queue contained locally sensible steps whose sum no longer
matched the topic's top-level goals. The operator had to direct the agent to review
the prior week's messages and said that holistic re-alignment should happen
automatically and regularly.

Today the autonomous loop judges progress against the run's own setup-time goal.
That is useful but circular: a drifted run can keep proving progress against its own
drifted restatement. The missing structure is a periodic, evidence-linked comparison
against the verified operator's actual topic messages.

## CLASS review

This is an application of **Structure beats Willpower**, not a new constitutional
article. Multi-hour autonomous work must be periodically re-grounded against
principal-authenticated source evidence. The run's goal and task file are the
*subject* being checked, never the sole source of truth for the check.

The development-process gap was setup-time anchoring without re-observation.
Stop-hook re-feed, completion review, and progress monitoring all inspect the run's
own state. None compares that evolving state with later operator priority changes.

## Goals

1. For an active autonomous run, maintain a compact, source-cited digest of the
   locally verified operator's direct goals, priority changes, cancellations, and
   supersessions in that topic.
2. Compare a canonical snapshot of the run's present direction with that digest
   when either input materially changes, with a 60-minute eligibility wake-up as a
   backstop rather than an unconditional LLM timer.
3. Produce a high-precision, evidence-linked result:
   `aligned | drifting | diverged | indeterminate`.
4. Put the latest fresh brief into every new session identity once, and deliver a
   changed drift/divergence brief to an already-running session at a safe idle
   boundary. The brief is infrastructure-authored advisory data, never a user
   message and never a gate.
5. Make the unchanged steady state structurally quiet: zero LLM calls, zero repeated
   injections, and no operator notices.
6. Preserve enough scrubbed provenance to reproduce each judgment without exposing
   full topic history through logs or HTTP.

## Non-goals

- No blocking, rewriting, pausing, task mutation, or automatic scope expansion.
- No write to the autonomous run's state file. The file is read-only subject
  evidence; writing the verdict into it would create a second writer and a
  self-reinforcing feedback loop.
- No operator-facing attention item in v1. A model's semantic disagreement about
  work direction is not precise enough to page the operator, and the agent-facing
  brief is the remediation this feature exists to provide. Status, failures, and
  disagreement remain pull-visible.
- No cross-topic inference.
- No claim that a sender-verified message is automatically a goal. Forwarded,
  quoted, pasted, ambiguous, or merely discussed material is data to interpret,
  not authority to obey.

## Proposed design

### 1. Canonical source contract: provenance before summarization

The draft originally assumed one durable "sender-verified history" already existed.
It does not. Telegram's native log can carry `telegramUserId` and `forwarded`, the
shared logger renames/drops parts of that provenance, and `TopicMemory` currently
cannot preserve `forwarded` across its derived-index rebuild. The build therefore
starts by establishing one adapter capability:

```ts
interface GoalSourceRow {
  schemaVersion: 1;
  platform: string;
  topicId: string;
  messageId: string;                 // platform-stable, non-user-forgeable
  authenticatedSenderUid: string;    // from the ingress envelope, never content
  receivedAt: string;
  text: string;
  forwarded: false;                  // explicit false; true/unknown is ineligible
  ingressOrigin: 'telegram-poll' | 'telegram-lifeline' | 'authenticated-custody-forward';
  contentHash: string;
}
```

`VerifiedOperatorHistoryReader` is an indexed, chronological, cursor-paginated read
over the canonical topic-history index. For Telegram, JSONL remains disaster-recovery
source and `TopicMemory` is the indexed query layer. The required storage migration
preserves `authenticatedSenderUid`, `forwarded`, platform message ID, and timestamp
through native logging, shared logging, rebuild, restart, and custody forwarding.
The hourly path never synchronously splits the full JSONL.

Each enumerated ingress writer populates identity and forwarding fields directly
from its authenticated platform envelope. A caller cannot construct this row from
request-body fields, display names, or message text.

A row is eligible only when all of these deterministic invariants hold:

- an active run has a locally authoritative `TopicOperatorStore` binding;
- its authenticated sender UID exactly matches that binding;
- `forwarded === false` is explicitly persisted;
- platform/topic/message ID and timestamp are valid;
- the row falls in the bounded source window or is the run's pinned initiating
  operator directive.

UID-less, legacy, forward-provenance-unknown, mixed-principal, or incomplete rows are
excluded. `fromUser`, display names, replicated operator records, and text such as
"from Justin" never establish authority.

Run registration is the principal-capture seam. The authenticated inbound action
that authorizes `/autonomous/register` supplies an initiating platform message ID;
the server resolves that ID in eligible history and atomically captures
`{platform, principalOpaqueId, initiatingMessageId, initiatingLocalContentHash,
bindingEpoch, runId}`. `principalOpaqueId` is a random server-issued 128-bit
identifier scoped to this topic/run binding—not a stable per-UID pseudonym—whose UID
mapping exists only on the authoritative source seat; raw or unkeyed hashes of
enumerable platform UIDs are forbidden in audit, replication, and mesh payloads.
`bindingEpoch` is a new monotonic field on
`TopicOperatorStore`; it increments only when the effective authority tuple
`(platform, authenticated UID)` changes, on explicit unbind, or on an
authority-changing privileged override. An idempotent same-principal observation,
including a display-name/metadata refresh, preserves the epoch. The UID/epoch are
never caller assertions. A privileged administrative registration
must provide a source message ID that the server resolves against the currently
bound operator and records provenance `privileged-admin`; it cannot nominate a UID.
Legacy or otherwise unanchored runs are `source-incomplete` and receive no verdict.

This immutable run-principal key identifies every cache and state row. A later
topic-operator rebind pauses realignment as `principal-changed`; it does not silently
transfer the existing run to the new principal. The run must end and be explicitly
re-registered under the new principal. Histories from different UIDs are never
merged.

The default rolling window is seven days. The verified initiating directive for the
run is pinned until that run ends because it is the run's founding constraint, not a
claim that every old topic priority is still current. No other entry survives after
its last citation leaves the window, even if an earlier digest called it active.
The reader returns coverage metadata:

```text
complete | truncated | source-unavailable
sourceCount, sourceBytes, oldestIncludedAt, newestMessageId, sourceSetHash
```

Reaching a message/byte/page bound before the requested window yields `truncated`;
that can produce no digest or verdict. Adapters without the complete provenance
capability remain honestly unsupported rather than falling back to role-only history.

### 2. GoalDigestBuilder: extractive, incremental, and mechanically grounded

The digest input is the prior validated digest, the pinned initiating directive, and
eligible source changes. Its cache key includes principal key, ordered eligible
source IDs and content hashes, schema version, and rubric version. The state persists
`nextSourceExpiryAt` and wakes exactly when the next unpinned row leaves the window;
a calendar-day rollover alone does not rebuild anything. It rebuilds on
add/edit/delete, provenance repair, actual source expiry, or schema/rubric change. A
run-state-only change does not rebuild it.

Content hashes are local integrity values in the mode-`0600` source/cache store, not
privacy transforms and never cross a machine boundary. Cross-machine and audit
correlation uses random 128-bit source/focus/digest/review/brief generation IDs.
Point-to-point transfer integrity authenticates the encrypted payload/ciphertext,
never a guessable plaintext or UID hash. Generation IDs rotate with their generation
and reveal no short private input by dictionary attack.

The model receives only credential-scrubbed, per-row-clamped text in randomized,
JSON-encoded untrusted-data boundaries with an explicit rule that embedded text is
content to analyze, never instructions. A row that cannot be safely scrubbed is
omitted and makes coverage incomplete. Platform-forwarded rows are already excluded;
quoted or pasted material becomes a goal only when the operator explicitly adopts
it. Ambiguous authorship yields `ambiguous`, not an active priority.

The prompt boundary is defense in depth, not a security proof. The normative boundary
is deterministic source eligibility, exact citation validation, strict schema/size
validation, and `indeterminate` on any incomplete or invalid evidence.

Closed output schema:

```ts
interface GoalDigestEntry {
  id: string;                         // server-derived, never model-authored
  status: 'active' | 'superseded' | 'completed' | 'ambiguous';
  citations: Array<{
    messageId: string;
    timestamp: string;
    exactQuote: string;              // short, scrubbed, bounded
  }>;
  normalizedPriority: string;        // model-authored, visibly labeled
  supersededBy?: string;
}
```

The server derives `id` from the immutable run-principal key plus sorted canonical
citation identities; a rebuild with the same citation set preserves the ID. Every
citation ID must be eligible, its timestamp must match, and its exact quote
must be a substring of that same scrubbed row. Unknown fields, invalid
enums, ungrounded items, over-limit fields, and contradictory supersession graphs
are rejected. Unsupported entries are never salvaged from free text. If validation
leaves conflicting active priorities or incomplete coverage, the digest is
`indeterminate` and cannot drive a direction verdict.

Only the pinned initiating directive survives outside the rolling window. Every
other entry is removed from the live digest/reviewer input when its final citation
expires; the audit retains only its non-content ID/hash and `expired` disposition.
A later eligible message may mark one superseded/completed only with an explicit
cited reversal, replacement, or completion. Absence is never evidence of
supersession. This is a deliberate precision-first v1 tradeoff: a non-initiating
multi-week priority needs a fresh operator mention to remain active, so it cannot
silently become stale authority for `diverged`.

This validated digest is the durable, source-cited *derived goal ledger*. A manually
maintained structured goal form would be cheaper to interpret, but it would make the
operator translate ordinary conversation into a second control surface. The design
gets the same inspectable structure from authenticated messages on change, with the
semantic reviewer used for extraction and audit rather than requiring manual ledger
upkeep.

### 3. RunFocusSnapshot: the monitored file is untrusted subject data

The server recognizes the active run and captures a normalized registration
baseline: run ID, topic, session ID, started-at, canonical registered condition,
initial goal, and initial task fingerprint. Each review builds a bounded current
snapshot from:

- the canonical registered run condition;
- the state-file `## Goal`;
- all unchecked checkboxes or canonical numbered task rows inside `## Tasks`, up to
  a hard bound (legacy numbered lists are never misread as an empty queue);
- a deterministic diff from the registered task baseline;
- the most recent bounded completed tasks and durable progress/handoff records;
- local branch plus bounded recent commit subjects when a worktree is registered.

No network/PR lookup is required. The reader rejects symlinks, oversized files,
malformed or duplicate authoritative fields, topic/run/session mismatch, and a task
set that exceeds the complete-read bound. It ignores bookkeeping fields and excludes
all goal-realignment sidecar/advisory text. State rows are JSON-encoded inside their
own randomized untrusted-data boundary.

The normalized `focusHash` changes only on semantic focus evidence, not mtime,
iteration, report timestamps, or whitespace. Normalized unchecked-task order is
preserved because queue order is part of the near-term plan. Incomplete or
ambiguously mixed task syntax yields `indeterminate`; tail truncation is never
silently presented as a complete queue.

### 4. AlignmentReviewer: judgment within deterministic floors

The reviewer runs only when
`reviewInputHash = digestHash + focusHash + rubricVersion` changes. An unchanged
60-minute wake-up records a cache hit and returns; it is not a new judgment, a new
observation, or a reason to inject. Runs use deterministic settings where supported.

The full-context reflector returns:

```ts
{
  relationship: 'advances' | 'underweights' | 'unrelated' | 'contradicts' | 'unclear';
  verdict: 'aligned' | 'drifting' | 'diverged' | 'indeterminate';
  reason: string;
  operatorEvidence: Array<{digestEntryId: string; messageId: string; quote: string}>;
  focusEvidence: Array<{kind: string; id: string; quote: string}>;
}
```

The semantic boundary is deliberately asymmetric:

- **aligned** — the current plan advances or explicitly accounts for every active
  cited priority; no current objective contradicts one.
- **drifting** — a cited active priority is underweighted or absent from the
  near-term plan, or current work is merely unrelated. Unfinished backlog,
  dependency work, ordering uncertainty, and omission alone can never be
  `diverged`.
- **diverged** — current goal/task/activity evidence explicitly contradicts,
  abandons, or replaces a still-active cited operator priority. It must cite both
  sides. There is no promotion from repeated `drifting` ticks.
- **indeterminate** — incomplete/truncated/conflicting inputs, unclear relation,
  missing/invalid citations, parse failure, or provider failure.

Deterministic validation confirms all citations and exact excerpts against the
validated digest/focus snapshot. `diverged` requires at least one active operator
citation and one positive contradiction/abandonment focus citation. A model cannot
turn absence, a repeated timer, or its own confidence claim into divergence.

### 5. Scheduler, cost, and controller steady state

One durable per-topic scheduler owns evaluation. Session boot/resume merely calls
`ensureReview(topic)` through a singleflight; hooks never wait on an LLM. Startup
restores `nextEligibleAt` with bounded jitter and never treats all topics as newly
due. A late result must still match feature-enabled, principal key, run identity,
ownership epoch, source hash, and focus hash before commit.

Both model calls use `sharedLlmQueue.enqueueMetered()` in the background lane with
explicit component attribution and conservative reservations retained on failure:

- `GoalDigestBuilder`: at most 2 requests/topic/hour and 8/topic/day;
- `AlignmentReviewer`: at most 2 requests/topic/hour and 24/topic/day;
- feature aggregate: 96 requests/day, 500,000 input tokens/day, 50,000 output
  tokens/day, and 50 estimated cents/day;
- one pending call per topic; queue depth coalesces to the newest fingerprint.

The feature aggregate is pool-wide, not per process or per machine.
`GoalRealignmentBudgetAuthority` runs on the canonical ingress/router seat and
transactionally reserves/settles every digest and review admission before an owner
uses its local shared queue. If that single authority is unavailable, the call does
not run. Per-topic reservations and the latest pool ledger generation are included
in the disclosure-minimized replicated projection and transfer barrier, so moving a
run cannot mint a fresh allowance. The local shared queue remains a second,
machine-resource bound.

Because the shared queue's own meter is in-memory, the server-owned budget authority
persists daily request/cost reservations, `nextEligibleAt`, failure streak, and
breaker state.
Provider/admission failure uses exponential backoff (1h, 2h, 4h, capped at 8h) and a
24-hour open breaker after six consecutive failures; a new source/focus generation
may schedule one probe but cannot reset the daily budget. Unchanged evidence cannot
mint a new action budget across restart.

Controller invariant:

```text
unchanged sourceHash + focusHash
  => 0 LLM calls, 0 new briefs, 0 session injections, 0 operator notices
one changed generation
  => <= 1 digest build if source changed, <= 1 review, <= 1 active-session brief
```

The controller is enrolled in the self-action convergence registry and ratchet.

### 5.1 Normative bounds

| Surface | Default hard bound |
|---|---:|
| Source query | 200 rows, 10 pages, 64 KiB scrubbed text |
| One source row | 1,000 characters after scrubbing |
| State file | 256 KiB |
| Current tasks | 100 rows × 500 characters |
| Completed/progress evidence | 20 rows × 500 characters |
| Commit subjects | 10 × 200 characters |
| Digest | 8 entries, 3 citations/entry |
| Citation quote | 240 characters |
| Normalized priority | 280 characters |
| Model input | 96 KiB and 24,000 estimated tokens/call |
| Digest/review model output | 8,000 tokens/call |
| Review reason | 500 characters |
| Session brief | 4 KiB |
| Local quote-bearing cache | 256 KiB/topic |
| Replicated projection | 16 KiB/topic; 2 MiB/store |
| Audit | 20 MiB or 30 days, whichever comes first |
| Status response | 64 KiB |

Crossing a completeness bound yields `indeterminate`, never silent truncation into a
verdict. Every boundary has exact-at, one-over, and adversarial-unicode tests.

### 6. Routing and data exposure

Both component names are registered centrally as category `reflector`, with explicit
attribution (`gating:false`, `injectionExposed:true`) and no `deferrable` flag in v1.
The outer queue is background; the inner router therefore uses the bounded
non-gating failure-swap: one zero-token invocation-failure step, circuit-checked,
never herding onto Claude as a swap target. Invalid JSON, invalid citations, or
semantic output failure is `indeterminate`; it is not a provider-swap trigger.

The design does not hardcode Codex or promise that "off-Claude" is universally
available. The ratified reflector policy prefers an active off-Claude provider and
honors operator overrides. With no off-Claude reflector route, v1 records
`noOffClaudeProvider` and skips the call unless the operator explicitly opts that
component into Claude. This avoids quietly spending the interactive session's
subscription quota.

Eligible operator excerpts and run-state excerpts leave the local process for the
resolved reflector provider. They are credential-scrubbed and byte-clamped before
egress. Raw source bodies are not placed in ordinary audit rows or HTTP responses.
Every attempt records resolved provider/model, outcome, latency, and usage through
the existing token-audit funnel.

These are hard sequencing dependencies, not descriptive aspirations:
`provider-fallback-default-policy.md` supplies registered reflector selection, and
`nongating-failure-swap.md` supplies the one-attempt, zero-token-only, no-Claude swap.
If either contract is unavailable at build time, the feature remains dark.

### 7. Delivery: cache-only at session start, coalesced at idle

`GET /goal-realignment/session-context?topicId=N&sessionId=S` is authenticated,
cache-only, bounded to the existing hook budget, and never launches an LLM. It
idempotently returns the same fresh, identity-matching brief and stable delivery
nonce for `(sessionId, briefFingerprint)`. Valid `aligned`, `drifting`, and
`diverged` cache entries may ground a new session; `indeterminate` never does. Every
new session identity needs current grounding even if the prior session received it
five minutes ago.

For a running session, only a semantically new `drifting` or `diverged` brief creates
a pending delivery. `briefFingerprint` hashes the verdict plus stable server-derived
priority IDs and canonical focus identities, so commits or focus hashes that do not
change the actual brief cannot re-inject it. A framework-general internal injection adapter—not
`AutonomousProgressHeartbeat` and not a Telegram user message—coalesces pending
briefs by topic/run, waits for a proven idle boundary, and delivers at most once per
brief fingerprint when its adapter provides an idempotency receipt; otherwise it
makes at most two attempts with the same nonce. The envelope
identifies infrastructure as sender, marks all quoted
content advisory/untrusted, and includes exact source/focus citations. `aligned` and
`indeterminate` are log-only.

Delivery semantics are honest about the crash boundary. Each adapter returns
`accepted | already-applied | unknown` for the stable nonce. Accepted/already-applied
is durably acknowledged. An `unknown` outcome permits at most one retry, so an
adapter without a durable idempotency primitive is at-least-once with a hard maximum
of two visible copies, never falsely labeled exactly-once. Session context contains
a stable marker so supported launchers deduplicate it before prompt assembly.

Each drift/divergence brief also carries a session-scoped acknowledgment nonce. The
session records `adopted | disagreed | already-addressed | unable-to-assess` plus a
bounded evidence reference through the internal acknowledgment seam. This does not
block work or mutate tasks, but it proves whether the full-context agent processed
the signal. An unacknowledged brief stays visible in cached context and pull status;
it does not page the operator or generate periodic duplicates. This explicit
acknowledgment is the bounded recovery loop: verified exposure plus full-context
disposition, not the reflector coercing the agent's plan.

Pending delivery is server-owned and restart-durable. It expires after 6 hours or
when run/principal/ownership/review hashes change. The adapter has parity seams for
Claude, Codex, Gemini, and Pi launch/resume/compaction paths. If a framework cannot
prove safe idle injection, it receives session-start context only; the capability is
reported rather than guessed.

### 8. Durable state and audit

An atomic server-owned `GoalRealignmentStore` is the authority for cache versions,
budgets, scheduler clocks, pending delivery, and delivery acknowledgments. The
autonomous state file remains untouched. A bounded, scrubbed JSONL judgment log is
append-only audit, not correctness state.

The local record includes principal/run/ownership identity, source and focus hashes,
coverage, validated digest, review result, prompt/rubric/schema versions, due and
breaker state, provider/model attribution, pending brief, and delivery ack. It is
mode `0600`; quote-bearing cache and brief bodies expire after 24 hours and are
deleted immediately on run end, rebind, or feature tombstone. Raw source messages
are never copied into it.

A content-free `BriefRecipe` persists for the run lifetime: verdict, stable digest
entry IDs, source message IDs plus validated quote byte ranges, canonical focus row
IDs/ranges, template version, and opaque generation IDs. It contains no quote,
normalized priority, or model-reason text and never enters pool-wide replication.
After a quote-bearing body expires, session context deterministically re-fetches the
still-eligible source/focus rows, re-validates local content hashes and byte ranges,
and renders a fixed generic brief—zero LLM calls. The point-to-point transfer body
includes this capped recipe. If any row expired, changed, is unavailable, or fails
validation, the current request returns no context. Expired, changed, or invalid
evidence permanently invalidates that generation and yields `indeterminate` until a
genuine source/focus generation change produces a new review. Transient
`source-unavailable` does not poison the generation: deterministic rehydration may
retry with bounded backoff when capability returns, without an LLM call or generation
reset. Hash-only grounding is forbidden.

`GET /goal-realignment` returns redacted per-topic status: source capability and
machine, owner machine, run ID, cache ages and opaque generation IDs,
coverage/truncation, verdict,
cache-hit/call/suppression counters, routing outcome, breaker/budget state, pending
delivery, expired-priority count, unresolved-divergence age, disposition counts, and
framework parity. It never returns raw messages or full model prompts.

### 9. Multi-machine posture

The feature is unified to the active topic, not machine-local.

- **Source history:** proxied-on-read from the canonical ingress/router machine,
  where local authenticated ingress and local `TopicOperatorStore` can perform the
  principal filter. The authenticated mesh response carries source IDs, the
  source-resolved opaque principal ID, coverage, and an opaque source generation ID;
  the destination treats bodies as quoted data. It never uses a replicated advisory
  operator record to establish identity.
- **Evaluation and delivery:** the current topic/run owner with matching ownership
  epoch is the only evaluator and speaker. It suppresses during transfer and applies
  `SpeakerElection` before an active-session injection.
- **Correctness state:** a new `goal-realignment-record` kind rides the existing HLC
  replicated-store foundation. Its strict v1 projection contains only schema version,
  topic/run/principal opaque IDs, ownership epoch, monotonic generation, opaque
  source/focus/digest/review/brief generation IDs, verdict enum, budget counters,
  due/breaker timestamps,
  delivery nonce/status/timestamps, and tombstone metadata. It never contains quotes,
  reasons, normalized priority text, source bodies, or pending brief bodies. The
  owner is the fenced single writer. Receivers accept only the highest ownership
  epoch then generation from the registered owner; foreign/late writers and invalid
  enums/sizes are quarantined. Tombstones dominate live records and retain for 30
  days; live records tombstone at run end or principal change. The kind receives a
  16-KiB entry/2-MiB store budget in the replication journal. Metadata is
  authenticated in transit and plaintext at rest on pool machines; the sensitive
  body remains source-side and is re-fetched/revalidated on demand.
- **Transfer freshness:** goal-realignment projection joins the existing transfer
  drain barrier. The old owner flushes generation `G`; the handoff carries
  `{G, projectionId}`; the new owner cannot inject until it has acknowledged that
  exact or later projection. The existing encrypted point-to-point working-set
  handoff also carries the scrubbed, hard-capped local body snapshot bound to
  `{generation, projectionId, authenticatedCiphertextDigest}`. The destination writes it mode `0600`,
  validates all three anchors, and atomically acknowledges it before serving context
  or active delivery; the old owner deletes its copy after acknowledgment or the
  24-hour retention expiry. The pool-wide replicated projection remains
  metadata-only. If projection or body freshness is unprovable, the new owner remains
  cache/status-only and does not silently recompute or inject. Late old-owner results
  fail the epoch check.
- **Feature activation:** the flag and source/consumer capability are pool-coherent.
  Mixed-version peers no-op with `source-unavailable`/`consumer-unavailable`; there is
  no incomplete local-history fallback.

The router's raw message history is physically tied to its channel credential seat:

`machine-local-justification: physical-credential-locality`

That locality does not fragment behavior because reads are proxied and results/state
are unified. No other new surface is machine-local.

Session-start and active delivery both require the current fenced topic/run owner and
session mapping. Live delivery additionally requires WS3 `SpeakerElection`
enforcement pool-wide; its disabled "speak" default is not sufficient. Until those
preconditions are proven, the feature remains cache/status-only.

### 9.1 Lifecycle definitions

```text
source/focus change
  -> singleflight review-pending
  -> validated result committed for owner epoch
  -> session-start cache eligible (aligned/drifting/diverged)
  -> active pending only if new drifting/diverged briefFingerprint
  -> wait-idle
  -> adapter accepted/already-applied/unknown
  -> durable delivery ack (unknown: one bounded retry)
  -> optional session disposition ack
run end | principal change | owner-epoch loss
  -> cancel/expire local pending body
  -> replicate tombstone or transfer projection
```

`idle` means the framework adapter proves no model/tool turn is active and accepts an
internal input without interleaving user text. `owner epoch` is the fenced
SessionOwnershipRegistry generation for the topic/run. `delivery acknowledgment` is
the adapter result for a stable nonce, not a timer or a successful write to an
intermediate queue. Transfer legality is governed by the drain barrier above.

`fresh cache` means the principal/run/owner epoch, current source and focus
generations, complete source coverage, citation eligibility, schema, rubric, and
template version all still match. It has no arbitrary wall-clock TTL while those
facts are provably unchanged. Loss of source capability, transfer freshness, or any
generation proof makes it immediately ineligible; an old verdict is never served
merely because its timestamp is recent.

## Alternatives considered

- **Manual operator-authored goal ledger:** clearest structure and cheapest review,
  but it makes the operator duplicate ordinary conversation into a control form. The
  source-cited derived ledger keeps the conversational interface while retaining
  inspectable structure.
- **Existing durable job queue/outbox only:** reused for scheduling and delivery
  patterns, but it does not own principal-authenticated history, semantic
  fingerprints, or topic-transfer state. The feature adds a narrow typed state
  machine, not another general queue.
- **Replicate the whole digest/brief:** simpler transfer, rejected because it copies
  private quotes and reasons to every pool machine. Only metadata is replicated; a
  capped body moves point-to-point with the work.
- **New workflow engine/event-sourced subsystem:** rejected. The design composes the
  existing shared LLM queue, server state store, working-set handoff, HLC projection,
  ownership fence, and SpeakerElection. No external orchestrator is introduced.
- **Operator attention after repeated divergence:** rejected for v1. The
  drifting/diverged boundary is semantic and false positives spend scarce attention.
  Verified session exposure plus a closed disposition is the recovery loop;
  unresolved state remains pull-visible.

## Decision points touched

| Decision point | Classification | Floor and arbiter |
|---|---|---|
| Eligible source row and principal binding | invariant | Exact local authenticated UID, explicit non-forwarded provenance, complete coverage |
| Whether text states/adopts/supersedes a goal | judgment-candidate | Bounded cited schema; ambiguous defaults inactive; digest reflector arbitrates meaning |
| State-file/run identity and complete parse | invariant | Server-recognized run, closed sections/limits, mismatch means indeterminate |
| Focus relationship to active priorities | judgment-candidate | Full-context reviewer; cited positive evidence; conservative `indeterminate` fallback |
| `drifting`/`diverged` mapping | invariant | Diverged requires explicit two-sided contradiction/abandonment evidence; absence never qualifies |
| Review admission and cache reuse | invariant | Fingerprint, budgets, singleflight, backoff, ownership epoch |
| Provider selection | invariant | Existing registered reflector policy plus explicit no-off-Claude skip |
| Session context/injection eligibility | invariant | Fresh identity-matching cache, once per session/review hash, proven idle/owner/speaker |
| Session disposition after a brief | judgment-candidate | Full-context session chooses a closed disposition; it cannot block work or alter authority |
| Operator notification | invariant | None in v1 |

## Frontloaded Decisions

1. **FD1:** Telegram is the first supported history adapter; unsupported adapters
   report unavailable rather than losing provenance.
2. **FD2:** The run-initiating verified operator directive is a pinned source anchor;
   the rolling delta window is seven days.
3. **FD3:** Source history is indexed/paginated with explicit completeness; JSONL is
   not scanned on the periodic hot path.
4. **FD4:** Digest entries are extractive and citation-validated; conflicting or
   incomplete evidence is indeterminate.
5. **FD5:** Run focus reads canonical condition plus complete bounded task/progress
   evidence and rejects incomplete state.
6. **FD6:** `diverged` requires positive contradiction/abandonment evidence on both
   sides. Drift never promotes merely because time passes.
7. **FD7:** The 60-minute cadence is an eligibility wake-up. Unchanged semantic
   fingerprints spend and emit nothing.
8. **FD8:** Each new session identity gets the fresh cached brief once; recomputation
   and delivery dedupe are independent.
9. **FD9:** The run state file remains read-only. All feature state lives in a
   server-owned store.
10. **FD10:** Active-session delivery uses an internal framework-general idle
    injector, never Telegram/user provenance.
11. **FD11:** Both calls are registered reflectors and skip when no off-Claude route
    exists unless explicitly overridden.
12. **FD12:** Durable component budgets supplement the in-memory shared queue meter.
13. **FD13:** v1 creates no operator-facing attention item.
14. **FD14:** Source reads are router-authoritative/proxied; correctness state is
    replicated and topic-owner single-writer.
15. **FD15:** Rollout remains dark/dry-run until source, routing, rubric, framework
    parity, and transfer behavior pass objective gates.
16. **FD16:** Delivery is nonce-idempotent where adapters support receipts and
    honestly bounded at-least-once otherwise; no exactly-once claim crosses an
    ambiguous crash boundary.
17. **FD17:** A divergence brief requests a session disposition but never pauses
    work or escalates to the operator.
18. **FD18:** Only the initiating directive survives the seven-day window; other
    priorities require fresh evidence and cannot become stale divergence authority.

## Rollout and rollback

Ship `monitoring.goalRealignment` dark pool-wide. Deployment order:

1. land provenance-preserving source schema/query, mesh source capability, state
   schema, component registration, and status/audit surfaces dark;
2. advertise source/consumer versions and require pool coherence;
3. run fixture + test-agent dry-run, then dev-agent single-machine dry-run;
4. exercise a real topic transfer in multi-machine dry-run;
5. enable cache-only session-start context on the dev agent;
6. enable active-session idle delivery only after framework parity evidence, the
   transfer freshness barrier, fenced ownership, and WS3 one-voice enforcement are
   live pool-wide.

The live off-switch cancels timers/singleflights where possible, rejects late results
at their final enabled/epoch check, expires pending injection, and makes context/status
return 503. It preserves bounded state/audit for diagnosis and re-enable and never
edits the autonomous run.

## Maturation plan

- **test-agent-live:** Dark source/rebuild tests plus labeled fixture battery; then dry-run judgments with no injection.
- **dev-agent-live:** Single-machine dry-run, transferred-topic dry-run, cache-only session context, then idle delivery after all gates pass.
- **fleet:** Remains dark until dev evidence passes and pool capability/flag coherence is verified; fleet activation is a separate deliberate change.
- **graduation criterion:** At least 100 independently adjudicated eligible cases, at least 40 predicted-`diverged` cases, and at least 40 labeled omission/contradiction cases; the model under test cannot label its own sample. Every dry-run divergence is adjudicated by the operator or an independent frontier reviewer. Require zero uncited/invalid divergence, at least 95% observed divergence precision with a Wilson 95% lower bound of at least 90%, at least 85% recall on the labeled omission/contradiction set (reported separately for `drifting` and `diverged`), at least 90% combined aligned/drifting accuracy, no more than the explicitly bounded duplicate under an injected crash fixture and zero duplicates where an adapter promises idempotency, and cost within declared budgets. Results are broken down by provider/rubric and stored in a signed soak artifact.
- **dark-window:** Minimum 7 consecutive days on the dev agent, including one restart, one CONTINUATION, one provider failure, and one topic transfer.

## Acceptance matrix

| Scenario | Expected |
|---|---|
| Unchanged source/focus across repeated ticks and restart | Zero new LLM calls and injections; cached status only |
| New operator message, unchanged run state | Digest rebuild + one review, within budgets |
| State focus changes, no operator message | No digest rebuild; one review on changed focus hash |
| State mtime/iteration/whitespace only changes | Focus hash unchanged; zero review spend |
| Unfinished priority or dependency work | At most `drifting`; never `diverged` from absence |
| Explicit current contradiction with valid two-sided citations | May produce `diverged` |
| Repeated identical `drifting` or `diverged` | No promotion, new call, reinjection, or operator notice |
| Invalid/missing citation or malformed model output | `indeterminate`, no injection |
| History cap reached before lookback boundary | Coverage `truncated`; no digest verdict |
| Forwarded/UID-less/mismatched-principal row | Excluded; never used as source |
| Operator binding changes | Old cache closes; fresh principal baseline required |
| Same authenticated operator sends another message | Binding epoch unchanged; run principal remains valid |
| New session identity with fresh cache | Idempotent cache read + stable nonce; no LLM wait |
| Same session/review hash repeats | Delivery suppressed |
| Focus hash changes but semantic brief does not | No active-session reinjection |
| Digest rebuild adds unrelated source but priority citations are unchanged | Stable priority ID and brief fingerprint; no reinjection |
| Changed drift brief while session is mid-turn | One durable pending brief, coalesced and delivered at safe idle |
| Adapter crashes after send before ack | Same nonce; idempotent adapter suppresses, other adapter permits at most one duplicate |
| Brief delivered | Closed session disposition is audit-visible; no disposition does not block or page |
| Feature disabled while review/delivery pending | Late result/delivery suppressed; state retained |
| Topic transfers mid-review | Old result epoch-rejected; new owner restores dedupe/state |
| Transfer state freshness unproven | Cache/status only; no active injection |
| Source peer unavailable after transfer | `indeterminate/source-unavailable`; no local-history fallback |
| Quote body expires but recipe evidence is unchanged | Deterministic rehydration; zero LLM calls |
| Recipe row expired/changed/invalid | Generation invalidated; no context or hash-only reconstruction |
| Recipe rehydration hits a transient source outage, then source recovers | First request no context; bounded no-LLM retry succeeds on unchanged generation |
| Claude/Codex/Gemini/Pi session start | Equivalent cache-only context contract |
| Framework cannot prove idle injection | Session-start only, capability reported |
| No off-Claude reflector available | Skip + counter unless explicit operator override |
| Provider or queue repeatedly fails | Durable backoff/breaker; no hourly retry storm |
| HTTP status read | Authenticated, redacted, bounded; no raw source bodies |

## Open questions

*(none)*
