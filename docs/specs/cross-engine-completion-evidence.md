---
title: "Instrumented Cross-Engine Local Completion Evidence"
slug: "cross-engine-completion-evidence"
author: "Instar-codey"
status: draft
parent-spec: "docs/specs/correction-class-review-and-verify-before-done.md"
parent-principle: "Verify the State, Not Its Symbol"
characterization-report: "docs/specs/reports/cross-engine-completion-characterization.md"
eli16-overview: "cross-engine-completion-evidence.eli16.md"
lessons-engaged:
  - "Structure beats Willpower"
  - "Signal vs. Authority"
  - "Observation Needs Structure"
  - "No Silent Degradation to Brittle Fallback"
  - "Verify the State, Not Its Symbol"
  - "Framework-Agnostic — and Framework-Optimizing"
  - "Testing Integrity"
  - "Migration Parity"
  - "Cross-Machine Coherence"
review-convergence: "2026-07-24T17:18:38.384Z"
review-iterations: 10
review-completed-at: "2026-07-24T17:18:38.384Z"
review-report: "docs/specs/reports/cross-engine-completion-evidence-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 14
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Instrumented Cross-Engine Local Completion Evidence

## Executive summary

The existing completion check reads Claude Code JSONL and intentionally no-ops for every other
engine. This design replaces that engine-specific transcript dependency with one Instar-owned
protocol for Claude Code, Codex CLI, Gemini CLI, pi, and Instar-native jobs.

The scope is deliberately narrow:

- only sessions launched through Instar's owned launcher/supervisor;
- only deterministic local action rows: `test-run`, `build-run`, execution-only
  `local-command`, and causally verified `file-write`;
- observe-only results: `verified | contradicted | unknown`;
- no LLM judge, no prose parser, no durable-external verification, no claim of complete sandbox
  confinement, and no arbitrary standalone CLI coverage.

Pushes, messages, cloud/database mutations, MCP/vendor effects, eventually consistent providers,
and hidden out-of-band side effects are `unsupported-for-verification` in this contract. They
require separate specs. This document contains no receipt listener, workflow engine, outbox,
provider callback, or broad-confinement design.

The first release admits one Instar-native `test-run` row. Later rungs reuse the frozen protocol for
Claude and Codex, then Gemini and pi. No later rung blocks the seed.

## Terms and closed states

- **Authoring engine:** the CLI/job engine running the session.
- **Instrumented session:** a session whose launcher owns the turn binding, mediated action seam,
  child process, final response sink, and turn close.
- **Mediated action:** an action invoked through the registered supervisor seam before any side
  effect; unmediated work is outside this spec.
- **Turn binding:** a signed opaque identity joining one logical session turn to its actions and
  evidence without using timestamps or text.
- **Action row:** one engine + action-kind + schema-version verification contract.
- **Canonical close:** the launcher-controlled final response assembled from the complete mediated
  action candidate set.
- **Freeform close:** untrusted engine prose, visibly unverified.
- **Pool:** this agent's authenticated enrolled machines. It is not public or cross-tenant.
- **Projection:** the bounded scrubbed read model stored by `ClaimObservationRecorder`.
- **Sentinel:** a closed candidate entry representing unsupported, unknown, or over-limit work
  without pretending it is a supported action.
- **CAS:** compare-and-swap; a write succeeds only from the expected prior revision.
- **Rollout rung:** one ordered dark, dry-run, or observe-only activation step.

No implementation, config, metric, or Process Health view may invent composite state shorthand:

| Object | Field | Closed values |
|---|---|---|
| engine build | `support` | `absent | build-supported` |
| fleet engine | `enablement` | `disabled | enabled` |
| action row | `disposition` | `uncharacterized | eligible | unsupported-for-verification` |
| host canary | `runnability` | `never-observed | runnable-fresh | unrunnable-fresh | stale` |
| stream proof | `streamOwnership` | `missing | current | stale | failed` |
| evidence source | `availability` | `complete | partial | unavailable | conflicted` |
| turn close | `mode` | `canonical | freeform | invalid | missing` |
| declared clause | `verdict` | `verified | contradicted | unknown` |
| rollout | `mode` | `off | dark | dry-run | observe-only` |
| engine health | `coverage` | `mediated-local-action-verification | partial-mediated-local-verification | not-verified` |

`instrumentedAdmitted` is derived, never persisted:

```text
enablement=enabled
+ runnability=runnable-fresh
+ streamOwnership=current
+ disposition=eligible
+ action row named in the authenticated observe-only generation
```

Coverage is deterministic:

| Label | Derivation |
|---|---|
| `mediated-local-action-verification` | the authenticated exhaustive engine/build manifest contains every registered or observed mediated row; every row has `instrumentedAdmitted=true`; and current instrumented-turn coverage is ≥95% |
| `partial-mediated-local-verification` | at least one manifest row has `instrumentedAdmitted=true`, but any row is omitted/uncharacterized/unsupported/ineligible or coverage is <95% |
| `not-verified` | no scoped row is instrumented-admitted, or observe-only is inactive |

