---
title: "LLM-Decision Quality Meter — uniform provenance + outcome grading"
slug: "llm-decision-quality-meter"
author: "echo"
---

# LLM-Decision Quality Meter — uniform provenance + outcome grading

**Tracks:** ACT-1193 (uniform full-context provenance), ACT-1194 (outcome grading over time)
**Source audit:** `docs/audits/llm-decision-accountability.md` (CMT-1962, Rounds 1–2)
**Parent standard:** Decision Provenance & Outcome Review (docs/STANDARDS-REGISTRY.md:522 — "### Decision
Provenance & Outcome Review", ratified in PR #1436, merge commit 965a3602c)
**Explicit non-scope:** ACT-1195 (bench prompt-parity) — separate follow-up. ACT-1196 (speaker-election
enforce flip) — separate gate. Graded-case→bench-battery feed + LLM evidence-interpreter activation —
deferred with the standard clause named, tracked ACT-1198 (see FD12). Cross-machine outcome ROUTING —
tracked ACT-1199 (honest-degradation ships in this build; see FD10). Dashboard rendering — tracked
ACT-1197 (API-only this build; see FD13). Operator-reversal detection (an operator manually undoing a
graded action as evidence) — OUT of this build, named residual inside ACT-1198's evidence-source family.
(Build note: the three referenced ACTs are pinned/critical-class in the evolution queue at build time so
`evolutionActions.autoExpiry` can never sweep a deferred constitutional obligation — see §5.6.)

## Problem statement

Instar has a cost meter for its LLM decisions, not a quality meter. The operator's stated goal
(2026-07-10 topic 11960): judge an LLM feature's performance in a scenario over time, to decide
whether a bigger model or a prompt change is warranted. Today that judgment is impossible:

1. **Provenance is not uniform.** `feature_metrics` records cost (tokens/latency), model/framework/door,
   and outcome-CLASS (fired/noop/error/shed) — but no field carries WHAT the decision was made on.
   The mechanism the ratified standard mandates — `JudgmentProvenanceLog` — exists but is wired to
   exactly TWO callsites (SpawnAdmission at server.ts:21699 and DuplicateSessionReconciler at
   server.ts:21914 — recon corrected the audit's "one"), both deterministic floors
   (`fallbackRung:'deterministic'`). Zero LLM gates/sentinels/judges write to it. Ad-hoc per-feature
   JSONL logs (response-review-decisions.jsonl, sentinel-events.jsonl, principal-coherence.jsonl)
   capture inputs inconsistently. A past decision cannot be reliably reconstructed for review.
2. **The highest-consequence decisions are the least logged.** The external-hog KILL decision
   (ExternalHogScanTick.ts:163-223) records no durable facts/verdict/prompt in default wiring. The
   autonomous continue/stop + P13 hard-blocker judges (src/core/CompletionEvaluator.ts:140/226) — which
   gate whether a run keeps burning budget — durably log no judged transcript slice, prompt, or verdict.
3. **Outcome grading is absent.** `verdictId` is a live schema column designed for verdict↔outcome
   correlation; no LLM row ever sets it (both `classifyVerdict` callers — MessageSentinel.ts:711,
   CommitmentSentinel.ts:339 — return `{acted}` only). `annotateOutcome` (JudgmentProvenanceLog.ts:203)
   has zero production callers. There is no periodic grading of any LLM decision against ground truth;
   the only real graders are two bespoke non-LLM loops (CartographerSweep deterministic validation;
   correction-learning recurrence verify).
4. **Nothing ratchets.** A new LLM decision point that skips provenance passes CI clean. The standard
   is honored by prose for LLM decisions — exactly the "documented-only" enforcement class the
   audit-convergence work just eliminated for audits.

## Goals

- G1 (ACT-1193): ONE uniform, opt-in-per-decision-point provenance path such that a gate/sentinel/judge
  decision can later be reconstructed (input context, prompt identity, verdict, model/door) — riding the
  existing JudgmentProvenanceLog storage/redaction/retention posture (with named additive schema fields,
  §5.2), not a second mechanism.
- G2 (ACT-1193): the two named high-stakes callsites (external-hog kill, completion/P13 judges) actually
  wired as the first customers, in this build — not deferred — including the NEW durable hog
  decision-record store their grading requires (§5.3; the review established the previously-assumed
  carrier does not exist).
- G3 (ACT-1194): verdict↔outcome correlation made real: every llm-kind funnel metric row carries the
  router-minted correlation id in `verdict_id`; `annotateOutcome` gains production callers keyed on that
  id so a decision's real-world result is recorded when it becomes known — under write-integrity rules
  (rung derived from a registered rule, precedence, idempotent upsert; §5.4).
- G4 (ACT-1194): a periodic grading surface the operator can read: per decision-point, over a window —
  decisions made, outcomes known, grade distribution (right/wrong/unknown/expired), trend — sufficient
  to answer "does this gate need a bigger model or a prompt change?". That question is attributional and
  spans weeks-to-months, so the durable quality rows carry the settled model/framework/prompt identity
  (content-free columns) at the 90-day horizon (§5.5).
- G5: a structural guard (census/ratchet) so a NEW LLM decision point must declare its provenance
  posture — per DECISION POINT, with volume and content classes, verified `wired` (statically and at
  runtime), closed exemption taxonomy with liveness-checked pending refs, and census debt re-surfaced on
  the read surface (§5.6).

## Non-goals

- No automatic model swaps or prompt changes from grades (the meter informs the operator; routing
  changes stay operator-gated — INSTAR-Bench remains the routing authority).
- No grading-LLM authority over live behavior: grading is observe-only, never gates. Further: the LLM
  evidence-interpreter rung of the grading ladder is DORMANT in this build — no interpreter code ships;
  activation is owned by ACT-1198 with three named preconditions (benched evaluator, FENCE
  instruction-inert quoting, `isComponentInjectionExposed` registration). Grading in this build is
  strictly deterministic/rule-based.
- No operator alerting in this build: the grading surface is a pull read (route), not a watcher — no
  attention items, no notices (so no Self-Heal-Before-Notify escalation surface is introduced).
  A "this gate is performing badly" alert is a possible follow-up that would then carry Standard B
  obligations; it is deliberately out of scope here. The grading JOB likewise never messages: its body
  only curls the deterministic grading endpoint (pinned in the job template so FD5 cannot erode at
  template-authoring time).
- No full-content transcript retention beyond the provenance log's existing machine-local,
  retention-bounded, never-HTTP-served-raw posture — hardened here with content classes (§5.2/§5.6):
  message-carrying decision points store identity (hash/pointer + bounded head), never full bodies.
  (Deliberate reading of the parent rule, stated for the record: "logs the full context it was handed"
  is satisfied by identity + bounded code-derived features under the rule's own containment contract —
  a full-body archive would violate the containment the same standard ratified; converged round 2.)
- Not retrofitting all ~60+ decision points in one PR: the uniform seam + the named high-stakes sites +
  a census that makes the remaining retrofit backlog visible, ratcheted, AND re-surfaced (census debt
  counts on the read surface; pending refs liveness-checked agent-side — no silent skips, no permanent
  pinned backlog).

## Proposed design

### 5.1 The correlation spine — mint once, thread down, hand back up, write once

Recon-established facts (all verified on upstream/main @ 61d24370a):
- EVERY internal LLM call rides `buildIntelligenceProvider` (src/core/intelligenceProviderFactory.ts:146-261);
  every arm returns through `wrapForFunnel` (:139-144) = breaker OUTSIDE, spawn-cap INSIDE. No provider is
  constructed outside the factory (bypass grep: zero hits in src/).
- The ONE metrics chokepoint: `CircuitBreakingIntelligenceProvider.recordMetric` →
  src/core/CircuitBreakingIntelligenceProvider.ts:165 (shed :198, success :242, error :262). Feature key
  = `options?.attribution?.component ?? 'unlabeled'` (:179). Recorder singleton injected once at
  AgentServer.ts:1173.
- `evaluate` returns `Promise<string>` only (types.ts:970); the additive extension pattern is the
  `onUsage`/`onModel`/`classifyVerdict` callbacks (types.ts:1086-1112). `classifyVerdict` has exactly 2
  callers; neither sets `verdictId` → every `kind:'llm'` row writes `verdict_id = NULL` today.
- Failure-swap means ONE logical decision can emit N metric rows (one per attempted framework); only
  `IntelligenceRouter.evaluate()` (src/core/IntelligenceRouter.ts:1066; class at :943) still sees the
  decision as one call. `feature_metrics.verdict_id` (FeatureMetricsLedger.ts:269) is write-only for
  llm-kind rows — no SELECT references it. (Event-kind rows legitimately write semantic labels into the
  same column — recordEvent :449 and callers; see FD8's kind-scoping.)

Design — two distinct layers (they were conflated in the first draft; they are not the same thing):

**Layer A — automatic correlation (zero callsite edits, always-on).**
1. `IntelligenceRouter.evaluate` mints a per-DECISION correlation id UNCONDITIONALLY at entry. The mint
   and its per-call mint marker are attached to a router-INTERNAL clone of the options object — the
   caller-visible object is NEVER mutated, so a reused shared options object can never carry a stale
   marked id into a later call (SEC r3); any inbound correlation-id value on the caller's object is
   ignored. The id threads down through the internal clone; every swap-attempt metric row of the same
   decision stamps the SAME id into `verdict_id`. Id format: collision-resistant
   (`crypto.randomUUID()`-based), NEVER time+seq. Router-minted ids use the `d-` prefix; on
   multi-machine installs a machineId segment is included (`d-<machineId8>-<uuid>`) — machineId8 = the
   first 8 chars of the pool/mesh self machine id (the id `pool.machines[]` resolves), injected at
   AgentServer construction beside the recorder singleton; when no pool machine id exists
   (single-machine install) the segment is omitted. The FD10 forward path reads the owning machine from
   it.
   **One decision row per `router.evaluate()` invocation, by design:** router-INTERNAL retries
   (deferrable backoff, the swap tail) are one decision; caller-level retries or re-invocations above
   the router are DISTINCT decisions, each settling honestly. A component whose one human-visible
   judgment spans multiple `evaluate()` calls (cascaded classifiers, decomposed prompts) declares that
   composition in its census entry (§5.6) — one decision point per call, EACH with its OWN suffixed
   unique component key; the linkage lives ONLY in the census `composition` field's linked
   decision-point ids, never in key sharing (ADV r6 — key sharing would contradict §5.6's uniqueness
   assertion and re-open the very same-key blind spot it closes).
2. Floor: a funnel-wrapped provider used DIRECTLY (router bypassed) reaches the breaker without a
   router mint marker; the breaker treats ANY inbound correlation id as absent unless that per-call mint
   marker is present, and CONSUMES the marker single-use on acceptance (an unmarked or marker-less id is
   discarded — the documented/accidental injection path is closed on every route; hostile same-process
   code is out of threat-model scope), minting locally with the distinct `b-` prefix
   (`b-<machineId8>-<uuid>`; same machineId8 source, injected into the funnel wrapper). Provenance-of-
   mint is thus derivable from the id itself on every metric row — no new metrics column. Honesty note
   (amending the first draft's overclaim): N retries by a router-bypassing caller get N breaker-minted
   ids and read as N decisions — the floor guarantees *no row is uncorrelated*, not that correlation is
   always decision-accurate. Decision-accurate correlation requires the router path; the census (§5.6)
   declares router-bypassing points as `pending` until they route. `b-`-prefixed ids never enter the
   joinMiss→expired mapping (§5.5) — they are known-unenrolled by construction.
3. Minting and `verdict_id` stamping are ALWAYS-ON (not gated by `provenance.uniformSeam`): the id is an
   opaque mint with no decision content — stamping it is a NULL→value change on an existing column whose
   llm-kind population has zero readers. Rationale: correlation data accumulates during the dark soak,
   and rollback semantics stay trivial (§5.7). Single-writer rule for the column, SCOPED TO llm-kind
   rows (FD8): the minted correlation id ALWAYS occupies `verdict_id` on `kind:'llm'` rows; event-kind
   rows keep their existing semantic verdictId use untouched, and every decision-quality join filters
   `kind='llm'` — pinned by a repo lint/test asserting every query touching `verdict_id` is kind-scoped
   (codex r3; the polymorphic column is the accepted tradeoff, the kind-scope discipline is enforced,
   not hoped). A DEDICATED correlation column was considered and rejected deliberately (codex r4): the
   llm-kind population is write-only with zero readers today, the kind-scope lint enforces exactly the
   discipline a new column would buy, and schema churn on the ledger's largest table is not warranted
   for a write-only value. A caller-supplied `classifyVerdict.verdictId` NO LONGER lands in the column — if
   supplied, the seam records it as `callerRef` INSIDE the provenance row's context (the scrubbed,
   clamped path — deliberately not a new top-level served field), and the types.ts:1112 doc is updated
   in the same PR.

**Layer B — provenance enrollment (per-callsite contract, opt-in, gated).**
4. An enrolling callsite adds an additive `options.provenance` block. The MINIMUM integration contract a
   callsite owes (this is real per-callsite work — enrollment is NOT zero-edit):
   - `decisionPoint` (stable id, IMPORTED from the census module — §5.6's typed registration; the
     settlement write additionally validates decisionPoint ∈ census and counts unknowns),
   - `context` (built via its content class's envelope BUILDER, §5.2 — callsites do not hand-roll
     envelopes),
   - `optionsPresented` (the bounded action space shown to the model — static, code-authored,
     enum-like labels; charset/length-clamped per §5.2),
   - `promptId` (prompt identity — a hash/version tag; charset/length-clamped per §5.2),
   - optionally `onCorrelationId?: (id: string) => void` — fired by the ROUTER synchronously at MINT
     (entry, before the first attempt), exactly once per logical decision, INCLUDING decisions that
     subsequently throw — never after the returned promise settles. The router invokes the callback
     inside try/catch (a throwing callback is caught, counted, and never propagates — the decision
     call is never failed by its audit trail, matching the documented `classifyVerdict` containment
     contract, types.ts:1104-1110; SEC r5). The callsite persists the id in its
     OWN durable state for later outcome annotation (§5.3/§5.4). There is deliberately NO shared
     in-memory pending-outcome registry — an id nobody persists simply ages out as `unknown` (the
     unbounded-map leak class is precluded by design). (A router-bypassed call never fires the callback —
     the breaker strips the provenance block; such points are census-`pending` by rule.)
5. **Write-once rule (FD7):** the provenance decision row is written by the ROUTER at decision
   SETTLEMENT. Settlement is EVERY `evaluate()` exit — ladder success, ladder-final failure, the
   `!cfg` early return, the provider-unavailable degrade arm, the `enforcedNoRoute` throw, the
   `RouterFailClosedError` rethrow, and the fallback-`'none'` unavailable throw — so an enrolled
   decision always yields exactly ONE row no matter which exit fires (the degrade arm fires on every
   binary-missing agent; it is not an edge case). The row combines the caller's provenance block,
   the settled attempt's classified verdict (from `classifyVerdict` where implemented; else
   `decision:'unclassified'` — the raw-response head goes into `context`, scrubbed and clamped to 300
   chars, NEVER into the served `decision` field), the settled attempt's usage/model/door, the
   correlation id, and `mintedBy:'router'`. **Per-attempt capture scoping:** usage/model/door are
   captured via fresh per-attempt wrapper closures (composed over the caller's callbacks and the
   existing nonGatingSwap compose, IntelligenceRouter.ts:1263-1272) — only the attempt whose promise the
   router actually returned contributes to the row; callbacks that fire on rejected attempts (the
   documented `onUsage`-fires-including-rejects contract) or from `withSwapTimeout`-abandoned attempts
   after settlement are discarded. Attempt-level detail (which frameworks errored/shed) stays in the N
   metric rows, joinable on the id. An errored-settlement decision writes one row with
   `decision:'<errored>'` + the error class in context — so failure-swap-ladder quality is itself
   gradeable (FD1's own rationale), without N phantom decisions.
6. The seam CONSUMES `options.provenance` — the router strips it before per-attempt option spreads, AND
   the funnel wrapper (`CircuitBreakingIntelligenceProvider`) ALSO strips it before delegating to
   `inner.evaluate` (a router-bypassed call that carries the block gets it stripped-and-counted at the
   breaker — the structural cannot-leak claim holds on BOTH paths, not just the router's; SEC/INT r2).
7. Provenance write failures are catch-logged (the log's own observability-only failure semantics);
   the decision call is NEVER failed or delayed by its audit trail.

### 5.2 The decision-context envelope — additive fields, serve-discipline, content classes

`DecisionRowInput`/`ProvenanceRow` (JudgmentProvenanceLog.ts:51-97) are the envelope, EXTENDED with
named additive fields (correcting the first draft's "no new schema" — the join the spec stands on
requires them): `correlationId` (the §5.1 mint; also becomes `annotateOutcome`'s accepted key),
`promptId?`, `contentClass`, `mintedBy`; outcome rows additionally carry `grade` (FD3 enum, validated
at write), `gradedBy`, `ruleId` (§5.4). (`callerRef` lives inside `context`, §5.1.3 — not a top-level
field.) All existing invariants ride along unchanged: write-time credential scrub to `contextRedacted`
(2000-char clamp), `contextFull` machine-local only (0700/0600, gitignored, backup-excluded,
never-HTTP-served via NEVER_SERVED_PREFIXES — with one honest correction, SEC r4: the EXISTING
`'state/judgment-provenance/'` entry is empirically a production NO-OP today, because the prefix list
matches projectDir-rooted paths while the log lives under `<projectDir>/.instar/state/` — so
`contextFull` day-files are currently reachable by the dashboard file editor. That is a live
pre-existing defect this build fixes in the same PR, §5.3), 64KB row clamp truncate+flag, 14-day
retention, async buffered appends, deterministic FNV-1a sampling, redaction-by-field-omission at
`readRedacted` (:314).
The redaction contract stays a code invariant, never config (types.ts:4167-4172 doc pin — that doc
comment is updated in the same PR when `uniformSeam`/`quality` nest under the `provenance` block).

New serve-discipline invariants (these are code invariants with semantic tests, §Testing):
- **The HTTP-served `decision` field is bounded**: it only ever carries a classified verdict from the
  callsite's declared `optionsPresented` space, an error class, or the fixed marker `'unclassified'`.
  Raw model output NEVER lands in `decision`, `optionsPresented`, or `floor` (the unscrubbed served
  fields) — raw heads live in `context` (scrubbed, 300-char clamp).
- **`optionsPresented` entries, every written `verdict_class` value, AND `promptId` are static,
  code-authored, enum-like labels** — charset/length-clamped at the settlement write
  (`^[a-zA-Z0-9_-]{1,64}$`); a violating value is replaced with `'unclassified'` (or, for promptId, a
  fixed `'unlabeled-prompt'` marker) and counted. Runtime data interpolated into a caller-authored
  label cannot reopen the raw-content channel through the served fields or the "content-free" quality
  table — promptId is the one attribution column a CALLSITE authors, so it pays the same clamp as the
  other caller-authored served values (SEC r3; model/framework are code-derived and exempt).
- **Content classes** (declared per decision point in the census, §5.6), each with a code-provided
  **envelope builder** so callsites cannot hand-roll their context shape:
  - `metadata` — context is code-authored facts (ids, hashes, booleans, numbers, enums). The default.
  - `content-bearing` — the decision judges user/peer/process-authored text (tone gate, sentinels,
    response-review, completion transcripts, hog argv). Context MUST enter as identity + bounded
    features: hashes/pointers (e.g. transcript-slice hash + bounds), code-derived feature summaries
    (preferred over raw heads for high-stakes points — features carry the salient "why" that a
    truncated head can lose), and at most a 300-char scrubbed head. Full bodies NEVER enter the
    provenance row — the provenance store must not become a second transcript/message archive; the
    store's containment posture was ratified for admission metadata, and this rule is what keeps the
    retrofit from silently changing what `contextRedacted` exposes over HTTP.
  - Concretely for the first customers: external-hog context carries commandHash/ledgerKey/classId,
    process name, floor booleans, CPU numbers, AND the code-derived process identity tuples §5.3/§5.4
    require (the candidate's own pid + start-time; the named parent's pid + start-time where derivable
    — numbers, not attacker text) — raw argv is EXCLUDED (hashed; the floor needs argv, the provenance
    row does not). Completion-judge context carries the transcript-slice IDENTITY (hash + bounds) + the
    StopSignals corroboration block, never transcript text.
- **Outcome evidence notes are clamped at annotate time** (≤500 chars) with pointer discipline (ids,
  hashes, enum reasons — never message bodies); FD3's "nuance lives in the outcome payload" means
  structured fields + pointers, not prose dumps. `evidence_note` is NOT part of any `/decision-quality`
  payload (the route serves aggregates and counters only); the only HTTP path an outcome payload
  crosses is the existing redacted `/judgment-provenance` read (scrubbed at write).
- **Dry-run logging is metadata-only**: the dryRun stage (§5.7) logs component, decisionPoint, byte
  sizes, volume-class disposition — NEVER context content into server.log (that would violate the very
  posture the 0700/0600 store exists to contain). While `dryRun` holds, the seam suppresses BOTH the
  provenance JSONL row AND the SQLite quality/outcome writes — would-write logs are the only output
  (the safe reading; DC r3).

### 5.3 High-stakes first customers — operational wiring (anchors verified)

Both customers follow ONE shape: the router-settlement row records the LLM verdict; the ENACTED
disposition — which is only knowable after the deterministic actor applies floors/breakers/governors —
is recorded as an immediate `annotateOutcome` by that actor (rung `self-report`, derived per §5.4.2);
later ground truth arrives as further outcome annotations under §5.4's precedence. No double
decision-rows. **Grades attribute to the LLM VERDICT, not the pipeline:** every evidence rule
conditions on the enacted disposition, so a decision whose enactment was vetoed/held by a floor,
breaker, or governor is never graded as if the classifier's recommendation had been executed (codex-r2;
the concrete predicates below implement this).

- **External-hog kill/leave** — decision loop at ExternalHogScanTick.ts:163-223. Enrollment: the
  classifier call carries `options.provenance` (component `ExternalHogClassifier`, contentClass
  `content-bearing` with the §5.2 context fields, volumeClass `full` — genuinely rare + high-stakes).
  **NEW DELIVERABLE — the durable hog decision store** (the review established the carrier this grading
  needs does not exist: the P19 kill-ledger state is in-memory-only and re-initialized empty at
  construction (ExternalHogSentinel.ts:117), holds kill records only (leave-alives write nothing,
  ExternalHogScanTick.ts:217), and its retention is a hardcoded 1h (commands/server.ts:18000) — shorter
  than the 6h evidence window): **`<stateDir>/state/external-hog-decisions.json`** — under the
  `.instar/state/` runtime-state subdir (rides the existing gitignore; the same subdir the JP log uses —
  a root-of-`.instar` placement would churn an unignored file in a git-synced agent home and leak
  machine-specific pids across machines; INT r3). At-rest posture, explicit: 0600 via atomic
  tmp+fsync+rename writes with fail-closed reads (the ExternalHogArmStore posture,
  ExternalHogArmStore.ts:89-101), backup-excluded BY ACTIVE UNCONDITIONAL ENTRY — the store joins
  BOTH always-on mechanisms in this same PR: `BLOCKED_PATH_PREFIXES` as the stateDir-relative literal
  `'state/external-hog-decisions.json'` (BackupManager.ts:30-52 — the exact
  `'state/pr-hand-leases.json'` per-machine-state precedent, whose comment pins "Unconditional (NOT
  the remediation-gated F-7 list); stateDir-relative prefixes, matching how includeFiles entries
  resolve") AND `NEVER_BACKUP_PATH_SEGMENTS` as the filename segment `'external-hog-decisions.json'`
  (:88-90 — the mechanism that ACTUALLY excludes the JP dir; four r6 reviewers independently caught
  the r5 fold's mis-pin of the remediation-gated `REMEDIATION_EXCLUDED_PATH_PREFIXES` list here —
  flag-gated inert on default agents, the SEC4-1 no-op-guard class reproduced in the backup layer).
  NOT by allowlist-absence alone, which an operator-added `includeFiles` `state/` glob would defeat
  (SEC/INT r5 — a restored backup on another machine would reintroduce stale machine-specific pid
  tuples the respawn predicate keys on). Entry-level checks alone do NOT close that glob threat: every
  deny list is consulted against the includeFiles ENTRY string only, and createSnapshot's
  directory-copy branch (:311-328) copies a directory entry's direct file children with no per-file
  re-check (SEC r6 — the JP dir survives only incidentally, as a subdirectory under non-recursive
  copy) — so this PR ALSO re-applies the blocked/never-backup checks to `path.join(entry, file)`
  inside that loop, closing the glob threat for real and fixing the same latent bypass for the
  existing per-machine-state siblings (pr-hand-leases, self-action-governor — pre-existing exposure
  tracked ACT-1201). The per-file re-check is the pinned INVARIANT (ADV r6): the JP dir's current
  safety under a `state/` glob is an ACCIDENT of the non-recursive copy, and a future recursive-copy
  enhancement to BackupManager would silently re-expose both stores without it — and the path is
  added to `NEVER_SERVED_PREFIXES`
  as the PROJECTDIR-RELATIVE literal `'.instar/state/external-hog-decisions.json'` (SEC r4 — the
  prefix list matches projectDir-rooted paths while BackupManager prefixes are stateDir-relative; the
  root divergence is the trap: a `'state/...'` literal is a production no-op, which is exactly what
  the existing `'state/judgment-provenance/'` entry is today — empirically verified,
  `isNeverServed('.instar/state/judgment-provenance/x')` → false, its unit test having gone green on a
  layout production never produces. That existing JP entry is dual-rooted/fixed in this same PR, and
  the serve-discipline tests pin the PRODUCTION layout, §Testing) — the store is grading GROUND TRUTH,
  and the dashboard file editor must not be able to rewrite it (serve-deny implies edit-deny; SEC r3).
  Contents are content-free (hashes, pids, timestamps, enums).
  Per-ledgerKey the store holds `{ verdict (classifier), enacted, correlationId, atMs, targetTuple
  (the candidate's OWN pid + start-time — the spoof-proof identity §5.4's predicates key on),
  ownerTuple — recorded MEMBER-WISE (ADV r4): `parentPid` is ALWAYS recorded on ENACTED kills
  (`killed`/`sigterm-exited` — and a fortiori in-hand for every floorPermitted kill, including
  watch-only `would-kill` enactments (ADV r6 wording precision: permitted ≠ enacted during the soak);
  ADV r5 precision: a
  floor-VETOED kill verdict whose veto came from a null parse legitimately has no parentPid, so the
  store write must not hard-assert `verdict==='kill' ⇒ parentPid` — the always-in-hand guarantee is
  that `parseParentPid` succeeded for every PERMITTED kill by construction, FactBuilder:74 vetoes a
  null parse), while `parentStartTime` is recorded where derivable and absent in the dominant
  orphan-kill case (no live parent to stamp; §5.4's ordering test keys on the recorded parent PID plus
  the killed child's own start-time, so the rule stays evaluable either way), floorPermitted,
  commandHash }` for BOTH kill and leave
  verdicts. **`enacted` covers the sentinel's REAL disposition space** (LES r3 — verified against
  ExternalHogScanTick.ts:160-227): `killed | sigterm-exited | would-kill | deferred | aborted |
  alert-only-model-spared | alert-only-floor-veto | alert-only-breaker-held | alert-only-governor-hold |
  decider-unavailable`. Only `killed`/`sigterm-exited` enter the kill-grading rules;
  `would-kill`/`deferred`/`aborted`/`decider-unavailable` decisions age out `unknown` — and stated
  plainly: during the watch-only dev soak EVERY kill verdict enacts as `would-kill`, so kill-grade
  volume arrives only after a PIN-arm (the soak still exercises the store, the leave rules, and the
  enacted self-reports).
  **Retention:** pruned on write at `max(evidenceWindowMs + gradingSlackMs, killLedgerBreakerWindowMs)`
  — the grading slack (default 2h, ≥ 2× the grading job's default hourly cadence) closes the race where
  an entry becomes gradeable at exactly the age it becomes prunable (DC r3); the evidence window is the
  config knob and the store's retention DERIVES from it, so tuning `evidenceWindowHours` can never
  silently outrun the carrier. Hydrated at sentinel construction. The in-memory P19 kill-breaker ledger
  is left untouched (the brake is not coupled to the new file).
  **Slot semantics:** per ledgerKey the store holds the LATEST decision PLUS any in-window kill decision
  (a kill's evidence slot is never evicted by later same-key decisions before its window closes — a
  same-commandHash flood cannot force a premature `unknown` on a kill; ADV r3). **Grade-on-supersede:**
  writing a new decision for ledgerKey K first applies the evidence rules against the OUTGOING record
  (the supersede event IS the positive-evidence event for recurrence rules — within-tick ordering is
  pinned, not assumed; ADV/DC r3), then replaces the slot; a superseded record whose rules yield nothing
  ages out as `unknown` (stated, not silent). Oscillation honesty: every enrolled decision still has its
  own `decision_quality` row regardless of slot eviction (§5.5), so repeated flip-flopping on one
  ledgerKey remains visible in the meter even where the store retains only the carrier slots.
  Positive-evidence grading (respawn / re-flag) runs in the NEXT scan ticks + at grade-on-supersede;
  window-close grading (`*-right-v1` rules) runs in the grading job reading THIS store.
- **Completion + P13 judges** — src/core/CompletionEvaluator.ts: `evaluate()` :140 (component
  `CompletionEvaluator`) and `evaluateStopRationale()` :226 (component `CompletionEvaluator/P13`); both
  volumeClass `full`, contentClass `content-bearing` (transcript-slice identity only). The correlation
  id is persisted in the autonomous run-state file (the AutonomousRunStore state the realcheck path
  already reads); the realcheck completion path annotates: `met:true` + realcheck pass → `right`;
  `met:true` + realcheck fail → `wrong`; verdicts with no realcheck configured → `unknown` (honest).
  Operator "keep going" correction as evidence: OUT this build (named residual, ACT-1198
  evidence-source family).

### 5.4 Outcome annotation — write-integrity, evidence rules, honest keys

`annotateOutcome` today is an unauthenticated append-many API (no existence/component check, no dedupe,
no enum validation, unlimited re-annotation — JudgmentProvenanceLog.ts:203-216). Making it real requires
write-integrity rules, or the meter is gameable by construction:

1. **Keying:** `annotateOutcome` accepts the CORRELATION id (additive; the legacy row-id path remains
   for the two existing deterministic callsites). Outcome rows join decisions on `correlationId`.
2. **Rung is DERIVED, never caller-supplied:** a code-defined **ruleId→rung registry** — co-located
   with PROVENANCE_COVERAGE in src/data (typed, single source; imported by the annotate chokepoint and
   the grading endpoint; the ratchet fixtures pin its enum — INT r3) — maps every registered evidence
   rule to its rung (`deterministic-ground-truth` | `recurrence` | `llm-interpreter` (dormant) |
   `self-report`) AND its **evidence-strength class** (`deterministic-proof` | `negative-evidence` |
   `recurrence-proxy` | `self-report` — codex r3: the read surface splits proof-like from heuristic
   grades so aggregates cannot imply stronger correctness than the evidence supports). An annotation's
   `gradedBy` carries component + ruleId; the rung comes from the registry — an annotation claiming a
   ruleId whose registered rung disagrees, or an unregistered ruleId, is REJECTED and counted (the same
   closure move as the grade-enum validation). **Registry rows additionally carry the rule's OWNING
   component** (ADV r5 — the last trusted label in this section): the annotate chokepoint rejects an
   annotation whose `gradedBy.component` is not the ruleId's registered owner, so a confused in-process
   annotator cannot inherit another rule's rung/precedence by claiming its id. §5.3's
   enacted-disposition annotations use registered `self-report`-rung rules by construction.
3. **Precedence (conflict resolution):** `deterministic-ground-truth` > `recurrence` > `llm-interpreter`
   > `self-report`. A self-reported outcome NEVER overrides an independent grader. **Within-rung
   conflicts** (two different components at the same rung) resolve conservatively: `wrong` > `unknown` >
   `right` at equal rung. The read surface counts each decision exactly ONCE under its winning grade.
4. **Idempotency:** the write key is `correlationId × gradedBy` — a re-run UPSERTS (supersedes its own
   prior grade), never multiplies. Grade enum (`right|wrong|unknown` per FD3) is validated at write;
   invalid → rejected, counted, catch-logged.
5. **Evidence rules are precise predicates with immutable, versioned ids** (a predicate change — or a
   change to a rule PARAMETER like the evidence window — mints a new ruleId (`-v2`), never mutates `-v1`
   in place; each outcome row additionally records the effective `windowMs` in its structured evidence,
   so grade-by-rule aggregates can never silently mix semantics; DC r3):
   - `hog-respawn-wrong-v1` (evidence-strength `deterministic-proof`): a kill is graded `wrong` ONLY IF,
     within the bounded window (default 6h), a same-commandHash CANDIDATE respawns AND the kill-time
     ordering test re-runs TRUE at evidence time — a currently-alive process sits at the killed
     process's recorded parent pid with a start-time ≤ the killed child's recorded start-time
     (`targetTuple`), proving the orphan determination was false. Un-orderable start times → `unknown`.
     This predicate is evaluable in BOTH kill-permit cases (parent-absent — where `ownerTuple.parentPid`
     IS recorded but no `parentStartTime` could be — and pid-reused), and start-times cannot be forged old, so it is spoof-proof in both
     directions (ADV r3; a respawn under a genuinely new owner — the operator reopened the editor —
     fails the ordering test and grades `unknown`, never `wrong`).
   - `hog-sustained-right-v1` (evidence-strength `negative-evidence`): a kill whose commandHash does NOT
     re-flag as a CANDIDATE within the window, where the floor facts recorded the owner dead at kill
     time, grades `right` at window close (from the durable store). **Sensor bound, stated:** candidate
     visibility is sustained-CPU processes only — a quiet respawn is invisible to this rule, so
     `right`-grades from it carry negative-evidence strength, never proof (ADV r3; the strength class
     on the read surface is what keeps this honest).
   - `hog-leave-recurrence-v1` (evidence-strength `recurrence-proxy`): applies ONLY to decisions where
     `verdict === 'leave'` AND `enacted === 'alert-only-model-spared'` (a kill-verdict held by the
     breaker/governor/floor is NEVER graded against the classifier — breaker-held re-flags are the
     brake's normal operation) AND `floorPermitted` was true at decision time (a spare of an owner-alive
     hog — the user's live editor compiling — is correct behavior with no gradeable counterfactual).
     Within those preconditions: the SAME PROCESS (matching `targetTuple` pid + start-time — the
     candidate signature already computed at ExternalHogScanTick.ts:122/150) re-flagging as a sustained
     hog within the window grades the leave `wrong`; a DIFFERENT process with the same commandHash
     grades `unknown` (a lookalike spawned by any same-uid process is not a counterfactual for the
     specific process the classifier spared — and cannot fabricate a `wrong`; ADV r3). No recurrence
     grades `right` at window close (negative-evidence strength applies to that half).
   - `completion-realcheck-v1` (evidence-strength `deterministic-proof`): as §5.3. No realcheck →
     `unknown`, never guessed.
   - Every grade row carries its `ruleId`; `GET /decision-quality` exposes a grade-by-rule breakdown so
     a coincidence-prone rule is auditable BEFORE anyone acts on the aggregate number.
6. **Unknown is re-checkable, bounded:** the grading job may re-evaluate `unknown` decisions when new
   evidence lands, with per-decision backoff and a terminal give-up at quality-row retention expiry —
   the terminal state is `expired` (ONE name for the aged-out event; there is no "final unknown").
   No infinite re-grading (P19; the sustained-failure test is enumerated in §Testing).
7. **Cross-machine honesty (FD10):** annotation writes to the LOCAL substrate. A ground truth that
   lands on a different machine than the decision row (autonomous run moved mid-run) produces an orphan
   outcome row; the substrate counts these (`orphanOutcomes`) and the route reports the counter — the
   loss is visible, never silent. The id's machineId segment (§5.1) is the structure the ACT-1199
   routing follow-up needs; routing itself is NOT in this build.

### 5.5 The quality substrate + read surface + grading job

**The substrate:** the route NEVER scans provenance JSONL (the EvolutionManager-doom-loop lesson is a
hard constraint on EVERY reader this spec adds). Four additive SQLite tables live beside
`feature_metrics` — **owned by FeatureMetricsLedger** (its SCHEMA array + idempotent
CREATE-TABLE-IF-NOT-EXISTS + ADDED_COLUMNS conventions, src/monitoring/FeatureMetricsLedger.ts:255-296);
the router seam and JudgmentProvenanceLog reach them through a **recorder-style module singleton**
(`setDecisionQualityRecorder`, the setFeatureMetricsRecorder pattern injected at AgentServer
construction, AgentServer.ts:1173 — a constructor-option would reach only the one shared router; the
singleton reaches any instance):

- `decision_quality` — one row per settled ENROLLED decision, written by the router-settlement path:
  `correlation_id` (PK), `feature`, `decision_point`, `ts`, `verdict_class` (the bounded §5.2 value),
  `minted_by`, `volume_class`, `content_class`, `machine_id`, and the attribution columns the operator
  question needs at the long horizon: `model`, `framework`, `prompt_id` (all clamped content-free
  labels). ~250 bytes. **Written for EVERY enrolled settled decision REGARDLESS of volume class** — the
  volume valve (§5.6) governs the expensive provenance JSONL row ONLY, so outcome rows always have
  parents, counts are complete, and `onCorrelationId`'s contract has no dropped-parent corner (r2
  reconciliation; worst case ~4k rows/day ≈ ~1MB/day — trivial). Index: `(decision_point, ts)` (a
  covering `(decision_point, ts, correlation_id)` is the build-time refinement). Re-check backoff state
  (`recheck_count`, `next_recheck_ts`) rides this table via ADDED_COLUMNS (DC r3).
- `decision_outcomes` — upserted by `annotateOutcome`: `correlation_id`, `grade`, `graded_by`,
  `rule_id`, `evidence_note` (≤500 scrubbed chars; never served by /decision-quality), `ts`;
  UNIQUE(`correlation_id`,`graded_by`); ts-indexed. Structured evidence records effective rule
  parameters (`windowMs`) per §5.4.5.
- `decision_quality_rollup` — content-free daily aggregate: `decision_point` × `day` (the DECISION's
  UTC day — the spend_token_rollup 'YYYY-MM-DD'-UTC convention — looked up from `decision_quality`,
  whose 90d retention exceeds any legal late evidence) × right/wrong/unknown counts + the orphan/
  joinMiss/droppedByBudget counters. **Mutation semantics (grades are MUTABLE facts — unlike the
  spend rollup's immutable increments):** each outcome upsert reads the decision's PRIOR winning grade
  and decrements/increments the decision-day bucket accordingly (recompute-affected-bucket from
  `decision_quality ⋈ decision_outcomes` is the reference implementation — bounded, self-healing);
  a bounded boot reconcile mirrors the spend prior art (`reconcileSpendRollup`,
  src/monitoring/FeatureMetricsLedger.ts:372-375 — which is BOOT-ONLY; the PERIODIC arm of the quality
  reconcile explicitly rides the existing AgentServer boot+6h unref'd prune timer, window 30d mirroring
  spend; INT/DC r3) so a crash between the outcome upsert and the rollup update self-repairs.
  Alternative considered and rejected (codex r6): an append-only outcome-event log with a
  materialized/recompute-on-read rollup — rejected because grades are LOW-volume mutable facts over
  already-indexed keys (the outcomes table IS the append-ish record; upsert-by-idempotency-key is
  what bounds it), the recompute-affected-bucket + bounded-reconcile pair already delivers the
  self-healing an event log would buy, and a second bespoke event store would add machinery without
  adding a guarantee.
  **`expired` is NOT a rollup column and NOT a writable grade** — it is derived at READ: decisions
  minus Σgrades for buckets older than the raw retentions, plus the expired share of joinMiss.
- `decision_grading_cursor` — the grading job's durable per-decision-point cursor
  (`decision_point` PK → last `ts` + `correlation_id` compound boundary; DC r3 — the cursor is a table,
  not an implicit "fourth thing").

**Retention and prune (named deliverables — an unnamed prune on this host is an unbounded store):**
`provenance.quality.decisionRetentionDays` (default 90) governs `decision_quality` +
`decision_outcomes`; `provenance.quality.rollupRetentionDays` (default 90) governs the rollup. Each
table gets its own batched prune method (the host's per-table pattern: `pruneOlderThan` :786 /
`pruneSpendRollup` :815, PRUNE_BATCH-bounded), driven by the existing AgentServer boot + 6h unref'd
prune timer (AgentServer.ts:1457-1464; anchors re-grounded at build time — INT r5 noted ±2-line
drift on three cites, mechanisms verified real) — **whose construction condition gains a quality arm** (today it
is created only under `retentionDays > 0 || routingSpendOn`; without the arm, an agent with
featureMetrics retention 0 would never prune the quality tables — INT/LES r3).

**Read honesty:** provenance rows die at 14d, `feature_metrics` at ~30d, quality rows at 90d. The read
surface distinguishes `unknown` (ungraded, parent row present) from `expired` (aged out) from
`not-written` (a verdict_id with no decision_quality parent that is NOT expiry: `b-`-prefixed breaker
mints AND `d-`-minted calls from not-yet-enrolled router callers — the larger population during rollout
— both reported as census-pending activity, never as `expired`). Dangling pointers never error; an
orphan outcome is never counted as a graded decision.

**Read surface (FD2):** `GET /decision-quality` — per decision-point over a window (`?sinceHours`, the
/metrics/features convention): decisions, outcomes-known ratio, grade distribution
(right/wrong/unknown/expired), grade-by-rule breakdown, grade-by-rung AND grade-by-evidence-strength
breakdowns (proof-like vs heuristic grades are never conflated in aggregates — codex r3; the DEFAULT
aggregate view groups by evidence strength FIRST, so the headline number a reader sees is
strength-segmented, never a blended rate — codex r4; and any aggregate whose graded-decision count is
below a minimum sample threshold — `provenance.quality.minSampleForRates`, default 20 — is served with
an explicit `insufficient-evidence: true` marker beside the raw counts, so three data points can never
read as an actionable rate — codex r5), per-point
volume/sampling class (so mixed-class ratios aren't misread), attribution columns (model/framework/
prompt_id) on each row, census debt counts incl. `pending-ref-dead` flags (§5.6),
`orphanOutcomes`/`joinMiss`/`droppedByBudget` counters, the ANNOTATION-REJECTION counters by class
(enum-invalid / rung-mismatch / owner-mismatch / unknown-decisionPoint — ADV r6: rejections that are
counted-but-unserved would let a renamed grading component's self-report annotations be silently
rejected wholesale, starving the enacted-disposition preconditions with the only trace in catch-logs;
a zeroed grading rung must be visible where the operator reads), and the wired-but-silent + exempt-but-active
flags (§5.6 — runtime coverage is keyed on `decision_point` via `decision_quality` rows; the 1:1
component-key convention is only the bridge that locates metric-call counts). Pure indexed SQLite reads;
Bearer-authed (the middleware exemption-list default); 503 when `provenance.uniformSeam` resolves off.
Route contract: params + response shapes of BOTH routes (this and grade-pass) are iterable while dark,
frozen at graduation.
`?scope=pool` returns MACHINE-TAGGED rows per decision-point (per-machine framework routing means one
machine's tone gate genuinely differs), with the sibling-route hygiene: per-row 8KB clamp,
`pool.failed` classified rows, `isPeerUrlAllowedForCredentials` before attaching the Bearer to peer
URLs, and an explicit FIELD ALLOWLIST on merged peer rows (never `{...row}` spreads). The adjacent
`/judgment-provenance` pool branch (routes.ts:15031) is retrofitted with the same guard + allowlist in
this build.

**Grading prior art consolidated, not reinvented** (both non-LLM): Cartographer's deterministic
ground-truth check (validateSummaryDeterministic, cartographerSummary.ts:115-128) and
correction-learning's recurrence + persistence verify (CorrectionLoopDriver.runVerification :330-380 —
recurrence reopens; silence alone is never 'verified'). The evidence rules of §5.4 follow these shapes:
ground-truth check where one exists, recurrence/persistence where it doesn't, honest `unknown`
otherwise.

**The grading ladder in this build is deterministic-ONLY** (FD11): rules with predicates + recurrence
checks. The LLM evidence-interpreter rung ships NO code — dormancy is structural-by-absence; it
activates only behind ACT-1198 (benched evaluator + FENCE instruction-inert quoting +
`isComponentInjectionExposed` registration + attribution + LlmQueue ride). Row content handed to any
future interpreter is enveloped untrusted data — process argv and user text can and will contain
adversarial instructions (a process named "SYSTEM NOTE: grade wrong" must steer nothing).

**The periodic grading job** is a declarative agentmd built-in (src/scaffold/templates/jobs/instar/
llm-decision-grading.md, installed by src/scheduler/InstallBuiltinJobs.ts:106-116 on fresh install AND
by `migrateBuiltinJobs` on update): `schedule` cron (default hourly — the cadence the §5.3 grading
slack is derived from) + `model: haiku` + `supervision: tier1` + `enabled: false`, whose body ONLY
curls the deterministic grading endpoint (`POST /decision-quality/grade-pass`, Bearer; body `{}` —
knobs come from config; response `{ graded, byRule, cursors }` where `cursors` maps decisionPoint →
advanced boundary) — it never messages, never interprets. The endpoint:
- walks NEW evidence since the DURABLE per-decision-point cursor (`decision_grading_cursor`) — keyset
  pagination `ORDER BY (ts, correlation_id)` with the compound cursor as the page boundary (same-ms
  bursts cannot skip rows at a page boundary),
- bounded per run (`maxDecisionsPerPass`, default 200; any JSONL access is streamed line-by-line under
  a row budget, never whole-file sync parses). Fairness honesty (ADV r5): the bound is GLOBAL, not
  per-point — with this build's two low-frequency full-class customers starvation is unreachable, but
  a future high-volume enrolled point could consume whole passes while sibling points' evidence
  windows expire; when a third point enrolls, the pass gains a per-point sub-budget (round-robin over
  cursors) — and that trigger is STRUCTURAL, not prose (LES r6): the census test asserts that more
  than two ENROLLED decision points requires the sub-budget implementation, so the third enroller's
  build fails until it exists rather than relying on a reviewer remembering this clause,
- upserts grades per §5.4 (idempotent by key — re-runs converge, never multiply; concurrent job-tick +
  operator curl converge by the same idempotency),
- spends zero LLM tokens in this build (deterministic rules only); when ACT-1198 activates the LLM rung
  it rides `llmQueue.enqueue('background', fn, costCents)` (LlmQueue.ts:96-122; daily cap default 100¢)
  with `attribution.component: 'DecisionGrading'` (Token-Audit Completeness).

### 5.6 The census/ratchet — no silent skips, no permanent backlog (G5)

Same declare-or-fail pattern as LLM_BENCH_COVERAGE (llmBenchCoverage.ts precedent), tightened per
review: a `PROVENANCE_COVERAGE` declaration **per DECISION POINT** (a component may hold several
distinct decision points with different prompts/outcomes), each entry:

```
{ decisionPoint, component, status, volumeClass, contentClass, composition? }
  status:       wired | pending:<ACT-id> | exempt:<taxonomy-key>
  volumeClass:  full | sampled:<rate> | budget:<rows/day>
  contentClass: metadata | content-bearing
  composition:  single (default) | multi-call:<linked decision-point ids>   (§5.1.1 boundary rule)
```

Decision-point ids are exported from this census module and IMPORTED by enrolling callsites (typed
registration — the census is the single source of truth; a decision point that exists only as a string
literal at a callsite fails the ratchet; the settlement write also validates decisionPoint ∈ census at
runtime and counts unknowns).

- **Enrollment key convention:** each enrolled decision point uses a 1:1 `attribution.component` key
  (the existing `CompletionEvaluator` vs `CompletionEvaluator/P13` suffix pattern) so per-point metric
  counts exist and the runtime flags below compare like with like. **The 1:1 convention is a census-test
  ASSERTION, not prose** (ADV r5): each wired decision point's component key must be UNIQUE across
  census entries — so a second judgment added inside an already-declared component that reuses the
  sibling's key becomes lint-visible the moment the new point is declared or enrolls, instead of hiding
  under the sibling's coverage. Scope precision (ADV r6): uniqueness binds WIRED keys plus
  `deterministic-only`-exempt keys (a deterministic-only entry sharing a key with an llm-calling
  sibling would false-flag exempt-but-active — cheap to include, so it is); multi-call compositions
  get one unique suffixed key PER point with linkage only via the `composition` field (§5.1.1). Honest bound, stated: an UNENROLLED, UNDECLARED new point that reuses a
  declared sibling's component key is caught at code review, not by the ratchet — the discovery chain
  is component-keyed (the bench precedent's granularity), and this is the named residual of that
  inheritance.
- **Closed exemption taxonomy** (an exemption is a classification, not an essay):
  `deterministic-only` (no LLM verdict at this point) | `no-decision-content` (nothing reconstructable
  beyond what feature_metrics already records) | `operator-ratified:<resolvable-ref>`. Free-text
  exemptions are refused by the ratchet. **The exempt baseline is pinned shrink-only, like pending**
  (ADV r5 — the bench precedent pins BOTH baselines; `no-decision-content` is the soft spot since it
  is deliberately excluded from exempt-but-active, so review is its only runtime guard): adding or
  re-classifying an exempt entry is a reviewed baseline change.
- **`pending:<ACT>` — the honest two-layer check** (the evolution queue is AGENT-RUNTIME state,
  unreachable from repo CI; three reviewers independently established the r3 draft's "fails CI" was
  unimplementable as written): **CI (static, hermetic):** format-validated ACT refs, the pinned
  shrink-only baseline, ≥40-char argued reasons — and re-pointing a pending entry to a different ACT is
  a reviewed baseline change (shrink-only covers count, not identity). **Runtime (agent-side, where the
  queue exists):** the census-debt block on `GET /decision-quality` resolves each `pending:<ACT>`
  against the live evolution queue and flags `pending-ref-dead` rows — alive = registered AND
  non-terminal (`pending`/`in_progress`); a completed/cancelled/never-registered ref is flagged,
  observe-only (FD5). The referenced ACTs are pinned/critical-class so `evolutionActions.autoExpiry`
  can never sweep them. This runtime check — not the pull route alone — is the Close-the-Loop cadence
  carrier: the ACT machinery's own lifecycle re-surfaces the backlog.
- **`wired` is verified, not trusted:** (a) statically — the census test requires the enrolling
  component's source to import the census-exported decision-point id and reference `provenance:`
  enrollment (grep-level backstop; the typed import is the primary check); (b) at runtime — the read
  surface flags **wired-but-silent**: a declared-wired decision point with ≥`wiredSilentMinCalls`
  (config, default 20) llm-kind metric calls in-window under its 1:1 component key and ZERO
  decision_quality rows. Points below the threshold stay unflagged — an accepted bound under FD5
  (no alerting), backstopped by census-debt re-surfacing. Runtime divergence beats trusting the
  declaration.
- **`exempt-but-active`:** a `deterministic-only`-exempt decision point whose component key shows
  `kind:'llm'` metric rows in-window is a flat contradiction — flagged beside wired-but-silent (same
  counters, same granularity honesty; `no-decision-content` exemptions legitimately show llm rows and
  are not checked this way).
- **Volume classes are the PROVENANCE store's volume valve** (measured: 4,098 llm calls/24h on the dev
  agent, 3,641 of them CoherenceReviewer; blanket always-write would make the sampling knob inert):
  `full` (always-write; reserved for genuinely low-frequency high-stakes points — the two first
  customers) | `sampled:<rate>` (rides the existing FNV-1a sampling) | `budget:<rows/day>` (per-point
  daily cap — UTC calendar day, enforced at the settlement write via an indexed COUNT since UTC-day
  start (restart-safe, no new state), with an honest `droppedByBudget` counter in `status()` and on the
  route). The valve governs the provenance JSONL row; the ~250-byte `decision_quality` row is written
  for every enrolled settlement (§5.5). The arbiter-bypass invariant is RESERVED for `full`-class
  points (FD4 as amended).
- **Census debt is re-surfaced, not just pinned:** `GET /decision-quality` reports wired/pending/exempt
  counts per window plus the `pending-ref-dead` flags above.

### 5.7 Config, rollout, substrate construction, rollback

- **`provenance.uniformSeam.enabled` is OMITTED from ConfigDefaults** and resolves via
  `resolveDevAgentGate` — LIVE on a development agent, DARK on the fleet (this is `DEV_GATED_FEATURES`,
  NOT `DARK_GATE_EXCLUSIONS`: the seam is an observe-only side write). Deliverable: a
  `DEV_GATED_FEATURES` entry (`configPath: 'provenance.uniformSeam.enabled'`) with justification:
  "observe-only side write at the router-settlement seam; never gates/blocks/delays the decision call;
  no egress, no spend, no destructive action; failure is catch-logged." `dryRun` defaults TRUE even on
  dev — metadata-only would-write logs, ALL durable writes suppressed (§5.2) — until a deliberate
  `dryRun:false` flip after the would-write soak validates volume-class dispositions. Migration note:
  `migrateConfig` must NOT seed the key (a seeded `enabled:false` would permanently pin the dev gate
  off — the documented PostUpdateMigrator.ts:330 omit-requirement pattern).
- **Graduation checklist (codex r3 — each phase has expected counters, so the substrate cannot sit
  impressively dark):** (1) always-on minting live → llm-kind `verdict_id` non-NULL rate ≈ 100%;
  (2) dev dryRun → would-write log lines for both first customers, volume-class dispositions sane;
  (3) `dryRun:false` on dev → `decision_quality` rows accruing for both customers, provenance JSONL
  rows for `full`-class, enacted self-report outcomes present; (4) grading job enabled on dev → grade
  distribution populating, cursor advancing, `pending-ref-dead` empty; (5) fleet stays dark pending
  operator (each step's counters read from `GET /decision-quality`). Stated honestly (codex r4): while
  `dryRun` holds, ALL durable writes are suppressed, so the substrate's real write path is validated
  only at phase (3) — deliberate staging (metadata-only soak first, then write-path validation on dev),
  not an oversight. Phase (4) additionally reads the per-rule unknown/coverage rates as a PRODUCT
  signal, not just a metric state (codex r6): a rule whose grades are dominated by `unknown` — quiet
  respawns invisible to the sensor, un-orderable start-times, platform differences — is evidence the
  rule needs work before its numbers steer any model/prompt decision, and the graduation review says
  so out loud.
- **JudgmentProvenanceLog construction moves OUT of the mesh block** (today it is constructed only
  inside `if (meshIdMgr && meshSelfId)` at server.ts:19005/21622, so the seam would have nothing to
  write to on a single-machine agent and `/decision-quality` would 503 through the whole dev soak). It
  becomes UNCONDITIONAL (a dir + a buffered appender — pure machine-local observability; construction
  uses only stateDir/config/logger, zero mesh inputs, and the hoisted variable at server.ts:837 is
  already passed unconditionally at :22892 — only the assignment moves). The `/judgment-provenance`
  503 text ("not constructed (single-machine / pool dark)", routes.ts:15011) is updated to match —
  and so is the `/judgment-provenance` CapabilityIndex entry (CapabilityIndex.ts:125 hardcodes the
  same now-obsolete 503 cause; INT r5, Agent Awareness Standard — deployed agents' self-awareness
  text must not describe semantics FD9 removes). The
  two existing mesh-block callsites keep their optional-chaining writes unchanged.
- **Machine-coherence posture:** the flag does NOT automatically "participate like sibling flags" — the
  manifest is a closed enumerated list. Deliverable: a `COHERENCE_MANIFEST_EXCLUSIONS` row for
  `provenance.uniformSeam.enabled` with reason: "per-machine observability side write; skew degrades to
  missing provenance rows on one machine, visible in /decision-quality coverage — no cross-machine data
  guarantee" (machineCoherenceManifest.ts:246-266; note honestly: the N5 drift-guard sweep covers
  `multiMachine.*` paths only, so this row is a voluntary documentation row, not ratchet-swept).
- **Rollback semantics:** (1) correlation-id minting + verdict_id stamping are always-on (§5.1.3) —
  opaque, contentless, llm-kind-scoped, and the join-miss path is honest; (2) the `/decision-quality`
  join treats a missing provenance row as `expired` and an unenrolled mint as `not-written`, never
  an error; (3) flipping the seam off stops NEW decision/quality rows only — already-written rows age
  out on their own retentions (14d/90d), no purge, no migration. Grading job off = cursors freeze in
  place, resumable.
- Grading job manifest ships `enabled:false` (cost-bearing job class). Config keys nested under the
  existing `provenance` block (types.ts:4167): `provenance.quality.{decisionRetentionDays,
  rollupRetentionDays, maxDecisionsPerPass, evidenceWindowHours, gradingSlackHours,
  wiredSilentMinCalls, minSampleForRates}` — tuning knobs, cheap-to-change-after (dark feature, no external effect; the
  hog store's retention DERIVES from evidenceWindowHours + gradingSlackHours per §5.3, and a window
  change mints new rule versions per §5.4.5, so the knobs cannot be tuned into silent un-grading or
  silent semantic drift).
- No other feature's rollout flags are touched.

## Migration parity & agent awareness

- **Route + capability awareness:** `generateClaudeMd()` gains a Decision-Quality section (what the
  meter is, `GET /decision-quality` curl, proactive trigger: operator asks "is this gate performing /
  does it need a bigger model / a prompt change?" → read the meter, don't guess) — plus the
  content-sniffed `migrateClaudeMd()` twin so EXISTING agents receive it on update.
- **Config:** `migrateConfig` is a deliberate NO-OP for `provenance.uniformSeam.enabled` (omit-required,
  §5.7). The `provenance.quality.*` tuning keys are also unseeded (inline defaults).
- **Job:** the `llm-decision-grading.md` template is picked up on fresh install (init.ts:448) AND on
  every update (`PostUpdateMigrator.migrateBuiltinJobs` :3707, honoring operator-disabled state) — no
  dedicated migration needed; stated so the parity requirement is visibly satisfied, not assumed.
- **Hooks / hook scripts / built-in skills: none touched** (stated so the six-point enumeration is
  visibly complete). All migrations named here are idempotent (content-sniff / existence-check /
  install-if-missing per their cited mechanisms).
- **Census:** PROVENANCE_COVERAGE + its ratchet test ship in-repo (CI-side; no agent-install surface).

## Testing (Testing Integrity — all three tiers + the review-mandated semantic suites)

- **Unit:** correlation-id threading through failure-swap (N attempt metric rows, ONE id, ONE decision
  row at settlement); settlement coverage for EVERY evaluate() exit (ladder success/failure, `!cfg`
  early return, provider-unavailable degrade arm, enforcedNoRoute throw, RouterFailClosedError rethrow,
  fallback-'none' throw); per-attempt capture scoping (a rejected primary's onUsage never attributes to
  the settled swap row; a post-settlement late callback is discarded); breaker floor (inbound unmarked
  id discarded + re-minted `b-` prefix; marker consumed single-use; a REUSED caller options object never
  replays a stale marked id; `mintedBy` honesty); router mints on an internal clone (caller object never
  mutated); onCorrelationId fires at mint, once, including throw paths, never on breaker-stripped
  bypassed calls; seam strips `options.provenance` on BOTH router and breaker paths; write-once
  semantics incl. errored settlement; volume classes (full/sampled/budget + UTC-day COUNT enforcement +
  droppedByBudget; decision_quality row written regardless of class); evidence-rule predicates BOTH
  SIDES (respawn ordering-test true → wrong vs new-owner/un-orderable → unknown; leave-recurrence
  same-process-signature → wrong vs same-commandHash-different-process → unknown; enacted/floorPermitted
  preconditions — breaker-held kill re-flag grades NOTHING; would-kill/deferred/aborted/
  decider-unavailable age out unknown; realcheck pass/fail/absent); the durable hog store (atomic write,
  fail-closed read, hydration, retention = evidenceWindow + gradingSlack derivation, latest-plus-
  in-window-kill slot retention, grade-on-supersede ordering — the outgoing record is graded BEFORE
  replacement); annotateOutcome integrity (enum validation, ruleId→rung registry rejection, upsert
  idempotency on correlationId×gradedBy, precedence incl. within-rung conservative resolution,
  self-report never overrides); rollup mutation (decision-day bucket, decrement-on-supersede,
  boot + 6h-timer periodic reconcile self-repair, expired derived at read); P19 sustained-failure test
  for unknown-regrade backoff + terminal `expired` give-up; clamps (decision-field bounding,
  optionsPresented/verdict_class/promptId charset clamps, evidence ≤500, context head 300);
  kind-scoped verdict_id query lint; `onCorrelationId`-throw containment (a throwing callback is
  caught + counted, the decision call succeeds — SEC r5); annotate-chokepoint owner rejection
  (`gradedBy.component` ≠ the ruleId's registered owning component → rejected + counted — ADV r5);
  insufficient-evidence marker on both sides of the `minSampleForRates` boundary (codex r5).
- **Redaction/scrub semantic suite (the security posture IS test-shaped):** a seam-written row never
  serves raw model output or argv fragments (hog context excludes argv — asserted on realistic
  ExternalHogFacts incl. positional-password shapes); `contextFull` never crosses `readRedacted` or the
  pool merge; content-bearing rows carry identity/bounded-features only; dry-run logs are metadata-only
  AND dry-run suppresses all durable writes; evidence_note absent from every /decision-quality payload;
  the hog decision store AND the JP log are NEVER_SERVED under the PRODUCTION layout — the tests seed
  `<projectDir>/.instar/state/...` paths exactly as production produces them (the prior JP unit test
  went green on a layout production never produces — SEC r4) and assert file routes refuse to serve OR
  edit both; backup exclusion proven against the named threat, not by list membership — seed
  `includeFiles: ['state/']` with remediation OFF under the production layout and assert the snapshot
  OMITS the hog store (r6: a membership-only unit test would have gone green on the mis-pinned
  flag-gated list — the misrooted-NEVER_SERVED test lesson, applied to the backup arm).
- **Integration:** `GET /decision-quality` 200-with-data over a seeded ledger+substrate; 503-when-dark;
  Bearer required; `?scope=pool` dark-peer tolerance (`pool.failed`), peer-URL credential guard, field
  allowlist (a hostile peer row with extra fields — incl. `contextFull` — is stripped); grade-pass
  endpoint cursor keyset (same-ms burst at the page boundary), batch ceiling, idempotent re-run,
  concurrent job+manual convergence.
- **E2E lifecycle (feature-alive):** production init path, SINGLE-MACHINE boot → JP log constructed →
  seam on (dev-gate) → route answers 200 not 503 (this tier is exactly where the mesh-block construction
  bug would have been caught).
- **Wiring integrity:** DEV_GATED_FEATURES both-sides test for `provenance.uniformSeam.enabled`;
  `setDecisionQualityRecorder` singleton injected not-null at AgentServer construction; machineId8
  injection present; COHERENCE_MANIFEST_EXCLUSIONS row present; prune-timer construction condition
  includes the quality arm.
- **Ratchet fixtures:** PROVENANCE_COVERAGE declare/undeclared/exempt-taxonomy cases; pending-ACT
  STATIC checks (format, pinned shrink-only, identity-change review); EXEMPT baseline pinned
  shrink-only (ADV r5); component-key UNIQUENESS across census entries — a second point declaring a
  sibling's key fails the census test (ADV r5); typed-import verification
  positive + negative (string-literal-only decision point fails); rung-registry enum pinning (+ the
  owning-component column); census-debt counts + pending-ref-dead + wired-but-silent +
  exempt-but-active flags on route (integration tier for the runtime liveness half).
- **Existing-test sweep (behavior-changes-break-old-tests):** stamping verdict_id on every llm row
  changes the pinned NULL-world — `tests/unit/CircuitBreaking-feature-metrics-tap.test.ts` + ledger
  tests are updated in the same PR; full tests/ sweep before push.
- **Clock discipline (wall-clock time-bombs):** all window/retention/cursor tests use the foundations'
  injected `now()` seams (JudgmentProvenanceLog.ts:114, FeatureMetricsLedger.ts:244) — never real-clock
  fixture dates.
- **Perf assertion:** measured seam overhead — not-enrolled call adds no measurable work (presence check
  only). Scope stated precisely: the provenance JSONL row is async-buffered off the decision path
  (JudgmentProvenanceLog.ts:244-255); the `decision_quality` insert is a SYNCHRONOUS WAL insert in an
  isolated try/catch that never throws into the decision path, strictly ≤1 per settled decision — the
  same posture as the existing per-metric-row insert (FeatureMetricsLedger.ts:402-446), and strictly
  less frequent.

## Decision points touched

| Decision point | Classification | Justification / floor |
|---|---|---|
| Provenance write at the router-settlement seam | `invariant` | Observe-only side write; gates nothing, chooses nothing. Deterministic: writes iff enrolled (+ volume-class rule per §5.6). Failure never touches the decision path. |
| PROVENANCE_COVERAGE ratchet (CI) | `invariant` | Deterministic declare-or-fail over a static census with closed taxonomies + static ref checks (runtime liveness is a separate observe-only flag) — a completeness property with no competing signals. |
| Outcome grade assignment (grading endpoint) | `judgment-candidate` | Floor: bounded action space = `{right, wrong, unknown}` (FD3); conservative default = `unknown` (no evidence → unknown, never guessed); ladder = deterministic evidence rules (registered ruleId predicates with evidence-strength classes, §5.4) → recurrence/persistence → [DORMANT: LLM evidence-interpreter — NO code this build; activates only behind ACT-1198's benched evaluator + FENCE + injection-exposed registration] → deterministic `unknown` rung. Grades never gate behavior. |
| Grade precedence on conflict | `invariant` | Fixed rung order (deterministic > recurrence > llm > self-report) + fixed within-rung conservative order (wrong > unknown > right); rungs derived from the registered rule, never claimed — a lookup, not a call. |
| Correlation-id minting | `invariant` | Mechanical mint; router-vs-breaker fallback is a fixed structural rule (FD1/FD8). Router mints on an internal clone; breaker discards unmarked inbound ids and consumes markers single-use. |
| Wired-but-silent / exempt-but-active / pending-ref-dead flags | `invariant` | Deterministic comparisons of existing counters/state; flag, never block. |

## Multi-machine posture

- **Provenance rows (`state/judgment-provenance/`) + the hog decision store
  (`state/external-hog-decisions.json`)** — `machine-local` BY DESIGN.
  machine-local-justification: operator-ratified-exception — the JudgmentProvenanceLog
  machine-local containment posture ("machine-local-full/HTTP-redacted") is pinned in the ratified
  standard text itself (docs/STANDARDS-REGISTRY.md:522 "### Decision Provenance & Outcome Review";
  ratified in PR #1436, merge commit 965a3602c). This spec adds writers to that store; it does not
  change its posture (and the §5.2 content classes exist precisely so the retrofit cannot change it de
  facto). The hog store additionally holds machine-specific process identity (pids/start-times) that is
  MEANINGLESS off-machine — its `.instar/state/` placement keeps it out of git-synced agent-home paths
  (INT r3). Pool-scope visibility is proxied-on-read: the existing `GET /judgment-provenance?scope=pool`
  merges peers' REDACTED rows (routes.ts:15023-15050), hardened in this build with the peer-URL
  credential guard + field allowlist (§5.5).
- **`decision_quality`/`decision_outcomes`/rollup/cursor + `feature_metrics.verdict_id`** — inherit the
  existing feature_metrics posture (machine-local SQLite observability; per-machine spend/activity is
  the semantic unit). Unified operator view via proxied-on-read below.
- **`GET /decision-quality`** — unified via proxied-on-read (`?scope=pool`): MACHINE-TAGGED rows per
  decision-point (per-machine framework routing makes per-machine quality genuinely distinct data, not
  fragments), summed nowhere silently; serves redacted summaries + pointers only; never raw context.
- **Cross-machine outcomes** — honest-degradation this build (FD10): orphan outcome rows are counted
  and reported (`orphanOutcomes`), never silently lost; correlation ids carry a machineId segment so
  the ACT-1199 routing follow-up has the structure it needs.
- **Grading job** — runs per machine over that machine's local rows (grading follows the ratified
  machine-local data posture). Its summaries are pool-visible via the route's pool scope.
- **Config flag** — `provenance.uniformSeam.enabled` gets a `COHERENCE_MANIFEST_EXCLUSIONS` row with a
  stated reason (§5.7); it does NOT claim automatic manifest participation.

## Frontloaded Decisions

- **FD1 — Correlation-id minting: router-minted at entry on an INTERNAL clone, breaker-local floor,
  ALWAYS-ON.** The router is the only layer that sees one logical decision as one call; minting there
  makes swap-attempt rows correlate. The caller's options object is never mutated; the mint marker is
  single-use at the breaker. One decision row per `router.evaluate()` invocation; caller-level retries
  are distinct decisions by design. The floor guarantees no row is UNCORRELATED (breaker mints carry
  the `b-` id prefix and are honestly decision-approximate, §5.1.2). Minting/stamping is ungated:
  opaque id, no content, trivial rollback. Ids are collision-resistant (uuid-based, machineId-segmented
  on multi-machine installs — pool/mesh self id, first 8 chars, injected at AgentServer construction),
  never time+seq.
- **FD2 — Read surface: a new `GET /decision-quality` route** over the dedicated quality substrate
  (§5.5) — not a block bolted onto /metrics/features, and never a JSONL scan. Cross-linked by feature
  key so the operator can pivot to the cost view.
- **FD3 — Grade taxonomy: global `right | wrong | unknown`** (+ `expired` as a READ-side derived state
  — never a rollup column, never a writable grade; the aged-out terminal event has exactly one name) +
  a clamped (≤500 chars), pointer-disciplined `evidence` note (never served by /decision-quality).
  Per-point custom scales DENIED — uniformity is what makes the meter comparable; nuance lives in
  structured outcome fields (which record effective rule parameters like `windowMs`). Grades carry
  their rule's evidence-strength class on the read surface — proof-like and heuristic grades are never
  conflated.
- **FD4 (amended) — Volume classes replace blanket arbiter-bypass**, and they valve the PROVENANCE row
  only. The always-write invariant is RESERVED for `full`-class decision points (rare, high-stakes —
  the two first customers). High-frequency points declare `sampled:<rate>` or `budget:<rows/day>`
  (UTC-day, COUNT-enforced); budgets drop JSONL rows with a loud `droppedByBudget` counter. The
  content-free `decision_quality` row is written for every enrolled settlement regardless of class, so
  quality counts stay complete.
- **FD5 — No alerting in this build**: the meter is a pull surface; the grading job never messages
  (pinned in its template). A quality alert is a follow-up that would owe Standard B design.
- **FD6 — Ships via the dev gate, dryRun-first, exact posture:** `provenance.uniformSeam.enabled`
  OMITTED from ConfigDefaults → `resolveDevAgentGate` → LIVE on a development agent / DARK on the fleet;
  `DEV_GATED_FEATURES` entry with the §5.7 justification; `dryRun` defaults TRUE even on dev
  (metadata-only would-write logs; ALL durable writes suppressed) until a deliberate `dryRun:false`
  flip; `migrateConfig` never seeds the key. Grading job `enabled:false`. Graduation follows the §5.7
  counter checklist. Tuning knobs cheap-to-change-after (dark, no external effect; the
  evidenceWindow↔hog-store-retention derivation and the window-change-mints-new-ruleId rule close the
  two unsafe-tuning corners).
- **FD7 — Write-once at settlement, settlement = every exit.** Exactly ONE provenance decision row per
  correlation id, written by the router at whichever `evaluate()` exit fires (ladder, early-return,
  degrade, enforced/fail-closed/fallback-none throws); per-attempt capture scoping keeps rejected/late
  attempts out of the row; an errored settlement writes one `'<errored>'` row so ladder quality is
  itself gradeable.
- **FD8 — `verdict_id` single-writer, scoped to llm-kind rows.** The minted correlation id ALWAYS
  occupies `feature_metrics.verdict_id` on `kind:'llm'` rows (event-kind rows keep their existing
  semantic labels; joins filter kind='llm', enforced by a query-scope lint/test); the documented
  caller-supplied `classifyVerdict.verdictId` is relocated INTO the provenance row's context as
  `callerRef` (types.ts:1112 doc updated same PR). The router ignores inbound ids (internal clone); the
  breaker discards unmarked inbound ids and consumes markers single-use — callers cannot inject a
  chosen id into another decision's chain on any path.
- **FD9 — JudgmentProvenanceLog construction becomes unconditional** (out of the mesh block; §5.7) —
  the seam must have a substrate on every agent, single-machine included; `/judgment-provenance` 503
  semantics updated; existing callsites unchanged.
- **FD10 — Cross-machine outcomes: honest-degradation now, routing later.** Orphan outcomes counted +
  reported on the route; machineId-segmented ids provide the routing structure; actual owning-machine
  annotation routing is ACT-1199, not this build.
- **FD11 — Grading is deterministic-only in this build.** The LLM evidence-interpreter rung ships NO
  code (dormancy is structural-by-absence) and activation is gated on ACT-1198 (benched evaluator +
  FENCE + injection-exposed registration). A meter graded by an ungraded LLM would be the problem
  statement recursed.
- **FD12 — Parent-standard bench-feed clause: explicit tracked deferral.** "Graded real cases feeding
  the bench battery" (registry:523) depends on the ACT-1195 prompt-parity infrastructure for the battery
  format; it is deferred to ACT-1198 with the clause named — not silently dropped. ACT-1198 is
  pinned/critical so the deferred constitutional obligation cannot be auto-expired.
- **FD13 — Dashboard rendering deferred, tracked ACT-1197.** API-only this build; operator consumption
  this build is conversational via the agent (the CLAUDE.md proactive trigger ships same-PR) with
  private-view rendering on demand — the /metrics/features → LLM-Activity-tab precedent. The
  Operator-Surface Quality obligations bind at ACT-1197 (no authorize/decide/act flow exists on this
  read surface); the future tab rides the WS4.4(f) shared poll cache.

## Open questions

*(none — all resolved into Frontloaded Decisions above)*
