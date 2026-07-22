---
title: "Claim Verification — a dark, evidence-first core for outbound factual claims"
slug: "claim-verification-sentinel"
author: "echo"
parent-principle: "Signal vs. Authority"
status: approved
approved: true
ships-staged: true
rollout-disposition: active
rollout-source-pr: 1534
rollout-flag-path: monitoring.completionClaimVerification.enabled
rollout-criteria: "The verifier admits at least one candidate claim and retains nonzero classification coverage in the evidence window without becoming an outbound authority."
rollout-evidence-type: endpoint
rollout-evidence-ref: /completion-claim-verification/stats
rollout-metrics-json: '{"cadenceHours":6,"evidenceMaxAgeHours":12,"metrics":[{"id":"classified-completion-claims","source":"feature-summary","sourceRef":"claim-verification.classified-claims","direction":"at-least","threshold":1,"minSamples":1}]}'
approved-by: "operator blanket pre-approval relayed 2026-07-20 — proceed immediately through build/merge"
supervision: pre-approved-build-and-merge
lessons-engaged: [P1, P2, P3, P4, P5, P18, P19, P20, P21, L1, L5, L9]
review-convergence: "2026-07-21T04:16:47.595Z"
review-iterations: 8
review-completed-at: "2026-07-21T04:16:47.595Z"
review-report: "docs/specs/reports/claim-verification-sentinel-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Claim Verification

## 0. Scope and outcome

Instar needs to notice factual claims in agent-authored outbound messages, estimate the harm of being wrong, and corroborate those claims against ground truth when a trustworthy source exists. The motivating incident was a capacity assertion recalled from memory and conflated across two different axes. V1 reduces the blind spot only by detecting and measuring capacity assertions as high-criticality; it does **not** prevent or correct one because no canonical capacity oracle or graduated advisory exists. User-visible prevention is outside v1 and requires both prerequisites plus separate convergence. The broader feature must reduce this class of error without creating a second outbound gate, treating prose as an oracle, or making model consensus look like evidence.

This specification converges three releases but authorizes implementation of **v1 only**:

- **v1 — dark core + cheap lane + corpus:** general claim extraction and criticality, deterministic verification for a finite supported-predicate set, pool-visible observation, and scrubbed benchmark/grade records. It observes only. It never withholds, rewrites, sends, corrects, or authorizes an action.
- **v2 — designed here, explicitly out of build scope:** a recurring-shape miner plus a durable bounded due-diligence workflow for high-criticality claims that lack one sufficient oracle.
- **v3 — designed here, explicitly out of build scope:** closed-loop calibration and benchmark surfacing. Learned drift may only make treatment more conservative; it may never weaken a deterministic criticality floor.

This is a **dark core**, not a general claim gate. “Verified” always means “supported by source S at revision R observed at time T,” never timeless truth. Unsupported, ambiguous, stale, partial, or unavailable evidence is `unverifiable`, not `refuted`.

V1 is still worth shipping without prevention: it creates the first privacy-bounded corpus of claim shapes, measures admitted-path extractor behavior, regression-tests time/state/completion adapters against canonical evidence, exposes where no oracle exists, and supplies honest cost/precision evidence for deciding whether later channel coverage and advisory work merit their complexity. It converts an anecdotal failure class into measurable substrate without prematurely gaining delivery authority.

**V1 non-goal:** it does not directly reduce the factual-error risk of messages already delivered; any benefit to users is indirect, through later human review and evidence for a separately graduated advisory. Operationally, one Instar installation is one agent identity that may run on an authenticated pool of machines. Claude Code's Stop hook observes one completed authored response and submits it asynchronously to the current server; v1 analyzes only server-admitted submissions from that path.

## 1. Foundations and ownership

The live foundation is broader than the original time-claim precedent:

| Existing surface | What v1 reuses | What it does not own |
|---|---|---|
| `ClaimClauseArbiter` | The single bounded LLM clause judgment, structured output, untrusted-data prompt boundary, provenance, and shared routing with Action-Claim | Delivery authority |
| `CompletionClaimVerifier` | Bounded async admission, dedupe, dry-run, verdict/audit/stats, disposition feedback, and pool audit projection | A second general verifier or queue |
| `TurnEvidence` | Scrubbed structural evidence for same-turn tool actions | Arbitrary logs, commands, results, or secrets |
| `core/time-claim.ts` | Seed deterministic claim shape and clock verifier | General language judgment |
| `OutboundAdvisory` + sender scripts | The established distinction between server-produced signals and the sender’s contextual send/interrupt decision | General claim classification or action authorization |
| LLM Decision Quality + benchmark-divergence machinery | Grades, outcome linkage, model/door attribution, and drift measurements | Automatic policy weakening |
| `TaskFlowRegistry` + shared `LlmQueue`/`IntelligenceRouter` | The v2 durable local lifecycle and bounded intelligence lanes | A new scheduler or recursive spawn engine |

There is exactly **one claim judgment pipeline**: v1 extends `ClaimClauseArbiter` and `CompletionClaimVerifier`. It does not put another LLM extractor in `/messaging/preflight`, and it does not create a second audit or queue. TIME_CLAIM remains independently live; v1 observes its deterministic result as the seed verifier adapter. Action authorization remains solely with the operation/coherence/mandate authorities.

### Short glossary

- **pool:** the authenticated machines serving one agent installation.
- **ownership epoch:** the monotonic fence proving which machine currently owns a conversation/write.
- **model door:** the provider+harness route used for an intelligence call.
- **topic:** one conversation-scoped unit used for ownership and fairness.
- **principal:** an authenticated human or machine identity; diversity prevents one source dominating a cohort.
- **T0/T1:** deterministic-source and operator-adjudicated label trust classes; v1 ingests T0 only (§2.6).
- **OCC:** optimistic concurrency control; a stale revision cannot commit.
- **CAS:** compare-and-swap; a write succeeds only against the revision/epoch it read.
- **fence:** a monotonic ownership/config value that rejects stale writers.
- **receipt:** a typed, source-bound record of one read or delivery outcome, not a prose assertion.
- **label trust class:** how an eventual answer was established; only T0/T1 can become trusted after ledger admission.
- **claim shape:** a content-free structural tuple used for cohorts, never raw prose.
- **dark core:** logic that computes and records counterfactual results but cannot affect delivery or actions.
- **pool-visible observation:** an authenticated merged read of origin-local metadata; it is not trusted replication.
- **Decision Quality projection:** enrollment of bounded decision/outcome metadata into the existing model-quality surface.
- **Test-as-Self:** a non-destructive production-init test proving generated installs use the same live wiring as a real agent.

| V1 artifact | Producer | Consumer |
|---|---|---|
| authored response + `TurnEvidence` | versioned Stop hook | claim admission/arbiter |
| `ExtractedClaim` | bounded LLM pass | deterministic validator/resolver |
| `NormalizedClaim` | server canonicalizer | typed verifier adapters |
| `ClaimAssessment` | deterministic adapter | local audit/decision-quality projection |
| bounded local audit event | origin audit writer | local read + corpus projector |
| scrubbed local corpus row | local projector | dark benchmark observations only |

V1 deliberately keeps this storage local and automation-ineligible. It does not claim that a local file or SQLite WAL proves origin authenticity, anti-rollback, or cross-machine integrity. Pool display is observational only. Any trusted export or automated consumer waits for the separately converged Verified Claim Evidence Ledger in §2.6; the dark assessment path can soak without that prerequisite.

### Signal versus authority

The claim system emits typed evidence signals. It never disposes a send or an external action.

```text
message + authenticated context + structural evidence
                  |
                  v
       shared claim arbiter/observer
          |                 |
          v                 v
 deterministic adapters   unverifiable/high candidates
          |                 |
          +------ typed ClaimAssessment ------+
                                               |
                          existing contextual outbound authority
```

In v1, the final arrow is **counterfactual observation only**: no new claim assessment is supplied to an enforcing sender disposition. The audit records what advisory would have been proposed. A later posture may let the existing outbound authority choose `send | interrupt-for-ack`, but that is a separately graduated configuration and never moves into a detector. Existing TIME_CLAIM behavior is unchanged.

## 2. v1 normative design

### 2.1 Covered messages and explicit residual

The v1 observation source is the already-installed `completion-claim-observe.js` Stop hook and `/completion-claim/observe`. Therefore v1 covers agent-authored Claude Code response text for which the hook produces bounded `TurnEvidence`. It does **not** claim universal channel enforcement.

The same observed response may later be relayed through Telegram, Slack, iMessage, or WhatsApp; v1 classifies the authored response before channel formatting. It does not fetch attachments, URLs, Block Kit payloads, link previews, edits, ephemerals, automated/script notices, direct adapter sends, queued transport redrives, or text generated outside the supported hook. Those paths record `coverage-unsupported` only when they invoke the observer; otherwise they are an explicit v1 residual. Non-Claude frameworks no-op until they provide an equivalent authenticated, scrubbed response/evidence hook.

Channel-neutral enforcement is not in v1. Any later enforcing rollout requires a separate coverage matrix and wiring proof for each final user-visible send chokepoint.

### 2.2 One bounded claim pass