An unknown clause does not change engine coverage. Coverage does not change a clause verdict.
The manifest is the union of the reviewed registry and dark observed candidate inventory, including
unsupported and unknown sentinels. It is generation-CAS protected and shrink-only: removing a row
requires a reviewed disable/removal migration in the same change. A newly observed omitted kind
immediately forces `partial-mediated-local-verification`; rollout config cannot select a favorable subset.

## CLASS review

### Missing standard

**An agent-general mechanism MUST carry a characterized row for every build-supported engine.**
Each admitted row names its canonical evidence contract, instrumented primary, fault-separated
deterministic verifier or proven native redundancy, real fixture, and failure tests. Missing
coverage is an explicit row disposition and clause `unknown`, never a silent no-op.

### Development-process gap

The parent review accepted a declared Claude-only no-op as complete. It did not require:

- an engine/action coverage matrix;
- real fixtures per engine;
- a CI ratchet tying build-supported engines to rows and benchmark cases;
- a fault-separated redundancy test;
- proof that output after a completion declaration cannot reach the user.

The process fix is a coverage-preserving registry plus CI that fails when a build-supported engine
lacks a row. Rows may remain `uncharacterized` in dark/dry-run, but observe-only authority requires
`eligible`.

## Characterization conclusion

The requested LLM pathway characterization was completed and is retained in
`docs/specs/reports/cross-engine-completion-characterization.md`.

On 2026-07-24, authenticated live reads returned explicit degraded states:

- `GET /doorways`: 503, no Instar-source manifest resolvable from the configured project directory;
- `GET /decision-quality`: 503, uniform provenance seam dark;
- `GET /benchmark-divergence`: 503, detector dark.

Direct probes found Claude Code/headless, Codex, and pi runnable; the Gemini shim lacked a selected
asdf version. The closest `completion-judge` benchmark showed strong research candidates, but its
inputs are transcript-shaped rather than the canonical envelope in this design. The durable
prediction mirror contains `tone-gate`, not completion-evidence judgments.

Therefore no model/door route is admitted. V1 is deterministic. Measured model routes remain
research only and have no runtime registry row, fallback authority, or activation implied here.

## Scope and trust model

Instar trusts the model to produce ordinary work, but not to identify or prove what it completed.
The launcher derives the action candidate set from mediated action intents/results and renders the
final evidence block. The model may add commentary only in a visibly unverified channel.

This design trusts the local Instar launcher/supervisor and host key. It does not claim resistance
to a compromised host or malicious supervisor. Each verified clause displays a `verificationBasis`:

| Basis | Meaning |
|---|---|
| `trusted-local-supervisor` | owned launcher and supervisor observed the exact action |
| `independent-local-producer` | a separate local producer/store supplied the matching report/state |
| `authoritative-local-state` | a read-only verifier proved the exact causal local state transition |

These labels do not say “independent host” or “remote authority.” Process Health and audit preserve
the basis.

Out of scope and mechanically unsupported:

- sessions not launched through the owned boundary;
- network/provider durability claims such as push delivered or message sent;
- cloud, database, MCP/vendor, or background effects outside registered local mediation;
- eventual consistency, post-turn settlement, retries, or pending verdicts;
- proof that an unconfined engine performed no hidden filesystem/network action;
- blocking or rewriting an outbound message.

An out-of-scope action receives row `disposition=unsupported-for-verification`; any clause about it
gets `verdict=unknown`. No generic workflow/outbox machinery is needed.

## Canonical protocol

### 1. Launcher-owned action candidates

Before each mediated action, the supervisor mints an opaque 128-bit `actionId`, binds it to the
signed `{agent, machine, engine, session, turn}` launch context, and records the registered action
kind, schema version, and target identity hash. Results must echo the same binding.

Candidate representation exists before schema lookup, so unsupported actions cannot disappear:

```ts
type ActionCandidateV1 = {
  actionIdHash: string;
  turnBindingHash: string;
  kind: 'test-run' | 'build-run' | 'file-write' | 'local-command'
      | 'unsupported' | 'unknown' | 'action-limit-exceeded';
  observedClass: 'registered-local' | 'registered-out-of-scope' | 'unrecognized'
               | 'limit-sentinel';
  actionSchemaVersion: number;
  targetIdentityHash: string;
  safeDisplay: 'test' | 'build' | 'file-change' | 'local-command'
             | 'unsupported-action' | 'unknown-action' | 'action-limit-exceeded';
  disposition: 'uncharacterized' | 'eligible' | 'unsupported-for-verification';
  overflowCount?: number; // saturated at 255; valid only for action-limit-exceeded
};
```

Supported kinds require `actionSchemaVersion >= 1` and their registered target extractor.
`unsupported | unknown | action-limit-exceeded` use schema version `0`; their target identity is
the domain-separated HMAC of the signed turn binding and respectively
`"no-target/unsupported" | "no-target/unknown" | "no-target/action-limit"`. No caller text or
unrecognized argument enters a sentinel hash. These same canonical values are copied into the
terminal envelope.

Every mediated intent creates exactly one candidate before invocation, including an unknown alias
or out-of-scope action. The launcher inserts it first into a bounded in-memory turn set, then
attempts durable intent capture. Durable enqueue failure retains the candidate with evidence
`availability=unavailable` and clause `unknown`.

The turn set holds at most 16 entries, reserving the final entry as
`action-limit-exceeded`; therefore at most 15 actions may execute. The next attempt creates
that sentinel and is rejected before invocation; further attempts increment only its count,
saturated at 255, and are rejected.
Pre-action durable enqueue is capped at 50 ms, result enqueue at 100 ms, and cumulative action-time
evidence wait at 500 ms/turn. Deadline/capacity never drops a candidate or permits an unrecorded
action.

Each in-memory candidate slot is capped at 512 bytes; candidate/index state is ≤16 KiB/turn and
≤1 MiB across 64 active turns. Buffered untrusted output is capped separately at 64 KiB/turn and
4 MiB/host. Queue metadata and renderer buffers bring the hard completion-evidence runtime-memory
ceiling to 6 MiB/host; allocation beyond any sub-cap rejects before action or falls to visibly
unverified freeform, never eviction of a live candidate.

At close, the launcher—not the model—builds the complete mediated candidate set from those intents/results.
Every candidate is rendered from a fixed action-schema template:

- action identity and safe target display;
- execution/result enum;
- verifier status;
- per-clause verdict and verification basis;
- allowlisted artifact reference;
- fixed next-step sentence for `unknown` or `contradicted`.

The only display template is:

```text
[{verdict}] {safeDisplay} ({opaqueRef8}) — {result}; evidence: {verificationBasis}
```

Allowed transformations are closed:

| Action | `safeDisplay` | Allowed reference/artifact labels | Forbidden input |
|---|---|---|---|
| test | `registered test suite` | 8-character opaque target ref; `test report` | suite name, path, command, raw report |
| build | `registered build target` | opaque ref; `build report` | target name, path, flags, raw log |
| file write | `registered project file` | opaque ref; `state proof` | filename/path, content, diff |
| local command | `registered command class` | opaque ref; `execution result` | command, arguments, stdout/stderr |
| unsupported/unknown/limit | fixed sentinel label | no artifact label | caller/model-provided text |

`opaqueRef8` is a display-only truncation of the already scrubbed identity hash and is never used
for correlation. No free string crosses into the evidence block.

The model cannot omit, add, rename, or resolve candidates. There is no model-supplied `claims[]`
array in canonical mode.

The evidence block begins with the fixed copy: **“Verified only for the listed local mediated
actions.”** No global “done,” “complete,” task-level checkmark, or equivalent affordance is allowed.
A task-level completion claim requires a separate specification.

```ts
type CompleteTurnV1 = {
  schemaVersion: 1;
  turnBinding: string;
  operationId: string;
  mode: 'canonical' | 'freeform';
  candidateSetDigest: string; // launcher-provided; model echoes only
  freeformText?: string;      // allowed only in freeform mode
};
```

Exactly one final operation is accepted. A byte-identical retry is idempotent. A digest mismatch,
late operation, divergent repeat, or post-close operation causes the launcher-derived turn-close
state `mode=invalid`; no operation by deadline derives `mode=missing`. `invalid|missing` are not
caller-settable `CompleteTurnV1.mode` values. All affected clauses become `unknown`.

Canonical mode forbids arbitrary prose. An empty candidate set renders a non-completion response
and cannot say “done.”

```text
launch + signed turn
        │
        v
candidate registered before action
        │
        ├── supervisor evidence
        └── local verifier/native evidence
                    │
                    v
deterministic clause verdict
        │
        v
launcher-rendered scoped evidence block
```

### 2. Freeform presentation

Freeform engine text never receives a completion verdict. When `streamOwnership=current`, the
launcher may render its own evidence block for the complete mediated candidate set, followed by
engine text in a separate **Unverified commentary** container.

The commentary container is escaped plaintext. ANSI/control sequences, bidi overrides, HTML, and
launcher-style headings/badges are rejected or stripped. An unremovable launcher-owned unverified
marker sits outside the untrusted container. Without current stream ownership, the system delivers
only visibly unverified freeform output and no evidence block.

Freeform, invalid, and missing closes remain in coverage denominators. LLM/prose classification may
run dark for research but cannot alter candidates, rows, admission, or verdicts.

### 3. Stream ownership

Canonical authority is earned per engine through `StreamOwnershipContract`. The launcher must own:

- the child process group and PTY;
- stdout/stderr delivery;
- the completion control socket;
- cancellation and bounded TERM/KILL cleanup;
- the user-facing response sink;
- ordering and suppression of bytes after close.