`ClaimClauseArbiter` grows from its completion/future labels into one versioned structured pass. Every §2.1 response is **eligible**; actual evaluation is separately measured and may wait within the explicit queue/fairness/budget bounds. V1 removes the completion-keyword prefilter from the generated Stop hook and bypasses `CompletionClaimVerifier.mightContainCompletionClaim()` for general observation. It replaces the action-stem-specific general splitter with bounded neutral sentence/paragraph candidates plus model clause extraction. Cue-free capacity/state/attribution claims and compounds are regression fixtures.

The arbitration result is a backward-compatible envelope `{legacy, general}`. `legacy` retains the currently shipped labels/fields and projects through the existing `routeActionClaim`; `general` contains the schema below. During v1, the general projection is structurally barred from `routeActionClaim`, and legacy publication requires fixture parity against the pre-change prompt/parser/splitter. When parity is absent or the envelope is invalid, Action-Claim receives its exact pre-v1 fallback. Mixed posture with existing `dryRun:false` is integration-tested so general observation cannot change future-commitment authority.

Outbound text and evidence are inert JSON-delimited data, never instructions. Model output validates against a closed schema; unknown fields, invalid enum values, duplicate atomic tuples, invalid offsets, or out-of-range cardinality make the affected result non-authoritative.

Before queue/provider admission, one versioned `ClaimObservationScrubber` applies the existing credential-shape scrub primitives (including `monitoring/scrubSecrets.ts`) plus a new deterministic v1 `ClaimContentPolicy` to **both** response text and serialized `TurnEvidence`. This is explicitly v1 work, not an assumed existing classifier. It replaces secret/token/password shapes, Secret Drop URLs, credentials, private path/URL identifiers, and disallowed identity fields with fixed typed placeholders; then it revalidates the structural evidence schema. Each placeholder is an ASCII-delimited typed occurrence such as `[REDACTED_SECRET_03]`: it preserves whitespace/punctuation boundaries, never joins adjacent tokens, is unique within the message, and cannot be parsed as an entity selector/operand. All offsets are computed anew over the final scrubbed bytes; no raw-to-scrubbed offset is accepted. The closed policy result is `standard-scrubbed | restricted-local | deny`; `restricted-local` and `deny` never call a model door. V1's generated policy is frontloaded: only `standard-scrubbed` is allowed, only the originating Claude Code installation's existing `claude-code` subscription door may run it, and no provider fallback or cross-provider swap is permitted. Its residency classification is `existing-agent-session`—the same provider/account boundary already processing the authored response—not a claim of geographic residency. A non-Claude origin is unsupported in v1. Missing/unknown policy or unavailable originating door defaults to `deny`. `sourceStartByte`/`sourceEndByte` and every consequence offset refer only to scrubbed UTF-8 text. The audit binds `scrubVersion`, `privacyPolicyVersion`, and content class, never scrubbed values. Scrub, classification, schema, or door-policy failure records `coverage-incomplete:privacy-boundary` and skips the model call; delivery remains unchanged. No unsanitized copy is retained by this feature.

Accepted residual risk is explicit: deterministic DLP cannot recognize every contextual secret or private fact. V1 limits incremental exposure by using only the same provider/account already processing the authored response, prohibiting cross-provider fallback, and retaining no provider-bound raw copy. This is not anonymity or proof of perfect scrubbing. Provider-boundary tests include property/fuzz generation, encoded/fragmented credential shapes, Secret Drop URLs, private paths/identifiers, and a seeded real-world-format secret corpus containing synthetic values only.

The HTTP parser rejects the authenticated request before feature allocation above 96 KiB. Pre-scrub message bytes cap at 32 KiB; validated scrubbed message bytes cap at 16,384. `TurnEvidence` caps at 200 items and 48 KiB serialized; each `tool`/`errorClass` caps at 100 UTF-8 bytes, each `targetSummary`/`reason` at 256, with closed booleans/enums and no unknown fields. Oversize/cardinality/invalid UTF-8 yields content-free `coverage-incomplete:input-bound` before queue admission and no model call. Provider token estimation covers prompt plus the final scrubbed message/evidence.

```typescript
type ClaimKind =
  | 'temporal' | 'capacity-limit' | 'completion' | 'cross-agent-action'
  | 'operator-attribution' | 'state-fact' | 'external-fact' | 'unknown';

type ClaimCriticality = 'low' | 'medium' | 'high' | 'irreversible-precondition';

type SubjectKind =
  | 'session' | 'commitment' | 'guard' | 'pull-request' | 'tool-action'
  | 'capacity-model' | 'operator' | 'external-entity' | 'unknown';

type ClaimPredicate =
  | 'session.elapsed-ms' | 'session.state' | 'commitment.state' | 'guard.state'
  | 'pull-request.merged' | 'pull-request.checks-pass'
  | 'tool-action.completed' | 'capacity.limit' | 'operator.attributed'
  | 'external.fact' | 'unknown';

type TypedOperand =
  | { type: 'duration-ms'; value: number }
  | { type: 'state-enum'; value: string; enumVersion: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'integer'; value: number; unit: string }
  | { type: 'none' };

type Comparator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

type SubjectSelector =
  | { type: 'current-session' }
  | { type: 'explicit-id'; entityKind: 'commitment' | 'guard'; id: string }
  | { type: 'pull-request'; repository: string; number: number }
  | { type: 'same-turn-action'; actionIndex: number }
  | { type: 'unresolved' };

type ConsequenceRef = {
  relation: 'premise-for' | 'none';
  actionClass: 'delete' | 'production-deploy' | 'merge' | 'publish'
    | 'external-send' | 'credential-change' | 'other' | 'none';
  actionStartByte?: number;
  actionEndByte?: number;
};

type ExtractedClaim = {            // model wire; carries no server identifiers
  clauseId: number;
  kind: ClaimKind;
  subjectKind: SubjectKind;
  predicate: ClaimPredicate;
  operand: TypedOperand;
  comparator: Comparator;
  subjectSelector: SubjectSelector;
  consequence: ConsequenceRef;
  sourceStartByte: number;
  sourceEndByte: number;
  referencedEntityHints: string[]; // linguistic hints only; never lookup authority
  endorsed: boolean;
  negated: boolean;
  hedged: boolean;
  quoted: boolean;
  suggestedCriticality: ClaimCriticality;
  confidence: number;
  tenseScope: 'current' | 'past' | 'future' | 'timeless' | 'unknown';
};

type NormalizedClaim = ExtractedClaim & {
  claimId: string;                 // assigned server-side after validation (§2.6)
};
```

Operands and selectors are parsed and canonicalized deterministically from the exact UTF-8 byte span. Explicit IDs must match the owning registry's closed ID grammar. PR selectors require an in-scope `owner/repo#number` but remain unresolved/unverifiable in v1 because no canonical PR snapshot exists. Names, pronouns, and LLM hints never become selectors. Predicate-specific schemas define units, timezone (UTC unless the span explicitly supplies a valid IANA zone), state enums (`session: starting|running|stopping|stopped|unknown`; commitment/guard values from their versioned registry enums), integer range (`[-2^53+1, 2^53-1]`), and boolean complement tables. Unicode is NFKC-normalized only for parsing; original byte offsets remain authoritative. Coercion, ambiguity, confusable input, unit mismatch, out-of-range values, or a value/selector not derivable from its cited span yields `unverifiable`.

Polarity is canonicalized once before verification: negation is folded into comparator/operand (`not merged` -> `eq false`; `not running` -> `ne running`), then `negated` remains provenance-only and never changes evaluation. Ambiguous/nested negation is `unverifiable:ambiguous-negation`. Multiple atomic claims may share one input `clauseId`; model-wire uniqueness is `(clauseId,sourceStartByte,sourceEndByte,predicate,comparator,operand)`. Exact duplicates coalesce; conflicting duplicates invalidate only those tuples. Server validation/canonicalization then assigns `claimId`.

Candidate metadata is deterministic layout-only, version `candidate-v1`: split the scrubbed message after `. ! ? ;` or newline, preserve UTF-8 byte spans, trim whitespace, drop empty pieces, coalesce beyond 24 into candidate 23, and always give the model the full scrubbed message so splitting cannot hide a claim. Candidate boundaries are advisory metadata only: Markdown bullets/tables/code fences, abbreviations, decimals, and punctuation-free prose receive no special semantics, and neither extraction offsets nor the four-claim ceiling may depend on a candidate boundary. Protected-cue floor `cue-v1` NFKC-lowercases only for matching and marks a candidate when it contains one of the exact token/stem families: capacity `{capacity,cap,limit,lane,slot,concurr}`, completion `{done,complete,finish,pass,green,merge,deploy,ship,fix}`, attribution `{approv,authoriz,credential,permission}`, action `{delete,remove,publish,send,restart,transfer}`, state `{running,stopped,open,closed,pending,active}`. Cues only prioritize audit and provide a disagreement metric behind the LLM; cue absence never drops a message or decides meaning. Every protected-cue span is also placed in a deterministic shadow stratum: if the model extracts no overlapping claim, record `protected-cue-unextracted` and include it in seeded/blinded recall sampling. This shadow signal never creates a factual claim or verdict. English-only cue coverage is explicit; other languages remain full-model-only/unsupported for cue-stratum metrics.