Fixtures cover normal exit, late stdout/stderr, ignored cancellation, hung child, descendants,
terminal resize, restart, and reinstall. After `complete_turn`, output is buffered; the launcher
requests cancellation, waits at most 250 ms, applies the existing bounded cleanup, and discards late
bytes.

This proof concerns response-sink ownership, not sandbox confinement. Helper daemons, MCP/vendor
workers, auth helpers, auto-updaters, or direct filesystem/network side effects are outside this
contract. If they can write to the response sink, stream admission fails. If they perform an action
outside mediation, that action is unsupported and cannot be called verified.

The signed proof key is:

```text
engine/build + launcher/control-seam build + PTY policy + renderer generation
+ OS/runtime class + host boot id + install epoch + supervisor incarnation
+ rollout generation
```

A startup/restart/reinstall canary has a 10-second wall-clock bound, one isolated process group,
32 MiB temporary-state cap, and no external network. Timeout/failure sets
`streamOwnership=failed` and permits only freeform. The proof refreshes daily, expires after 36
hours, is host-local, and cannot survive a boot/install/supervisor epoch change.

## Evidence contract

### 1. Bounded envelope

```ts
type CompletionEvidenceEnvelope = {
  schemaVersion: 1;
  engine: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | 'instar-native';
  sourceMachineId: string;
  evidenceId: string; // one bounded head per logical turn
  hashKeyId: string;
  projectionAvailability: 'pool-projectable' | 'local-only';
  poolTurnId?: string; // required only when pool-projectable
  sessionIdHash: string;
  turnIdHash: string;
  actions: Array<{
    poolActionId?: string; // required only when pool-projectable
    actionIdHash: string;
    actionKind: 'test-run' | 'build-run' | 'file-write' | 'local-command'
              | 'unsupported' | 'unknown' | 'action-limit-exceeded';
    actionSchemaVersion: number;
    targetIdentityHash: string;
    disposition: 'uncharacterized' | 'eligible' | 'unsupported-for-verification';
    safeDisplay: 'test' | 'build' | 'file-change' | 'local-command'
               | 'unsupported-action' | 'unknown-action' | 'action-limit-exceeded';
    overflowCount?: number;
    result: 'ok' | 'error' | 'unknown';
    sources: Array<{
      kind: 'supervisor-journal' | 'native-event' | 'local-verifier';
      digest: string;
    }>; // max three
    availability: 'complete' | 'partial' | 'unavailable' | 'conflicted';
    verificationBasis?: 'trusted-local-supervisor' | 'independent-local-producer' | 'authoritative-local-state';
    artifactRef?: { kind: string; identityHash: string };
  }>; // max 16, including reserved overflow sentinel representation
  capturedAt: string;
  revision: number;
};
```

Raw prompts, commands, arguments, results, transcript paths, filenames, user text, secrets, and
provider identifiers are forbidden. Closed extractors produce target hashes and allowlisted
display summaries before allocation. The evidence envelope is capped at 8 KiB. The independent
candidate set and turn envelope contain up to 15 executed actions plus the reserved overflow
sentinel.

`evidenceId` is a domain-separated HMAC over the signed logical turn binding and source machine.
Each action retains its stable 128-bit action id inside that turn head. Neither identity is derived
from timestamps or text. The ingestion boundary authenticates the producer and stamps
engine/source/build; caller-supplied identity is rejected.

At logical turn start the host uses its provisioned agent-pool continuity key to mint a random
opaque `poolTurnBinding` signed to agent, enrolled source machine, logical session/turn, and pool
key generation; no live coordinator call is required. Transfer preserves that binding.
`poolTurnId` is its pool-safe opaque projection and each `poolActionId` is a domain-separated HMAC
over `{poolTurnBinding, sourceMachineId, actionId}`. Launch, transfer, persisted envelope/head,
projection, and machine-B reads verify the signature and preserve originating machine/hash-key
generations. If the continuity key is unavailable, local verification proceeds from the host turn
binding while cross-machine projection is `unavailable`; no local verdict depends on pool
availability. No timestamp, text, target, or caller-selected id participates in the join.
When `projectionAvailability=local-only`, pool ids are absent in the envelope and nullable in the
local head/staging schema; such a head is mechanically excluded from every pool projection.
`pool-projectable` requires all pool ids and a valid continuity signature.

Revisions are monotonic: `partial → complete` and `unknown → ok|error`. Identity or terminal
mutation, revision gaps, replay across turns, or conflicting terminal evidence sets
`availability=conflicted` and clause `unknown`.

### 2. Supported local action schemas

| Action | Exact verified contract | Seed/cross-engine redundancy |
|---|---|---|
| `test-run` | owned process exit plus parser-confirmed bounded report for the exact suite/config digest | supervisor journal + test-runner report from separate producer/store |
| `build-run` | owned process exit plus parser-confirmed bounded build report for exact build/config digest | supervisor journal + build artifact/report verifier |
| `file-write` | supervisor-owned operation id plus authenticated before/after reads proving expected version/digest transition | supervisor journal + read-only filesystem state verifier |
| `local-command` | exact registered command class executed with matching exit/result; proves execution only | supervisor journal + proven native event when available |

A successful tool return is insufficient when the schema requires a report or state transition.
Prior state already matching, missing before-version, wrong target, concurrent writer, stale report,
or conflicting sources yields `unknown`, not verified.

The seed row is Instar-native `test-run`:

- primary: server job supervisor writes intent and paired exit/result to the recorder during work;
- redundancy: test-runner process writes a content-addressed bounded report to a separate artifact
  store; a read-only parser verifies suite/config/result before close;
- faults: independently drop/corrupt each producer and store, stale report, wrong suite/config,
  parser failure, and shared-filesystem failure;
- disagreement: `availability=conflicted`, verdict `unknown`.

For Claude, Codex, Gemini, and pi, the instrumented supervisor remains the primary. A row becomes
eligible only when the same action-specific verifier works from a real engine fixture, or a proven
native event provides the redundancy. A transcript parser is not fault-separated from an
engine-owned transcript and cannot occupy the redundancy slot.

### 3. Engine coverage matrix

| Engine | Required close path | Instrumented primary | Eligibility requirement |
|---|---|---|---|
| Instar-native | server-owned run close | job supervisor | seed real `test-run` fixture + report verifier |
| Claude Code | launcher tool/control seam | supervisor journal | real fixture for each admitted local row + action verifier/native redundancy |
| Codex CLI | launcher tool/control seam | supervisor journal | same |
| Gemini CLI | launcher tool/control seam | supervisor journal | same; shim/runnability must first be current |
| pi CLI | launcher extension/control seam | supervisor journal | same |

Each row declares producer process, storage path, capture timing, credential dependency, and
correlation key. Fault injection must independently break the primary producer/store and the
redundancy producer/store. Shared host/kernel/supervisor dependencies are disclosed; the UI never
calls local redundancy host-independent.

## Deterministic verifier

For each launcher-owned candidate, `CompletionEvidenceVerifier` performs exact schema and target
matching:

- `verified`: complete matching successful evidence plus the row's required report/state verifier;
- `contradicted`: complete matching explicit failure or authoritative local negative state;
- `unknown`: missing/partial/conflicted evidence, unsupported schema, different target, stale
  report, missing causality, or capacity/key failure.

Absence is never contradiction. Evidence for a different target is never borrowed. The verifier
makes no `IntelligenceProvider` call and reads no assistant prose.

At close it reads already captured local evidence only. It starts no command, report generation,
filesystem mutation, provider read, retry, or background job. A late event cannot mutate the
immutable displayed verdict.

## Bounded storage and multi-machine read

The existing `ClaimObservationRecorder` remains the sole reducer. It gains one bounded SQLite
projection using the already installed `better-sqlite3` dependency:

- `evidence_heads(evidence_id PRIMARY KEY, revision, engine, source_machine_id, turn_hash,
  projection_availability, pool_turn_id NULL, source_key_generation NULL, availability,
  terminal_digest, expires_at)`;
- `evidence_revisions(evidence_id, revision, envelope_blob, received_at,
  PRIMARY KEY(evidence_id, revision))`;
- `action_staging(evidence_id, action_id_hash, seq, phase, fixed_blob, expires_at,
  PRIMARY KEY(evidence_id, action_id_hash, seq))`;
- `action_source_staging(evidence_id, action_id_hash, pool_action_id NULL, source_kind,
  source_digest, fixed_blob, expires_at,
  PRIMARY KEY(evidence_id, action_id_hash, source_kind))`;
- `evidence_quarantine(event_uuid PRIMARY KEY, reason_code, scrubbed_digest, expires_at)`.

Before invocation, the writer appends immutable staging sequence 0 (`intent`); after execution it
appends sequence 1 (`result`). Each fixed staging blob is capped at 256 bytes. Source observations
are staged by action and capped at three 128-byte rows/action. Identity/phase mutation is rejected;
an identical append is idempotent. There are at most 15 actions × two staging events and three
sources/action per active turn.

At close, one `BEGIN IMMEDIATE` transaction reads the closed staging/source rows, reduces every
action independently, writes terminal envelope revision 1, updates the materialized head, and
deletes the now-redundant action and source staging rows; the terminal envelope retains their
closed source kind/digest arrays. Revision 2 is reserved only for the single allowed
concurrent source reconcile/conflict transition before the displayed close commits. After display,
the head is immutable and late observations are audit counters only. A conflict on one action sets
only that action `availability=conflicted`; other actions cannot inherit its source/result.

A crash between intent/result leaves bounded staging for resume within the 24-hour turn TTL;
closing without the result makes that action unknown. Orphan staging expires after 24 hours in
bounded batches and never becomes a terminal verdict. Capacity failure retains the in-memory
candidate, marks its evidence unavailable, and does not invoke an unrecorded action. There is one
reload/reconcile attempt and no spin/retry on turn close.

Hard bounds:

- two terminal revisions per turn `evidenceId`, two staging events/action, and three staged
  sources/action;