Semantic prompt injection can still manipulate extraction rather than tool authority. `injection-v1` therefore flags exact NFKC-lowercase marker families such as `ignore previous`, `ignore above`, `system prompt`, `developer message`, `<system`, and `do not extract`, solely as a conservative shadow signal. When a protected cue or injection marker has no overlapping endorsed claim, has only quoted/hedged/non-endorsed overlap, or the envelope is invalid, the deterministic protected-predicate lane emits `ExtractionGapSignal {minimumCriticality,reason,span}`: `high` for protected approval/capacity/completion/credential cues and `irreversible-precondition` when a consequential-action premise may be present. It is the coarse non-LLM recall floor: a high-criticality observation, not a normalized factual claim, and therefore cannot support/refute. It is counted as counterfactual `CLAIM_UNVERIFIABLE`, makes the message `coverage-incomplete`, and in v2 remains on the general due-diligence path. No later enforcing graduation may silently send through such a gap; the existing outbound authority may only keep the unchanged conservative advisory/ack posture defined by that future rollout.

Comparator semantics are mathematical over canonical typed values: `eq/ne` for enums/booleans and all six comparators for duration/integer. TIME_CLAIM retains its existing tolerance before comparison. A fresh canonical value refutes exactly when the comparator evaluates false; it supports when true. Unsupported comparator/type pairs are `unverifiable:invalid-comparator`.

`ConsequenceRef` is message-relative UTF-8-byte-span-bound. Valid combinations are closed: `relation:none` requires `actionClass:none` and absent offsets; `relation:premise-for` requires non-`none` action class plus ordered, in-range, non-overlapping action offsets anywhere in the bounded message. Every other combination is schema-invalid. The structured LLM pass selects a closed action class; `other` is conservatively consequential. Tokens `so`, `therefore`, `because`, `given that`, `which means`, `before`, and `on that basis` can positively corroborate a link but never disprove one. Any extracted or structurally suspected premise for a non-`none` consequential action—including cross-sentence/paraphrased/ambiguous linkage or invalid fields—rounds to `irreversible-precondition`; uncertainty cannot downgrade it. Tests cover both claim/action orders and connective-free paraphrases.

Hard v1 bounds are normative: analyze at most 16,384 scrubbed UTF-8 bytes; at most 24 candidates; at most **4** extracted factual claims; at most 4 entity hints per claim and 200 bytes per hint; one existing fast-model call; 1,800 output tokens; queue cap 128 with cap 8/topic; at most 4 installation-wide model evaluations and 1/topic; no recursive model/tool calls. The model emits ordinary JSON using the exact `ExtractedClaim` field names/enums above under envelope `{schemaVersion:1,claims:[...]}`—there is no second compact codebook. Its prompt requires output order: suspected irreversible-action premises first, then protected predicates (approval/capacity/completion/credential), then decreasing suggested criticality/confidence, with source byte offset as tie-breaker. This is a bounded recall heuristic, not authority; deterministic floors apply only after validation. When the fourth output is present or any cue shadow lacks an overlapping extraction, record `claim-cardinality-saturated`/`protected-cue-unextracted`, mark `coverage-incomplete`, and exclude the message from recall success. A generated maximum-cardinality fixture must fit 7,200 UTF-8 bytes and 1,800 tokenizer-measured tokens. Per-topic admission buckets feed fair round-robin scheduling. Overflow/truncation also records `coverage-incomplete`.

Admission first atomically reserves the applicable request/token/cost windows; exhausted windows reject immediately as `rate-limit-exhausted`/`budget-exhausted` and never occupy the queue. An admitted item expires after 120 seconds. Per-topic cap is checked before global cap; either full condition rejects the newest item without evicting existing work. Fair round-robin visits one ready item/topic/cycle; expired/boot-ID-mismatched items are removed before selection and recorded as `queue-expired`/`boot-stale`. Provider queueing may wait only inside that TTL. No rate-window reset can retain an item indefinitely.

V1 routes through the shared `LlmQueue`/`IntelligenceRouter` background lane: 30 evaluated responses/topic/hour, 300/installation/hour, 2,000/installation/day, 10M input and 4M output tokens/day, and the existing installation spend cap or a stricter claim-verification sub-cap of US$5/day. Output capacity covers the proved maximum; input tokenization includes prompt+evidence and may lower the request ceiling. The effective daily ceiling is the minimum imposed by request, token, provider, and spend caps and is reported directly. Budget exhaustion records `budget-exhausted`. A structural protected-cue floor only raises audit priority; it never classifies meaning or verifies a claim. Its 5% audit reserve is carved out before ordinary traffic within hard caps, up to 50/day; exhaustion increments `audit_sample_shortfall`.

The observer remains asynchronous and cannot extend delivery latency. Admission returns before model evaluation. Provider error, timeout, breaker-open, invalid output, queue-full, fairness delay, or budget exhaustion records a distinct reason and sends unchanged. There is no synchronous LLM call in `/messaging/preflight`.

The chosen v1 architecture uses one general clause extractor because the product objective includes unknown recurring claim shapes, paraphrases, compounds, and cue-free facts; a hand-authored parser for the finite verifier catalog would observe only facts already anticipated. Pure NLI would still need a trusted premise/source and would blur extraction with evidence. Driving verification from workflow events alone misses unsupported prose claims. A generic rules or workflow engine would add a second routing authority while retaining the same entity, freshness, and oracle problems. Deterministic parsers remain appropriate inside each finite verifier adapter, after the general extractor has produced a typed candidate.

Cue-free production recall is unknown in v1. A subtle factual claim with neither a protected cue nor successful model extraction can disappear entirely. Seeded/blinded fixtures characterize the admitted extractor; they do not prove recall over real authored traffic, and no v1 dashboard or report may imply otherwise.

The explicit silent-miss experiment injects a versioned synthetic corpus of cue-free paraphrases into the hermetic Stop-hook/Test-as-Self path at every model/prompt change and reports misses separately from ordinary admitted traffic. Privacy-reviewed opt-in blinded samples may be added only by the future live-recall prerequisite; v1 never retains raw production samples. No v2/v3 dependency planning may treat synthetic success as production recall.

### 2.3 Criticality: judgment inside deterministic floors

The LLM suggests a tier; deterministic policy applies the minimum. Uncertainty rounds **up**, never down. Hedging or quotation can affect endorsement/confidence but cannot lower a protected predicate below its floor.

| Claim predicate/consequence | Minimum tier |
|---|---|
| Opinion, preference, hypothetical, or non-endorsed quotation | low only because it is not an endorsed factual claim; if the response endorses/applies the quoted proposition, the predicate floor applies |
| Temporal fact; ordinary queryable state | medium |
| Capacity/limit; completion; cross-agent action; operator approval/credential attribution | high |
| A factual premise explicitly offered to justify an irreversible or externally consequential action | irreversible-precondition |
| Unknown kind, ambiguous consequence, or classifier uncertainty | medium; high for approval, capacity, completion, or credential cues; `irreversible-precondition` when an irreversible-action premise may be present |

The policy, not model prose, decides the final tier. Calibration in v3 may raise a floor or increase sampling; it cannot lower these floors or turn uncertainty into `low`.

### 2.4 Deterministic resolution and verifier contract

LLM entity hints never become paths, URLs, repository names, query parameters, or credentials. The hook generates a cryptographically random UUIDv7 `messageAttemptId` in memory and sends JSON `{hookSchemaVersion,messageAttemptId,message,turnEvidence,topicHint?}` through the existing authenticated hook envelope. Body credentials and body-supplied authority fields are rejected. The route validates UUID/version, binds the ID to the authenticated session and a keyed message pseudonym, and deduplicates admitted work in the bounded server admission cache. Exact duplicate admissions return the prior admission result; the same ID with different content or scope is quarantined as `attempt-id-collision`; malformed IDs are rejected. The hook stores no attempt receipt and does not retry, so a request lost before server admission is intentionally absent from v1's denominator. Missing or invalid authentication performs no claim processing.

The route derives `{agentId, sessionId, topicId, projectDir, repository, machineId,ownershipEpoch}` server-side from the authenticated bind token, session registry, topic binding, project map, and conversation ownership record. Body hints never override those records. Missing/expired token, absent binding, repository mismatch, forged fields, stale owner epoch, or contexts that cannot yet be bound produce `coverage-unsupported`/`unverifiable` and cannot resolve an entity.

The deterministic resolver accepts only the closed `SubjectSelector`, confirms it lies within that authenticated scope, and emits a server canonical entity reference or `unverifiable:ambiguous|cross-scope|unauthorized|missing-binding`. The hook-side completion regex is removed: empty/oversized/truncated/unsupported payloads reach a content-free boundary counter instead of disappearing before HTTP admission.

Every cheap verifier implements:

```typescript
type ClaimVerdict = 'supported' | 'refuted' | 'unverifiable';
type ClaimAssessment = {
  claimId: string;
  verdict: ClaimVerdict;
  reasonCode: string;
  canonicalEntityId?: string;
  sourceKind: string;
  sourceMachineId?: string;
  sourceRevision?: string;
  observedAt: string;
  freshUntil?: string;
  evidenceRef?: string; // server-issued opaque typed handle, never a raw path/URL
  latencyMs: number;
};
```

Adapters are pure/read-only, have a 250 ms individual deadline, and run against at most one immutable snapshot per source per observation. The defensive shared adapter API accepts at most 12 claims for combined legacy/general callers, while v1 general observation submits at most 4. Maximums otherwise: 4 unique source snapshots, 4 concurrent reads, 32 KiB combined responses, and 750 ms total deterministic work. Claims are canonicalized and deduped; all session/commitment/guard claims share batched snapshots. A timed-out or breaker-open source is `unverifiable`. Absence, stale state, partial pool state, conflicting revisions, or revision mismatch is never `refuted`. Synchronous external GitHub/network fetches are prohibited. No existing canonical PR snapshot contract is available, so PR facts are always `unverifiable:no-canonical-oracle` in v1.