- 10,000 live heads and 200 new heads/agent/UTC day;
- 20,000 quarantine rows and 600 new quarantine rows/UTC day;
- 128 MiB revision-blob cap, 4 MiB active-staging cap, 32 MiB heads/index cap, 16 MiB quarantine/
  aggregate cap, and 32 MiB WAL/temp cap inside a 256 MiB total footprint; 256 queued writes;
- 30-day retention; bounded batch GC with source-row cascade;
- 250 ms background SQLite busy timeout, but close acquisition is capped at 100 ms and total close
  evaluation at 500 ms.

UTC admission buckets are retained for 31 buckets (30-day retention plus one GC-lag bucket). At the
accepted maximum, `200 × 31 + 64 = 6,264`, below the 10,000 live-head cap. Two maximum 8 KiB
revisions for `200 × 31` terminal heads consume at most 99.2 MiB. The maximum 64 active turns add
at most 0.9 MiB of staging. The dedicated caps above leave measured head/index, quarantine, and
WAL/temp headroom inside 256 MiB. The row inequality is
`200 × 31 + 64 = 6,264`, below 10,000. Quarantine needs at most
`600 × 31 = 18,600` rows, below 20,000. Expiry returns row/byte quota exactly once; unexpired rows
are never evicted.

Overflow, disk full, busy timeout, revision/cardinality ceiling, or queue pressure never evicts
live evidence or fabricates a verdict. Affected clauses become `unknown`, reason
`evidence-capacity`; the action itself is not retried.

Canonical CBOR encoding uses 32-byte binary hashes/digests, one-byte enums, bounded integers, a
512-byte top-level allowance, and at most 384 encoded bytes/action; 16 entries therefore fit within
`512 + 16 × 384 = 6,656` bytes, below 8 KiB. Bounds fixtures fill every optional field and reject
the next byte before allocation.

Integration admission includes a 31-day sustained maximum-rate soak using maximum-size envelopes,
two revisions, 64 concurrent maximum-action turns, one-bucket GC lag, row/byte N/N+1 attempts, and
maximum quarantine traffic. It records actual page/index/WAL/temp high-water marks and rejects
admission if any dedicated cap or the 256 MiB footprint would be exceeded.

This is a bounded per-entity revision projection, not a workflow/outbox engine: it has no provider
callbacks, dispatch, retries, tombstones, consumer offsets, unbounded replay, or independent
reducers. Process Health and pool/audit are versioned reads of materialized heads, not reducers.
OpenTelemetry remains an optional allowlisted export vocabulary; it is not verdict authority.

Alternatives were evaluated against this local-only requirement:

| Pattern | Benefit | Why not chosen / reopen trigger |
|---|---|---|
| existing recorder + bounded revisions | reuses current trust/storage owner; exact per-entity CAS and bounded reads | chosen for one local reducer and no dispatch/retry/callback |
| restricted append-only event log + materialized head | standard replay and audit ordering | adds consumer offsets, replay authorization, compaction, and a head for no current independent consumer; reopen for a second reducer or historical recomputation |
| transactional outbox / durable workflow | mature dispatch, callback, retry, settlement | those capabilities serve provider/async effects that are out of scope; reopen with provider dispatch, post-turn settlement, or action retries |
| strict OpenTelemetry pipeline | standard trace context and tooling | telemetry status/attributes do not define action-specific causal truth and exporters enlarge the privacy surface; reuse only its trace vocabulary |
| in-toto/SLSA-style attestation | standard signed artifact provenance | optimized for supply-chain subjects/predicates, not bounded interactive turn/action capture or local sink control; reconsider for build-artifact export, not turn verdict storage |

The chosen HMAC envelope is an internal strict provenance profile: its smaller schema, local key,
8 KiB cap, and no exporter are intentional. A requirement for a second independent consumer,
historical recomputation, async settlement/retries, provider dispatch, or exported build
attestations reopens the architecture decision.

Raw evidence stays machine-local. The authenticated pool read projects only scrubbed heads,
pool turn/action ids, source-machine id/key generation, revisions, verdicts, and basis. Highest contiguous valid revision wins;
conflicting terminal digests remain `unknown`. The projection is backup-excluded because host-keyed
evidence cannot be restored as local authority. Restore starts empty; recent pool projections remain
readable only for their original turns. New local canaries and evidence rebuild authority; during
recovery the normal precedence yields `coverage=not-verified` until a row is readmitted, with
diagnostic reason `cold-start-after-restore`.

## Admission measurements

Development seed deadlines have no production authority. Before a host/row becomes eligible, dark
capture runs the exact WAL/CAS/schema path for seven consecutive days at the intended workload.
The expected maximum is 16 candidate entries/turn (15 executable plus the overflow sentinel) and
64 concurrent turns.

Admission requires, per concurrency tier 1/16/64:

- at least 10,000 attempts total and 1,000/tier;
- closed outcomes `committed | deadline | busy | queue | capacity | error`;
- ≥99% successful durable capture;
- measured p99 result durability ≤100 ms;
- measured p99 close database acquisition ≤100 ms;
- measured p99 total close evaluation ≤500 ms.