Freshness is predicate-specific and uses receiver-observed time, never a peer-claimed clock: session clock sampled within 2 seconds; local session/commitment/guard snapshot within 2 seconds; complete pool snapshot within 10 seconds with no failed required owner read; `TurnEvidence` bound to the exact response attempt. A canonical snapshot may `refute` only when it is fresh, complete, exact-revision, and its typed value is the logical complement of the typed operand. Missing rows, incomplete pools, stale caches, or different revisions remain `unverifiable`.

Deterministic tense eligibility is closed: `session.elapsed-ms` accepts `current` only (including present-perfect continuing duration such as “has been running for X” at observation); current session/commitment/guard state and PR merged/check predicates accept `current` only; `tool-action.completed` accepts `past|current` only when bound to exact same-turn evidence. Historical elapsed/state claims lack a history oracle and are `unverifiable`. `timeless|future|unknown` and every other unsupported predicate×tense pair are `unverifiable:unsupported-tense`. A current snapshot never refutes a past/future state assertion.

The v1 supported-predicate registry is finite:

| Predicate | Source | v1 disposition |
|---|---|---|
| elapsed session duration | live session clock, preserving TIME_CLAIM tolerance semantics | three-state assessment |
| `session.state`, `commitment.state`, `guard.state` | authenticated local/pool registry snapshot with the TTLs above | three-state assessment |
| `tool-action.completed` | `TurnEvidence`, preserving existing scope/action-kind decision table | three-state assessment |
| `pull-request.merged`, `pull-request.checks-pass` | **no canonical source currently exists** | always `unverifiable:no-canonical-oracle` |
| capacity/limit | **no canonical source currently exists** | always `unverifiable:no-canonical-oracle` |
| operator attribution, external fact, unsupported state | none in v1 | `unverifiable:no-supported-verifier` |

Prose such as `ORG-INTENT.md`, `CROSS-RUNG-COORDINATION.md`, boot context, PR bodies, logs, and comments may explain semantics but is never deterministic ground truth. No new operating-model file or boot injection ships in v1. Capacity verification requires a separately converged structured registry with schema/version, write authority, provenance, effective time, expiry, atomic updates, validated no-symlink path, replication/ownership, and canonical read API.

Therefore v1 mitigates the motivating capacity incident only through detection, criticality labeling, and dark audit; it cannot corroborate or interrupt a capacity assertion. A canonical capacity registry plus the separate advisory-graduation door are mandatory before any user-visible capacity advisory.

### 2.5 v1 decision table

| Tier | Supported deterministic adapter? | Assessment | v1 effect |
|---|---:|---|---|
| any | yes | supported/refuted/unverifiable | audit + grade/corpus candidate; never alter delivery |
| low | no | unverifiable | aggregate metric only unless sampled |
| medium/high/irreversible | no | unverifiable | audit as due-diligence candidate; never simulate v2 |
| any | extractor/resolver/provider unavailable or coverage incomplete | unverifiable with reason | audit degradation; delivery unchanged |

For `refuted`, v1 records the bounded counterfactual advisory `CLAIM_CONTRADICTION`; for high/irreversible `unverifiable`, it records counterfactual `CLAIM_UNVERIFIABLE`. Neither is returned as an enforcing advisory in v1. There is no acknowledgement token or hold semantics to invent in this release.

### 2.6 Audit, decision-quality enrollment, and corpus

V1 extends the existing local completion-claim audit and Decision Quality decision point. It does **not** build a distributed transparency log or a trusted pooled corpus. Each local row is bounded metadata:

The local JSONL remains the existing completion-audit storage pattern rather than adopting a generic event log: v1 needs one bounded origin-local append/read/rotation path, has no trusted replay or subscriber semantics, and must remain laptop-first without another daemon/database authority. Pool access reuses the existing bounded proxied read. Once rows gain automated authority, this rationale no longer applies and the separate evidence-ledger substrate decision is mandatory.

`schemaVersion,eventUuid,messageAttemptId,messagePseudonym,topicPseudonym,claimId,pseudonymKeyId,policyVersion,scrubVersion,privacyPolicyVersion,contentClass,detectorOutcome,coverageReason,kind,predicate,finalCriticality,confidenceBucket,canonicalEntityPseudonym,verifierId,verifierVersion,verdict,reasonCode,sourceKind,sourceRevision,observedAt,freshUntil,latencyMs,modelDoor,modelId,tokenCost,monetaryCostBucket,claimObservationBootId,originMachineId,dryRun,counterfactualAdvisory,disposition,labelTrustClass,eventualGroundTruthLabelId`.

Raw claim/evidence text, paths, URLs, identities, secrets, credentials, commands/results, and free-form rationale are excluded. Plain content hashes are prohibited. `messageAttemptId` is hook-originated and server-bound (§2.4). `claimId` is domain `instar.claim-id.v1` HMAC-SHA-256 over RFC-8785 tuple `(messageAttemptId,clauseId,sourceStartByte,sourceEndByte,predicate,subjectSelector,comparator,operand,tenseScope,consequence,policyVersion,schemaVersion,authenticatedScopePseudonym)`. Optional source revision uses `{present:false}`.

The exact key is SecretStore entry `claimVerification.pseudonymKeyV1`, 32 random bytes encoded base64. At AgentServer composition, `ClaimObservationIdentity` receives a getter over the existing per-agent encrypted `SecretStore`. Fresh install or first updated boot performs `getOrCreate` under an O_EXCL state-dir lock: read; if absent generate with `randomBytes(32)`, atomically `SecretStore.set`, reread, then release. A concurrent loser discards its candidate and rereads the winner. `pseudonymKeyId` is the first 16 bytes of `HMAC-SHA-256(key,"instar.claim-pseudonym-key-id.v1")`; `topicPseudonym` is the same key over domain `instar.claim-topic.v1` plus the authenticated local topic ID. The key is never logged, returned, synced, backed up separately, or accepted from config/body. V1 does not rotate it; encrypted-vault master-key rotation preserves the entry. Vault decrypt failure or invalid/recreated key disables claim/pseudonym joining and corpus settlement with `identity-key-unavailable`; rows whose recorded `pseudonymKeyId` no longer matches are quarantined from local/pool joins and exposed only in suppressed aggregate counts until ordinary retention deletes them. Non-joining aggregate assessment metrics continue. Boot/migration fixtures prove fresh create, update adoption, concurrent create, restart stability, vault-master rotation, key-loss quarantine, corrupt/decrypt-failed refusal, and no plaintext exposure.

Files enforce mode `0600`, cap at 50 MiB active + two rotations, and retain 90 days pending/365 days settled in a separate bounded local corpus projection (500,000 rows/500 MiB; oldest-expired-first). Before append, expired rows are removed oldest-first; if count/bytes still cannot accommodate the row without deleting an unexpired row, reject the new corpus row and increment the content-free `corpus_capacity_drop` counter. Audit assessment remains intact. The existing `scope=pool` read may show allowlisted observational rows with explicit partial-peer failures, but **v1 pooled rows are untrusted display data**: they cannot settle a label, satisfy principal diversity, enter miner holdouts, tune a model door, calibrate policy, or graduate an advisory.

The existing pool reader is constrained for this projection to a signed opaque keyset cursor, 16 peers/query, 200 displayed aggregate rows, 256 KiB total response, 1 second total and 250 ms/peer deadlines. Each peer receives the remaining row/byte budget; stable ordering is `(dayBucket,originMachinePseudonym,shapeId)`. Limit/deadline/peer failure returns the bounded partial page plus `partial:true`, failed/omitted peer counts, and a next cursor; it never silently presents a partial page as complete.

V1 deterministic adapters issue an in-process `SourceReceipt {receiptSchemaVersion,receiptId,claimId,predicate,canonicalEntityPseudonym,typedResult,sourceKind,sourceRevision,observedAt,freshUntil,claimObservationBootId}`. The adapter is the issuer; receipt is bound to the same claim assessment and immutable in the local process. A T0 local label exists only when this receipt remains fresh/exact and a later authoritative outcome confirms the same predicate/revision. V1 has no T1 adjudication command, API, or write path; T1 remains a reserved future trust class whose authenticated lifecycle requires its own converged interface. T2 reviewer and T3 model labels are observational. T0 supersession/revocation is append-only locally. These labels may drive v1 metrics but remain **automation-ineligible**.

The local benchmark row is `claimShapeId,topicPseudonym,pseudonymKeyId,claimKind,predicate,criticality,modelDoor,modelId,verifierVersion,verdict,groundTruthVerdict,correctness,costBucket,latencyBucket,evidenceClass,observedAt,settledAt,labelTrustClass`. `claimShapeId` is `(shapeSchemaVersion,predicate,subjectKind,operand.type,tenseScope,consequenceClass)`, never raw prose. Scrub failure drops the row and increments `corpus_scrub_drop`. The local corpus provides dark benchmark observations from day one, satisfying the v1 data-flywheel requirement, but automated consumers remain disabled.

Structured metadata can still re-identify rare activity when shape, model, timing, and pseudonym are joined. Therefore pool display rounds timestamps to the day, buckets cost/latency, and never returns per-message/per-claim/topic join keys. Each origin independently suppresses a `(day,shape,door/verifier)` cohort unless it has at least 20 rows across 5 distinct **local** `topicPseudonym` values under the current key ID; the pool reader merges only already-qualified origin aggregates and never sums peer topic counts to manufacture the threshold. This is conservative when one topic spans machines. Exact local rows remain mode-`0600` operational data under the retention bounds above. Pseudonyms reduce accidental disclosure; they are not claimed to anonymize the corpus.

Before v2 miner promotion, cross-machine trusted benchmarking, or v3 calibration can enable, a separately converged **Verified Claim Evidence Ledger** must provide origin authentication, append integrity, anti-rollback, trusted-head persistence, replication/fencing, receipt validation, revocation, retention proofs, complete pagination, and installation-wide topic/principal cohort identities. This names a required behavioral contract, not a decision to build a blockchain, DLT, or bespoke consensus system. Its separate implementation spec must inventory existing Instar signed-event/replication foundations and compare concrete alternatives—including SQLite WAL with signed checkpoints, a Rekor-style transparency log, NATS JetStream, and Kafka-compatible logs—against an external service or minimal reuse design before choosing one substrate and converging its failure/migration model. Every ledger-dependent v2/v3 paragraph here is a conditional design sketch, not an interface commitment. V1 persists only versioned bounded metadata and opaque optional evidence handles; it must not bake in ledger page IDs, tree/hash formats, quorum rules, key layouts, or cross-machine identity pseudonyms.

V1 rows alone therefore **cannot** satisfy v2's topic/principal diversity or concentration gates. The future ledger may import them only into aggregate observational benchmark cohorts, never miner promotion/holdout cohorts. Miner-eligible rows begin prospectively after that ledger captures authenticated installation-wide `topicCohortId` and `principalCohortId` at admission; v2 must then accumulate the full §3.1 sample/window thresholds anew. This v1 spec neither selects nor authorizes the ledger technology. In its absence, miner/calibration/model-door routing stay disabled and the general path remains observe-only.

V1 does not create raw-message escrow. A statistically valid live recall audit is another privacy-reviewed prerequisite for user-visible advisory graduation; until then `liveRecall=unavailable`. Raw samples never enter this corpus or miner.

### 2.6.1 Concrete v1 trace

For “The session is stopped, so I can deploy,” the model emits a current `session.state eq stopped` claim with a `premise-for/production-deploy` consequence. The deterministic floor raises it to `irreversible-precondition`. The resolver binds only the authenticated current session, then reads its fresh registry snapshot. If the exact state is `running`, the assessment is `refuted` with the source revision and time. V1 still sends unchanged; it writes only bounded local audit metadata and a shape such as `(session.state,session,state-enum,current,production-deploy)`. It stores neither the sentence nor registry content, and the row cannot train or route anything until a future evidence ledger admits it.

For “We are capped at four lanes,” the same hook/privacy/arbiter path emits `capacity.limit eq 4`, the deterministic floor makes it high, and the registry reports no verifier. The assessment is `unverifiable:no-canonical-oracle`; delivery is still unchanged. The local row records the capacity shape, model door, reason, cost, and latency without the sentence. This unsupported trace measures recurrence and extraction quality while refusing to fabricate capacity truth.

### 2.7 Telemetry and admitted-path readiness gates

Required v1 metrics use the honest **server-admitted** denominator: admitted/evaluated/queued; queue-full/provider-failure/invalid-output/coverage-incomplete; claim count/kind/tier; seeded recall separately for the deterministic protected-gap lane and LLM general extractor, with cue-free-indirect, compound/cross-sentence, cardinality-saturated, adversarial-injection, and quotation/endorsement-confusion strata; exact-match accuracy for `endorsed`, `tenseScope`, and `consequence`; saturated-message prevalence and claims per saturated/non-saturated message; extraction-gap reasons; protected-cue disagreement; local label precision; verifier verdict/reason/latency/freshness; oracle fan-out/cache/breaker; counterfactual advisory rate; corpus pending/settled/scrub-drop; cost/model-door attribution. `eligibleCoverage` and `liveRecall` are explicitly `unavailable` because the fire-and-forget Stop hook does not durably record raw or content-free attempts before network admission. Every API field, dashboard label, exported metric help string, and report heading must say **“server-admitted only”**; generic labels such as “claim recall,” “coverage,” or “production recall” are prohibited for v1.

V1 **admitted-path** readiness targets are: >=1,000 admitted messages and 200 locally settled **T0** protected claims over 14 days; deterministic protected-gap recall =1.0 on its closed cue fixtures; LLM seeded recall >=0.98 overall, >=0.95 in each cue-free-indirect, compound/cross-sentence, and cardinality-saturated stratum, and >=0.98 in adversarial-injection and quotation/endorsement-confusion strata using one-to-one `(predicate,span overlap >=0.5)` matching; exact-match accuracy >=0.97 for each of `endorsed`, `tenseScope`, and `consequence`; every missed protected/injection fixture must produce the conservative extraction-gap signal; local T0 refutation precision >=0.99; false-positive counterfactual advisory rate <=0.01; provider+invalid+queue failures/admitted <=0.01; deterministic work p95 <=100 ms/p99 <=500 ms; zero leaked raw content/secrets. Saturated prevalence/density is always reported, and results filtered to non-saturated messages may never support an advisory-graduation claim. These measure extractor/verifier behavior only after server admission. V1 cannot estimate production miss rate, hook transport health, eligible coverage, or live recall at all; no admitted-path metric may be presented as production recall. They are **necessary but never sufficient** for advisory graduation.

Saturated messages and their rows are also excluded from recurring-shape frequency/cost conclusions and every future miner business-case calculation; overflow sampling requires a separately privacy-reviewed bounded design. This prevents the four-claim priority rule from making dense operational updates look rarer or safer than they are.

Advisory graduation is structurally impossible until both separate prerequisites exist: (1) a channel-neutral coverage/live-recall substrate proving >=0.90 evaluated/eligible overall, >=0.95 protected strata, <=0.1% transport loss, live recall >=0.95, and protected-cue-stratum recall >=0.98 on seeded fixtures plus privacy-reviewed blinded human samples; and (2) the Verified Claim Evidence Ledger proving trusted outcomes across machines. A `protected-cue-unextracted` event counts as a miss in that stratum. Failure/regression keeps or demotes to observe-only. Because v1 config is restart-required, explicit `false` becomes effective only after the controlled server restart; the old process may admit until shutdown and holds no durable queue. Boot generates an immutable `claimObservationBootId`; queued work belongs only to that process and disappears on restart. V1 does not claim live `configEpoch` fencing.

## 3. v2 design — miner and bounded due diligence (not build scope)

Everything in §§3-4 is an illustrative conditional design constraint, not a ratified interface. Names, schemas, APIs, thresholds, and substrates—including the evidence ledger, recipe registry, TaskFlow replication, receipt schema, correction outbox, and calibration controls—must be reconsidered and separately converged before implementation. V1 may not create compatibility dependencies on them beyond opaque optional evidence handles and versioned local metadata.

### 3.1 Recurring claim-shape miner

The miner consumes only prospectively settled, scrubbed rows natively admitted by the Verified Claim Evidence Ledger with installation-wide topic/principal cohort identities; raw v1 local rows remain miner-ineligible even if imported for aggregate benchmarking. It never reads raw conversation text. TIME_CLAIM is the seed shape. Each agent installation grows one pool-unified fleet-general library through the same shipped mechanism; unrelated installations do not share records, and no central hand-authored answer set is required.

A candidate shape may be promoted only when all deterministic gates pass:

1. at least 200 T0/T1 settled examples across at least 20 topics, 5 authenticated principals, and 14 days, with no principal over 25%;
2. at least 100 temporally later examples reserved as a holdout before candidate fitting;
3. lower 95% Wilson bound for correctness >= 0.99, recall >= 0.98, and zero cross-scope/security violations;
4. p95 latency and effective mean cost improve by at least 50% over the same cohort; effective cost includes fallback, shadow checks, monitoring, and amortized mining/fitting work;
5. the candidate uses a registered read-only verifier recipe: a deterministic adapter or a pinned small-model schema over server-supplied typed evidence. It cannot generate code, regexes, tools, paths, URLs, or new oracle access.

Mining is bounded to a daily scheduled pass, 10 CPU-minutes and 100k tokens/day, one fit at a time, at most 2,000 candidates and 256 active recipes installation-wide, 90-day unsupported-candidate TTL, 30-day recipe renewal, one active version/shape, tombstones retained 365 days, and deterministic least-support/oldest eviction. Candidate holdouts are sealed before fitting; at most three recipe-family attempts may touch a development holdout, while the final promotion set is never surfaced. Expiry/GC is idempotent. Shadow work shares the miner budget and may reduce to zero under pressure without changing verdict/criticality.

The miner proposes; the invariant gate disposes. V2 activation requires a separately proven `ReplicatedClaimRecipeRegistry`; current `SharedStateLedger` is explicitly **not** that substrate. The prerequisite registry API is `propose/get/list/activate/demote`, with structured recipe schema, replicated quorum-visible records, canonical owner lease/epoch, OCC activation epoch, signed RFC-8785 events, authenticated machine keys/rotation, atomic persistence, and a deterministic projection consumed by every verifier router. Invalid signature, unknown key, rollback, conflict, expiry, loss of quorum, or unreachable canonical owner demotes to the general path. Entries carry shape schema, recipe/version, evidence classes, sealed random holdout ID, metrics, activation epoch/time, expiry, and signer key ID. V2 stays disabled until the registry passes multi-machine partition/failover and mixed-version proof; there is no local activation fallback.