The isolated calibrator uses a synthetic quota namespace capped at 700 turn heads and 24 MiB/run.
It packs at least 10,000 action updates into at most 667 heads (15 actions/head) while exercising
the identical staging, envelope reduction, CAS, queue, deadline, and byte-accounting code.
Synthetic heads never
consume production rows/bytes/metrics or project to the pool. Separate N/N+1 fixtures run the
production 200/day, 10,000-live, component byte caps, and concurrency limits, so isolation cannot skip quota
logic. The minimum sample is therefore achievable inside the seven-day qualification window.

The authenticated rollout generation records sample count, workload tier, p50/p95/p99, component
hashes, issue time, and eight-day expiry. Process Health displays coarse buckets and reason. An
expired or failed calibration makes only the affected row ineligible; it does not widen deadlines
or block unrelated actions. Operators may lower concurrency within the measured tier. Raising a
hard latency ceiling or weakening the success floor requires a new reviewed spec.

Calibration uses an isolated ≤64 MiB database on the same storage path, ≤10% duty cycle, and yields
within 100 ms to production traffic. Sufficient passive production samples may refresh the same
closed histogram. Failure-heavy samples cannot be discarded or replaced by a clean shadow run.

## Metrics and rollout

Over a rolling seven-day window with at least 100 action-bearing instrumented closes per engine:

1. **Eligible-row performance**
   - capture success = valid complete envelopes / canonical candidates on eligible rows, target
     ≥99%;
   - unknown rate = unknown / canonical candidates on eligible rows, target <5%.
2. **Instrumented-turn coverage**
   - numerator = action-bearing instrumented closes whose complete mediated candidate set is canonical and
     every candidate row is eligible;
   - denominator = every action-bearing instrumented close, including freeform, missing, invalid,
     opaque, and unsupported candidates;
   - target ≥95%; every observed unsupported/unknown action remains separately counted.

These metrics say nothing about uninstrumented or hidden actions. They cannot produce a “broad
completion” label.

One threshold-breaching window marks the row/engine `degraded` as a diagnostic reason and freezes
rollout advancement. Two consecutive windows below capture/unknown/coverage targets prevent
renewal of the row's eight-day admission artifact, making it ineligible in the next generation.
Any favorable-scope omission, registry shrink without reviewed migration, or integrity conflict
freezes the generation immediately. Unsupported/unknown candidates remain explicit counts and
force engine `coverage=partial-mediated-local-verification`; they cannot be normalized away by an observe-only
posture.

Rollout:

1. **Dark seed:** implement protocol/store/renderer for Instar-native `test-run`; no user verdict.
2. **Seed dry-run:** run real seed fixtures and seven-day calibration; compare expected verdicts.
3. **Seed observe-only:** display clause verdict/basis; no blocking.
4. **Claude/Codex dark then dry-run:** add only `test-run`, `build-run`, and causal `file-write` rows
   that pass their own fixtures.
5. **Claude/Codex observe-only:** requires per-engine metrics; engines never pool for graduation.
6. **Gemini/pi expansion:** same gates; no promotion by analogy.
7. **Blocking:** separate operator-ratified spec using measured false-positive/negative evidence.

Kill switches independently disable capture and consumption. Disabling consumption leaves scrubbed
rows inert. Rollback pins the prior registry generation. No step rewrites engine-owned artifacts.

## CI and testing

### Unit

- closed schema, bounds-before-allocation, dangerous keys, Unicode normalization, scrub boundary;
- HMAC domain separation, turn/action binding, replay, collision, key rotation/destruction;
- exact target/action matching; wrong target, prior state, concurrent writer, stale report;
- `verified | contradicted | unknown` mappings with prose/model diagnostics disabled;
- canonical/freeform/missing/invalid closes; candidate digest; idempotent/divergent repeat;
- unsupported/unknown candidate sentinels; pre-action in-memory registration; durable-intent
  failure; 15 actions plus overflow sentinel; rejected 16th and bounded further attempts;
- canonical schema-version-0/no-target hashes for unsupported, unknown, and overflow sentinels;
- 50/100/500 ms action-time enqueue/result/cumulative evidence budgets;
- escaped commentary against Markdown, ANSI, bidi, HTML, forged headings, and badge spoofing;
- CAS merge/conflict, quotas, expiry, GC cascade, disk full, busy timeout, queue pressure.
- canonical-CBOR maximum field lengths and 8 KiB rejection-before-allocation.

### Integration

- coverage registry has a row/corpus for every build-supported engine;
- exhaustive engine/build manifest unions registry+observed rows; favorable-scope omission,
  unknown-row arrival, unauthorized shrink, and generation CAS conflict force partial/freeze;