Promoted small-model checks remain signals and are shadow-compared on up to 10% of traffic. The named `ClaimRecipeInvariantGate` is the sole activation/demotion authority. It reads only trusted ledger cohorts plus recipe/registry state and deterministically demotes when a rolling 200-label window's Wilson lower bound falls below 0.97, a validated security/cross-scope fault exists, or schema/recipe freshness fails. A benchmark-divergence alarm is advisory input only: it triggers a gate reevaluation but cannot itself dispose routing; the gate records its inputs, rule, and outcome. Missing/conflicting trusted state conservatively demotes. Drift can only increase conservatism. Promotion/demotion never changes the criticality floor.

Alternatives rejected for v2: offline classifier training is harder to audit/reverse and risks content centralization; a generic rules engine would still need the same trusted labels, holdouts, typed evidence, and activation authority. The miner is deliberately a declarative recipe selector over the existing verifier catalog, not runtime code synthesis. Before its implementation spec may proceed, v1 corpus evidence must show at least 3 recurring eligible shapes whose projected manual predicate maintenance exceeds one addition/month or whose aggregate general-path cost exceeds US$25/month; otherwise the simpler hand-authored catalog remains the chosen design.

### 3.2 Due-diligence workflow

High/irreversible v1 `unverifiable` claims become v2 candidates. V2 uses `TaskFlowRegistry`; it does not introduce a queue engine. One immutable claim package is stored as scrubbed typed metadata plus opaque server-issued evidence handles:

`claimId, messageAttemptId/pseudonym, authenticated scope, normalized predicate/typed operand, criticality, source/config versions, origin machine, conversation owner, deadline, evidence-handle allowlist`.

The idempotency key is `claim-verification:<claimId>:<evidenceRevision>`. TaskFlow states map as:

`queued(create) -> running(start) -> waiting(evidence callback if needed) -> completed|failed|cancelled|lost`, with terminal result `supported|refuted|unverifiable|superseded|expired` in the scrubbed result. OCC revision, `waitInstanceId`, controller heartbeat, maintenance lost-marking, and restart recovery use the existing TaskFlow contracts.

TaskFlowRegistry is chosen because it is the already-shipped, laptop-first lifecycle and recovery substrate used by this installation; adding Temporal, Cadence, or Airflow would introduce a second always-on control plane, deployment dependency, identity boundary, and workflow authority for one bounded feature. V2 does not claim TaskFlow is ready as-is: replicated fenced ownership is an explicit prerequisite below, and failure to prove it leaves v2 disabled.

**Unified ownership is a hard v2 prerequisite:** TaskFlow must first support replicated records plus the existing conversation-owner lease/epoch as its fenced single-writer authority. The current conversation owner creates/leases the job; replication makes the record pool-visible; after lease expiry the new owner resumes the same flow/idempotency key and stale epochs cannot write. Partitioned owners cannot both reach terminal state because terminal OCC includes the ownership epoch. If that prerequisite is absent, v2 remains disabled—there is no machine-local exception.

Admission is bounded: 256 queued installation-wide, 1 active job/topic, 4 active jobs/installation, fair round-robin across topics, and one reserved slot for irreversible candidates. Ordinary work may borrow that slot only when no irreversible job is queued; arrival of an irreversible job prevents the next ordinary renewal/admission but never kills in-flight work, and round-robin still gives each ready ordinary topic one turn per cycle. Queue-full yields `unverifiable:due-diligence-overloaded`, never an unbounded retry. Equivalent normalized claims coalesce by the idempotency key; edit/delete/corrected resend emits cancellation/supersession. Config epoch fences late results. The later v2 implementation spec must choose concrete aggregate hourly/daily token and spend defaults before authorization.

The “team” means independent evidence roles, not majority vote. Maximum 3 verifier roles/claim; no recursive spawn; one model call and four tool reads per role; 8,000 input + 1,000 output tokens/role; 32 KiB evidence/role; 90 seconds/role; 10 minutes/claim; maximum 2 attempts with capped exponential backoff; hourly/daily token and spend caps through shared `LlmQueue`/`IntelligenceRouter` background lanes. Provider breakers and subscription-path rules are inherited.

The finite role registry is: `canonical-source-reader` (reads the predicate recipe's named canonical API), `provenance-reader` (checks source revision/ownership and attested production provenance), and `scope-freshness-auditor` (checks principal/scope/freshness/conflicts). A deterministic recipe table maps each supported predicate/evidence class to 1-3 roles; duplicate sourceKind+revision receipts are one evidence source, not independent votes. Unknown predicates receive only the scope auditor and remain unverifiable. Role selection is deterministic.

Verifier input is inert, byte-bounded data. Tools are fixed read-only allowlists scoped to canonical server APIs. Verifiers are denied shell, arbitrary network, filesystem write, message send, external mutation, subagent spawn, raw credentials, and arbitrary evidence discovery. Evidence handles are typed, revisioned, scope-bound, expiring, and validated server-side. Each read produces a server-attested receipt `{receiptId, claimPackageId, configEpoch, ownershipEpoch, principalScopeId, handleId, canonicalQueryId, predicate, canonicalEntityId, sourceKind, sourceRevision, observedAt, freshUntil, typedResult, resultDigest, attesterKeyId, keyEpoch, signature}` over RFC-8785 canonical bytes.

Validation resolves a currently trusted attester/key epoch; verifies signature and revocation; matches claim package, config/ownership epoch, principal/topic/project/repository scope, handle, predicate/entity/query, and requested source revision; recomputes the result digest; and evaluates freshness from receiver time. Receipt IDs are single-use per claim package; replay/substitution, unknown/revoked key, mismatch, expiry, or conflicting duplicate is quarantined and yields `unverifiable`. Fact receipts may be reused only when the recipe explicitly marks the fact scope-independent and every bound field still matches. The deterministic aggregator consumes validated receipts only; role prose/verdicts cannot support or refute. Absence of a canonical receipt yields `unverifiable`.

Aggregation is evidence-based: one fresh canonical refutation refutes; one fresh canonical support supports only the exact predicate/revision; conflicting canonical sources, non-independent duplicate evidence, all-model agreement without canonical evidence, timeout, or ambiguity is `unverifiable`. The aggregator is deterministic and records conflicts.

### 3.3 V2 correction and sync/async boundary

V2 remains asynchronous for every conversational claim. **No synchronous message hold ships in v2.** Irreversible actions are already governed by external-operation/coherence/mandate authorities; claim verification supplies evidence to those authorities only through a separately specified integration, never authorizes the action itself.

Before any correction feature can enable for a channel/account/destination, the transport must provide a durable authenticated delivery receipt mapping the authored `messageAttemptId` to `{conversationId,channel,workspace/account,destination,platformMessageId,deliveryIdempotencyKey,deliveredAt,ownerEpoch}` **and** prove two transport capabilities: idempotent dispatch by the stable key, and an authoritative query returning `delivered|absent|ambiguous` with receipt authority, observed time, and freshness. The per-channel capability matrix also covers edit/delete/reply semantics. Retry/fan-out creates distinct receipts under the same attempt. Any missing/ambiguous/unsupported/unowned receipt or missing dispatch/outcome capability keeps that destination audit-only.

All due-diligence jobs for one delivered message join a durable message-level aggregate keyed by the authenticated delivery identity. The initial window closes when every initially extracted high/irreversible claim is terminal or at the 10-minute claim deadline, whichever comes first. It orders refutations by criticality then claim ID and produces one bounded summary covering every refutation known at close. If that close sends/reserves no correction, the aggregate remains `late-refutation-eligible` until one hour after authenticated delivery: the first fresh authoritative refutation may reopen it once, reaggregate every then-known refutation, and attempt the single correction. After a correction is reserved/delivered/terminally disposed, or the one-hour horizon expires, later settlements are audit-only. Claim stuffing cannot extend either deadline. Settlement orders, zero-refutation close, late first refutation, timeout, crash, and takeover are tested.

The owner then revalidates source revisions and checks edit/delete/acknowledgement/supersession. The correction ledger/outbox uses a domain-separated HMAC over canonical `(channel, workspace/account, conversation/destination, platformMessageId)`, never a bare platform ID, and a CAS/fenced state machine:

`eligible -> reserved(ownerEpoch,configEpoch,evidenceRevision,freshUntil,transportIdempotencyKey) -> dispatching -> delivered | failed-terminal`.

Reservation and stable transport idempotency key are durable before send. Immediately before transport, the sender rechecks owner/config epoch, message supersession, and evidence freshness. A crash/takeover may resume `reserved/dispatching` only after querying the authenticated channel delivery outcome by the same idempotency key; confirmed delivery settles `delivered`, confirmed absence retries once, and ambiguous outcome remains `dispatching` for reconciliation rather than sending again. Stale owners fail CAS. Relay retry for the same authenticated delivery identity is idempotent; fan-out destinations have distinct identities and each requires capability proof. Thus at most one user-visible correction is eligible per delivered platform message; later evidence revisions update audit only. Corrections contain minimal redacted language and never repeat sensitive claim/evidence content. User-facing correction delivery belongs to the owning conversation authority; Attention receives only ownerless delivery failure or aggregated subsystem degradation, with per-topic rolling limits and one global-breaker notice. `unverifiable` is metrics-only by default.

## 4. v3 design — conservative closed-loop calibration (not build scope)

V3 reads only Verified Claim Evidence Ledger cohorts that meet minimum sample/privacy thresholds; raw v1 local corpus is ineligible. It may recommend model-door routing, prompt versions, sampling rates, or higher criticality. Recommendations enter the existing benchmark-divergence/decision-quality review surface; they do not edit prompts, policy, gates, or verifier recipes directly.

Automatic changes are limited to conservative moves already admitted by versioned configuration: increase tier, increase general-path sampling, demote a promoted shape, or route to a door whose lower confidence bound is better at equal-or-lower privacy class. Lowering a tier, reducing verification, changing an oracle, or promoting a checker always requires the deterministic gates in this spec and a dark holdout. Provider/data-residency changes require their existing operator controls. Every change is versioned, auditable, reversible, and killed by the claim-verification feature flag.

Benchmark views report accuracy confidence intervals, cohort size, cost, latency, unknown rate, and door/model version per claim kind. They never surface tiny cohorts or raw examples.

## 5. Configuration, deployment, and rollback

The existing `monitoring.completionClaimVerification` namespace is extended—there is no second config namespace. `enabled` retains its existing dev-gate/default semantics; `dryRun` defaults true; generated `providerPolicy` is the closed same-origin `claude-code` policy in §2.2, with no configurable v1 fallback list. All are restart-required in v1 because AgentServer captures them at construction. The generated hook carries `hookSchemaVersion` and server admission rejects an incompatible hook version as `coverage-unsupported`; update migration always overwrites the generated hook. Explicit `false` wins **after restart** and then stops general + legacy completion admission together. The flag does not disable TIME_CLAIM or `/messaging/preflight`. A future LiveConfig conversion must atomically update hook/server under one config epoch and is not claimed here.

No boot-context provider, operating-model file, new sender hook, or channel adapter change ships in v1. Fresh install and update parity extend the already-authoritative `PostUpdateMigrator.getCompletionClaimObserveHook()`/`getHookContent()` and `src/templates/hooks/settings-template.json` registration. The same PR updates the concise generated CLAUDE/AGENT awareness from completion-only to “general claim observation, dark/observe-only,” with a pointer to the capability/audit rather than schema detail. `generateClaudeMd()` emits marker `Claim Verification awareness v2`; `migrateClaudeMd()` first performs an exact bounded replacement of the currently shipped `Verify Before Done (observe-only v1)` paragraph, then uses the v2 marker as its idempotency guard. It never relies on the old presence check to skip the replacement. Tests cover migration from the shipped paragraph, clean init, update-in-place, repeated migration, hook-version drift remediation, compaction/Stop behavior, explicit-disable preservation, and non-Claude no-op. The standalone session-start template is untouched because it is not part of this feature.

The hook keeps the existing fire-and-forget transport and stores no raw/content-free attempt ledger. It generates the attempt UUID in memory, sends the authenticated request, and exits under the existing abort bound. Consequently v1 measures only server-admitted observations and makes no eligible/transport-loss claim. This is why advisory graduation requires a later channel-neutral coverage substrate (§2.7). The delivery path awaits no disk, peer, model, verifier, or audit work.

Implementation has two merge checkpoints, not two runtime configurations: first the extractor, deterministic assessment, and local v2 audit; then pool-read, Decision Quality, and scrubbed corpus projections. The v1 release is not declared complete until both land and their delivery-path, redaction, rotation, and privacy fixtures pass. Projection failure cannot fail admission or delivery and leaves the local audit readable. The corpus is a required operator-addendum outcome, so v1 includes it rather than postponing it to v2. There is no unnamed projection flag or partial operator posture.

A smaller “local audit + seeded fixtures only” v1 was rejected. It would measure model behavior but would not deliver the operator-required scrubbed benchmark corpus, eventual T0 outcome linkage, model-door/cost/latency comparison, or pool-visible observation, forcing a second incompatible schema/migration before the first soak could answer whether recurring shapes justify v2. Reusing existing Decision Quality and pool-read projections adds bounded consumers of the same local event, not new authority; privacy and delivery regressions are contained by the two merge checkpoints and observe-only posture.

Existing `AGENTS.md`/`GEMINI.md` shadows are updated through the IdentityRenderer source plus its registered shadow-marker list, not assumed to follow a CLAUDE bullet automatically. The migration adds the v2 awareness marker to the renderer/copier and performs an idempotent bounded replacement in existing shadows; tests start from currently shipped completion-only CLAUDE/AGENTS/GEMINI files and prove parity after one and two updates.

V1 stores both canonical artifacts under `.instar/state/claim-verification/`: `claim-observation-audit-v2.jsonl` and `claim-benchmark-v1.jsonl`, each with its declared rotations/caps and schema-versioned rows. It never continues or renames legacy `completion-claim-audit.jsonl(.1)`. The new local GET/corpus reader opens only these canonical files. All claim-verification state and legacy files are gitignored and backup-excluded because restoring an origin-local observational corpus would duplicate identities and violate retention; restore starts empty and records `corpus_restore_empty` in ordinary server metrics. The backup manifest denylist and file-view never-serve prefixes are Tier-3 wiring proofs.

Legacy files (which may contain `target`/`rationale`) are mode-repaired, excluded from GET/corpus/new backups, retained locally for 7 days, then unlinked by a new bounded `ClaimObservationHousekeeper` constructed with AgentServer. It runs at boot and every 6 hours, validates exact no-symlink canonical paths, deletes at most four eligible legacy files/pass, and appends content-free `{schemaVersion,pathClass,deletedAt,outcome}` rows to `.instar/state/claim-verification/retention-receipts-v1.jsonl` (0600, 1 MiB + one rotation, 30-day retention, backup-excluded). Failure retries next cadence and increments a metric; it never affects delivery. An old rollback binary may recreate/write only its old filename and cannot corrupt v2; a new binary again ignores/quarantines it. Migration is an idempotent marker plus mode/retention registration. Tests cover legacy active/rotation/malformed/recreated-after-rollback files, symlinks, boot/cadence retry, local/pool exclusion, empty restore, retention, and deletion receipt.

The queue/DI graph is exact: composition root constructs one `ClaimObservationAdmissionQueue` (replacing `CompletionClaimVerifier.queued/recent/setImmediate`) and injects its `enqueue` closure into the single `CompletionClaimVerifier`. That queue alone owns feature admission, dedupe, per-topic buckets, fair round-robin, and the 128/8 caps. Its worker calls one queue-wrapped `IntelligenceProvider` created by the shared `LlmQueue` + `IntelligenceRouter`; composition root passes that wrapper instead of the bare provider. The feature does not instantiate a second provider scheduler; old local fields/path are removed, not stacked.

V1 extends shared `LlmQueue` with `enqueueMetered({component,estimatedInputTokens,maxOutputTokens,estimatedCostCents,hourly,daily,run})`. Admission atomically reserves component `claim-verification` request/token/cent budgets before provider execution; actual input/output usage and cost from the provider usage envelope reconcile the reservation afterward, with conservative reservation retained when usage is unavailable. Queue-owned counters enforce 10M input/4M output tokens and the $5 sub-cap in addition to installation limits; attribution is immutable and exported to the existing token/cost audit. `IntelligenceRouter` chooses provider/door but owns no budget counter. DI/wiring tests assert one verifier, one feature ingress queue, one shared provider queue, and every evaluation traverses both layers and metering exactly once.

Rollback requires the controlled server restart already required by config. Shutdown stops new HTTP admission, abandons the in-memory queue, and waits at most the existing bounded server drain for an active provider call; after restart `enabled:false` admits nothing. Audit/corpus history remains readable. No deletion or schema downgrade is required. V2/v3 rollback fencing is conditional on their future converged config/ownership designs and is not claimed by v1.

Mixed-version machines expose verifier/policy/schema versions in the pool audit. Unknown newer fields are dropped by the allowlist; incompatible rows remain visible as `version-unsupported`, never merged into calibration cohorts.

## 6. Security and privacy invariants

1. Model-visible message/evidence is explicitly marked untrusted inert data.
2. Model output is schema-validated and never selects tools, scopes, paths, URLs, credentials, destinations, or authority.
3. Authenticated principal/topic/project/repository/machine context comes from the runtime envelope, never message text.
4. Ambiguity and cross-scope resolution are `unverifiable`.
5. Prose and model consensus are not ground truth.
6. Arbitrary URL/attachment/log/PR-body fetching is prohibited in v1; v2 uses typed handles and fixed read-only APIs.
7. Evidence and corrections are minimized, scrubbed, scope-bound, and retention-bounded.
8. No claim component may send, mutate external state, authorize an operation, or spawn recursively.
9. Provider processing follows existing privacy/data-residency and kill-switch controls.
10. V1 local corpus is explicitly automation-ineligible; malformed/stale rows are excluded even from observational metrics.
11. Trusted pool export or automated learning cannot ship until the separately converged evidence ledger and privacy threat model cover origin authenticity, rollback/fork, receipt validity, retention, backup restore, key/schema versions, and pseudonym privacy.

## 7. Testing and proof

### Tier 1 — unit

- Schema/property tests: invalid enums/offsets/cardinality, all comparator/type pairs and boundaries, compound/negated/quoted/hedged/endorsed claims, consequence span/connective validation, pronouns, Unicode/confusables, multilingual unsupported behavior, oversized input, injection in message/evidence fields, and generated worst-case wire output within byte/token caps.
- Provider-boundary fixtures prove raw credentials, Secret Drop URLs, private identifiers, and secret-shaped values in both message and `TurnEvidence` never reach provider mocks; scrub/classifier/schema failure and disallowed residency doors invoke no provider and record only the content-free coverage reason; offsets are validated against scrubbed UTF-8 text.
- Criticality table tests proving protected floors and uncertainty round-up cannot be lowered by calibration.
- Resolver tests for authenticated binding, ambiguity, cross-topic/project/repo/machine attempts, and LLM-supplied raw lookup rejection.
- Adapter contract tests for supported/refuted/unverifiable, freshness, absence, partial pool, conflicting revision, flapping source, PR predicates remaining no-canonical-oracle, deadlines, batching, dedupe, and breakers.
- Existing completion/action-claim regression tests proving one arbiter and unchanged Action-Claim behavior.
- Observe-only wiring proof: a refuted claim produces audit/counterfactual advisory but the response is never withheld or rewritten.
- Local audit redaction/rotation/mode, untrusted pool-display exclusion, legacy audit quarantine, idempotent grade linkage, relabel provenance, and corpus scrub/drop tests.
- Load/fault tests at queue cap and maximum claim/oracle cardinality; assert the hook awaits no disk/network/model/verifier/audit work and delivery timing remains within the existing hook budget.
- Seeded and blinded corpora include time, completion, capacity-without-oracle, state, approval, quoted/hedged high-impact, and claim-splitting cases.

### Tier 2 — full-route integration

- Real Stop-hook payload -> `/completion-claim/observe` -> DI-owned verifier -> local audit/stats/decision-quality/corpus projection, including dropped fire-and-forget transport (honestly absent from denominator), disabled/dry-run/restart-required config, and incompatible hook schema.
- Existing pool display with partial peer/mixed version remains observational and cannot enter automated cohorts.
- Action-Claim and TIME_CLAIM regression routes prove the shared arbiter does not gain delivery authority or change legacy disposition.

### Tier 3 — production-init E2E and Test-as-Self

- Clean `init` and update-in-place install the same hook/settings/awareness; repeat update is byte-idempotent; non-Claude remains explicit no-op; rollback plus controlled restart stops admission without disabling TIME_CLAIM.
- A production-init server with the generated Stop hook feeds a realistic supported response into the existing hermetic in-memory relay transport; the refuted claim reaches the observer/local audit and the byte-identical response reaches the fake destination. No external account, channel, or person is contacted. A direct-adapter/unsupported-path negative control is not claimed covered.
- Wiring-integrity proves the generated hook, route, AgentServer dependency, one arbiter instance, config namespace, capability index, awareness, decision-quality registration, backup manifest, and pool projection are connected.
- Pre-merge requires targeted tests plus zero failures in `pnpm test:all`; any unrelated baseline failure is recorded with reproduction/ownership and blocks an unqualified green claim. Real live-channel execution is an explicit post-build operator-run boundary, not part of the autonomous implementation or pre-merge gate; this spec does not pre-authorize a destination.
- Measure authored-response-to-relay timing with the feature disabled/enabled at realistic peak load. The delivery path awaits no local persistence, network admission, model, verification, or audit; end-to-end Test-as-Self proof supplements synthetic load.

### V2/v3 design-level test matrix

- TaskFlow legal/illegal transitions, OCC conflict, idempotent create, restart recovery, fenced cross-machine ownership transfer, partitioned stale-writer rejection, queue fairness/reserved slot, cancel/supersede/config fencing.
- Read-only capability proof, prompt injection from every evidence source, evidence-handle scope/expiry/hash, recursive-spawn denial, token/tool/deadline/spend bounds.
- Aggregation conflicts, correlated duplicate evidence, correction outbox CAS/crash-before-send/crash-after-send/ambiguous-outcome/takeover/stale-owner tests, correction revalidation/dedupe/rate limit/global breaker, ownerless failure aggregation.
- Miner temporal holdout isolation, Wilson-bound thresholds, declarative-recipe allowlist, shadow comparison, automatic demotion, and proof that drift cannot lower criticality.
- Corpus privacy, cohort thresholds, settled-label provenance, door/model divergence, and conservative-only calibration property tests.

## 8. Acceptance criteria and implementation stop line

V1 is implementation-ready only when a builder can extend the existing claim pipeline without adding a second extractor, queue, audit, outbound authority, or prose oracle; all finite predicates, bounds, fallbacks, schemas, rollout behavior, and tests above are implemented; and the dark-soak metrics are visible through existing decision-quality/pool-audit surfaces.

The v1 implementation must contain no `VerifiedClaimEvidenceLedger` API/client, ledger-named IDs or schemas, v2/v3 feature stub, correction outbox, recipe registry, or compatibility adapter for the illustrative future contracts. Static import/name scans and DI tests enforce that absence; only opaque optional `evidenceRef` and the versioned local v1 metadata are permitted seams.

V2 and v3 are deliberately **not authorized by this spec-converge handoff**. Their designs exist to prevent v1 from painting the system into a corner. They require new operator-reviewed implementation specs after v1 soak evidence exists.

## Multi-machine posture

| Surface | Posture | Named path and consequence |
|---|---|---|
| V1 claim observation/admission | unified by conversation ownership | The authenticated Stop-hook request reaches the current session server; stale/mismatched ownership is unsupported and never resolved cross-scope. |
| V1 audit and corpus storage | proxied-on-read | Each origin writes its bounded local `claim-observation-audit-v2.jsonl`; the existing authenticated `scope=pool` GET merges allowlisted rows and reports partial peers. Rows remain observational and automation-ineligible, so ownership transfer cannot create a false trusted outcome. |
| V1 deterministic pool snapshots | unified only when complete | A pool result may support/refute only with a complete fresh owner snapshot; partial/unreachable peers yield `unverifiable`. |
| V2 TaskFlow and recipes | unified prerequisite | Replicated fenced TaskFlow ownership and `ReplicatedClaimRecipeRegistry` must exist before enablement; there is no local fallback. |
| V2/V3 trusted evidence and calibration | unified prerequisite | Verified Claim Evidence Ledger admission is required before cross-machine labels, mining, routing, or calibration. |
| V2 correction delivery | unified by conversation owner | Authenticated delivery receipt plus owner epoch and fenced outbox permit one current owner; ambiguity remains audit-only. |

No v1 surface claims machine-local authority. Physical local files are origin shards behind the named proxied-on-read pool surface, not a trusted machine-local decision store.

## Decision points touched

| Decision point | Classification | Floor, arbiter, and fallback |
|---|---|---|
| Is text an endorsed factual claim? | judgment-candidate | Closed model schema; bounded one-pass `ClaimClauseArbiter`; invalid/unavailable output becomes `unverifiable`/coverage degradation, never authority. |
| Claim criticality | judgment-candidate | Model suggests; deterministic predicate/consequence floors round uncertainty upward; invalid consequence that may justify an irreversible action becomes `irreversible-precondition`. |
| Entity/source resolution | invariant | Closed typed selectors plus authenticated runtime scope; ambiguity, mismatch, or stale scope is `unverifiable`. |
| Supported/refuted/unverifiable | invariant | Typed comparator against fresh complete exact-revision canonical evidence; every absence/conflict/staleness fallback is `unverifiable`. |
| V1 message disposition | invariant | Observe-only: unchanged delivery regardless of assessment. Existing outbound authorities remain sole arbiters. |
| V2 role selection | invariant | Predicate/evidence-class recipe table with finite read-only roles; unknown predicates remain unverifiable. |
| V2 evidence aggregation | invariant | Valid canonical receipts only; conflicts/model-only agreement are unverifiable. |
| V3 policy adaptation | judgment-candidate | Benchmark evidence may recommend only a closed conservative action set; deterministic floors forbid weakening, and missing trusted cohorts preserve prior policy. |

## Frontloaded Decisions

1. V1 is observe-only and covers only the authenticated Claude Code Stop-hook path; no channel enforcement or correction ships.
2. The existing `ClaimClauseArbiter`/`CompletionClaimVerifier` pipeline, config namespace, audit surface, and shared intelligence queue are extended; no parallel claim authority is created.
3. V1 supports only the finite deterministic predicate registry in §2.4. Capacity remains high-criticality but unverifiable until a separately converged canonical registry exists.
4. V1 corpus rows are local, scrubbed, proxied for observational pool display, and automation-ineligible. Trusted multi-machine use requires a separately converged Verified Claim Evidence Ledger with a concrete substrate decision.
5. V2 and v3 are design constraints only, not implementation authorization. Their prerequisite substrates and implementation defaults require their own operator-reviewed specs.
6. Calibration and maturation may only increase conservatism or demote a shortcut; they can never lower a criticality floor or reinterpret uncertainty as support.
7. V1 model processing uses only the originating Claude Code installation's existing `claude-code` subscription door for `standard-scrubbed` content, with no fallback; missing policy/door fails closed.
8. V1 ingests T0 labels only. T1 operator adjudication is excluded until a separate authenticated interface converges.
9. Pre-merge delivery proof uses the hermetic in-memory relay. Any real-channel exercise is a post-build operator-run boundary with no destination pre-authorized here.

## Open questions

*(none)*