- seed supervisor/report producers fail independently and disagreement stays unknown;
- each engine/action primary and redundancy pair passes producer/store fault injection;
- real storage calibration at concurrency 1/16/64 with closed denominators;
- 15-action sequential/interleaved staging with three sources/action; crash between intent/result;
  per-action source disagreement; terminal reduction deletes staging and does not contaminate
  unaffected actions;
- isolated 10,000-update calibration completes within its 700-head/24 MiB namespace while
  production row/byte limits are separately enforced;
- N/N-1 schema expand/contract, rollback, restore/cold start, key rotation;
- pool read preserves source/basis and conflict without raw evidence;
- Process Health derives coverage only from the closed precedence table.

### End to end

- one real fixture per admitted engine/action renders the same semantic evidence block;
- normal/late stdout/stderr, hung child, descendant output, cancel/TERM/KILL, resize, restart,
  reinstall, and stale proof;
- prompt-injected omission cannot remove launcher-derived candidates;
- freeform cannot spoof or reorder launcher UI; no proof means no evidence block;
- concurrent/resumed/nested calls, retries, out-of-order/dropped results, background and prior-turn
  bleed use signed identities, never timestamp joins;
- machine A execution/read on B, offline/rejoin, duplicate replay, and conflicting terminal data;
- signed pool-stable turn/action mapping across transfer; wrong-turn, wrong-source-machine,
  wrong-key-generation, timestamp/text/target spoof joins rejected;
- continuity-key unavailable preserves local verdict with `local-only` projection; nullable pool
  ids never leave the host;
- all capacity failures reach immutable clause unknown without retry or silent allow.
- 31-day sustained maximum-rate/maximum-envelope soak, one-bucket GC lag, and row/byte/quarantine
  N/N+1 prove the accepted rate cannot self-exhaust.

## Frontloaded Decisions

- V1 covers instrumented deterministic local actions only.
- The launcher derives and renders every mediated action candidate; the model cannot choose the
  verified claim set.
- Mediated candidate completeness includes unsupported/unknown sentinels before schema lookup and
  cannot be narrowed by rollout configuration.
- No LLM/prose judgment has runtime authority.
- Standalone sessions and out-of-scope actions receive unknown, never silent no-op.
- Only `test-run`, `build-run`, causal `file-write`, and execution-only `local-command` schemas exist.
- Durable external receipts, async settlement, workflow/outbox machinery, and broad confinement are
  separate future specs, not open choices here.
- Every admitted engine/action row requires a real fixture and fault-tested deterministic
  redundancy.
- Local verification basis is disclosed; no local pair is described as host-independent.
- Canonical output requires current host-local stream ownership and non-spoofable rendering.
- Evidence is scrubbed, bounded, host-keyed, backup-excluded, and projected cross-machine only in
  closed form.
- The existing recorder plus bounded revisions is the chosen single-reducer projection; async
  settlement/retries, a second reducer, historical recomputation, provider dispatch, or exported
  build attestations reopen that choice.
- Unknown never means verified; absence never means contradicted.
- Rollout is observe-only; blocking requires a separate operator decision.

## Decision points touched

- `mediated candidate completeness` — **invariant**: every mediated intent enters the bounded in-memory set before invocation, including unsupported/unknown sentinels; persistence failure retains an unknown candidate, overflow rejects before execution, and model/config cannot alter or scope candidates away; this does not claim unmediated task completeness.
- `canonical close` — **invariant**: exactly one digest-bound close; arbitrary prose is forbidden; missing/invalid/late close makes affected clauses unknown.
- `freeform presentation` — **invariant**: commentary is structurally isolated, escaped, visibly unverified, and cannot receive a clause verdict.
- `stream admission` — **invariant**: current engine/build/host proof owns process group, PTY, stdout/stderr, control seam, cancellation, ordering, and final sink.
- `row admission` — **invariant**: enabled+runnable host, current stream proof, eligible row, fault-tested redundancy, current calibration, and named observe-only generation.
- `verdict` — **invariant**: exact schema/target/causality mapping produces verified, explicit matching failure produces contradicted, everything else unknown.
- `coverage` — **invariant**: an exhaustive CAS-protected registry+observed manifest and ≥95% instrumented-turn coverage are required for the positive label; omitted, unknown, unsupported, ineligible, or unreviewed-shrink rows force partial independently from clause verdicts.
- `storage` — **invariant**: one bounded local reducer with monotonic CAS, hard cardinality/byte/time limits, immutable two-event per-action staging, at most three staged sources/action, atomic terminal turn reduction into at most two revisions, no action retry, and capacity failure to unknown.
- `projection architecture` — **invariant**: existing recorder + bounded revisions is chosen for one local reducer with no dispatch/retry/callback; a second reducer, historical recomputation, async settlement/retries, provider dispatch, or exported build attestations reopens the decision.
- `cross-machine read` — **invariant**: scrubbed heads only; source/basis preserved; conflict unknown; raw evidence and local authority never move.
- `future scope` — **invariant**: provider durability, pending/post-turn settlement, hidden effects, and blocking have no authority until separately specified and approved.

## Open questions

*(none)*
