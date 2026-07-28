---
status: draft
approved: true
approved-by: "operator Justin (verified, topic 29723) — 2026-07-19"
parent-principle: "Never-Waste Feedback — corrections compound"
lessons-engaged:
  - "Never-Waste Feedback (a correction is durable signal, never fixed-and-forgotten) — SHARPENED from recurring-only to every-correction"
  - "Close the Loop / Deferral = Deletion (a captured-but-never-closed correction record is an abandoned loop)"
  - "Observation Needs Structure (the ClassReview row is the required artifact that cannot exist without the review happening)"
  - "Signal vs. Authority + Agent Proposes / Operator Ratifies (the class-review PROPOSES; the operator ratifies a constitution amendment)"
  - "Intelligence Infers, Keywords Only Guard + Intelligent Prompts — An LLM Gate Must Not String-Match (judge by MEANING with structured/enum output; a deterministic pre-filter may only DROP toward pass-through)"
  - "Bug-Fix Evidence Bar — verify before you claim (verify-before-done GENERALIZES it from fixed/wired/working to every completion claim)"
  - "Verify the State, Not Its Symbol (a completion claim is a SYMBOL; the turn's tool-call trace corroborates the STATE — a trace corroborates, it does not prove, so SIGNAL-first)"
  - "Maturation Path — every feature ships enabled on dev agents (dark on fleet, dry-run first)"
  - "No Unbounded Loops (P19: cap AND backoff AND breaker) / Bounded Blast Radius / Capacity Safety — No Unbounded Self-Action (self-action controller + convergence proof)"
  - "No Silent Degradation to Brittle Fallback (both judges swap-or-fail-toward-not-producing; never fabricate a delta or a false 'verified')"
  - "An Instar Agent Is Always a Multi-Machine Entity (P21 — every state surface declares its posture)"
  - "Bounded Notification Surface (P17 — aggregate the backlog drain into one operator item, never one-per-correction)"
  - "The Agent Carries the Loop (owner⟂blockedOn on the class-review's own follow-through)"
  - "Token-Audit Completeness (both new LLM calls carry attribution.component)"
  - "L5 state-detection robustness (the transcript parser carries a canary + drift signal)"
review-convergence: "2026-07-19T20:16:07.122Z"
review-iterations: 6
review-completed-at: "2026-07-19T20:16:07.122Z"
review-report: "docs/specs/reports/correction-class-review-and-verify-before-done-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Correction → Standards/Process CLASS-Review → Fix Loop, and Verify-Before-Done Completion Discipline

> **One spec, two coupled mechanisms, one meta-rule.** Justin's required-by-infra meta-rule
> (Drive 7): *every correction, BEFORE any instance fix, runs a coupled two-question CLASS
> review — (1) what standard is missing/needs upgrading? (2) what dev-process gap let this
> CLASS through? — fix the class FIRST, then the instance.* Mechanism 1 builds that loop.
> Mechanism 2 (verify-before-done) **is the first thing Mechanism 1 produces** when you feed it
> the founding incident of this drive. They ship together because one demonstrates the other.

*(This spec was reshaped by an 8-source spec-converge round 1 — six internal reviewers, a
cross-model codex/gpt-5.5 pass, and the Standards-Conformance Gate. The `## Original vs
Converged` section of the convergence report records what changed and why.)*

---

## 0. Grounding correction to the design premise (read this first)

Echo's WS1 design (`.instar/drive7-ws1-correction-class-review.local.md`) states the
correction-learning surface is **dormant** — "`GET /corrections` returns 0." **Grounded against
the live Mini server (2026-07-19), that is wrong in a way that MATTERS:**

- `GET /corrections?limit=30` returns **24 records**, every one `status: open`,
  `occurrenceCount: 1`, including `CORR-…local-001/002/003` which map **exactly** to Justin's
  three drive-7 notes. **Capture works.** A single correction IS recorded.
- `GET /preferences/session-context` returns `count: 0` — *distillation into a preference* is
  recurrence-gated (`minSupport: 4`), so a one-shot correction never reaches
  `.instar/preferences.json`.

So the gap is **not** "corrections evaporate at capture." It is: **a recorded correction is
orphaned** — it sits `open` forever and produces **zero durable outcome** (no standards delta,
no process delta, no tracked action, no explicit decision-not-to). The pipeline only ever *acts*
on records crossing the recurrence gate (`CorrectionLoopDriver.route()` reads
`analyzer.analyze().crossed`); everything else is captured and abandoned — a **Close the Loop**
violation inside the subsystem whose job is not to let corrections rot.

**Premise tension surfaced by review (must be stated honestly).** The recurrence gate
(`minSupport:4`) was doing *double duty*: it suppresses noisy one-off corrections **and** it
masks a distillation flaw — the live backlog holds ~5 near-duplicate "clearer guidance for
approvals" variants that carry **distinct** `dedupeKey`s (the key is
`kind:sha256(normalizeLearning)` — a *phrasing* hash, not a *class* key). Going un-gated removes
the mask, so this spec must handle near-duplicate collapse itself (§3.8) rather than descope it.
This spec does **not** weaken the recurrence gate — it adds a *parallel, un-gated durable-outcome
path* beside it, and the two paths are made truly independent at the data layer (§3.3, resolving
the two-writers-on-`status` collision review found).

---

## 1. The existing foundation (build ON, do NOT duplicate) — verified at origin/main v1.3.881

- **`src/monitoring/CorrectionLedger.ts`** — machine-local SQLite (`stateDir/correction-ledger.db`;
  IDs `CORR-<machineId>-seq`; NOT in `multiMachine.stateSync`). Record: `kind`
  (`infra-gap|user-preference|noise`), `status` (`open→acted-on→verified|inconclusive|reopened`),
  `dedupeKey`, `learning` (internal-only, never crosses HTTP), `scrubbedSummary` (only text the
  API serves), CAS `version`. `record()` upserts on dedupeKey. **Both `learning` and
  `scrubbedSummary` are already `scrubCorrectionSecrets`-passed at `POST /corrections`
  (routes.ts ~21837).**
- **`CorrectionAnalyzer.ts`** — the RECURRENCE gate; reads only `status:'open'` records and
  **excludes `kind:'noise'`** (line 85). We do not touch it.
- **`CorrectionLoopDriver.ts`** — routes only `crossed` records; owns the transition of
  `correction.status` → `acted-on`. **The by-construction authority guard is the model to copy:**
  injected deps carry NO `EvolutionProposal`-mint and NO direct `MEMORY.md`/`CLAUDE.md`/
  `STANDARDS-REGISTRY.md`/`preferences.json` write. Security review CONFIRMED this holds against
  enactment; the residual injected-correction risk is *framing* + *secret egress*, not
  auto-enactment (§6).
- **`POST /corrections` (routes.ts ~21815)** — the agent-diagnosed one-tap record path (requires
  `X-Instar-Request:1`, boundary-scrubs). Fully decoupled from `analyze`.
- **`docs/STANDARDS-REGISTRY.md`** — the living constitution. Standards are **agent-proposed,
  operator-ratified**. A standards delta from the class-review is a PROPOSAL into that amendment
  loop, never an auto-write. The spec-review Standards-Conformance Gate + `/conformance/coverage`
  already read it.
- **Action-Claim Follow-Through Sentinel** — the real Stop hook is
  `.instar/hooks/instar/action-claim-followthrough.js` → `POST /action-claim/observe`; it uses a
  **deterministic** `classifyActionClaim`/`detectTimePromise` pre-filter (NO LLM call on a
  no-claim turn) and catches **FUTURE**-action claims. It **explicitly DESCOPED "A2 —
  completed-action claims verified against evidence"** because "the payload carries only
  `last_assistant_message`" (`CMT-1554`). **Mechanism 2 is that descoped A2, and §5 resolves the
  missing primitive honestly.**
- **Stop-hook infrastructure** — hooks are embedded string getters in `PostUpdateMigrator.ts`
  (e.g. `getResponseReviewHook()`), installed always-overwrite in `migrateHooks()`, registered in
  the Stop array by BOTH `init.ts` (new agents) AND `migrateSettings()` (existing agents). There
  is **no manifest** that auto-installs a new built-in hook — the build must add each piece (§6).
- **`src/monitoring/guardManifest.ts`** — every guard-shaped component must appear in exactly one
  of `GUARD_MANIFEST` / `NOT_A_GUARD` (`scripts/lint-guard-manifest.js`). `loadBearing:true`
  requires `criticalPath`, `soakWindowDays`, `declaredLoadBearingAt`.

---

## 2. The founding incident (this drive), run through the loop

The verify-before-done trigger is a REAL correction: **Echo over-claimed "getting Codey his
assignment now" before verifying the dispatch channel reached Codey.** Feed it to Mechanism 1:

- **Q1 — Standard gap.** *Bug-Fix Evidence Bar* (verify before you claim fixed/wired/working)
  exists but is scoped to fix/wire/work. It does not cover "X is done / sent / **getting done
  now** / handed off / deployed." → **PROPOSE: generalize it to "Verify Before You Claim *Done*"**
  covering every completion assertion, including present-continuous "in-progress asserted as
  effectively done." *(standard delta)*
- **Q2 — Process gap.** No structural detector on completion assertions; no per-turn evidence
  primitive. → **PROPOSE: build the completion-claim signal + the `TurnEvidence` tool-call-trace
  primitive.** *(process delta = the WS1-2 build)*

WS1-2 is the output of WS1-1 fed the drive's own founding correction (task WS1-3). This exact
end-to-end run is the acceptance demo (§9).

---

## 3. Mechanism 1 — the un-gated Correction Class-Review

### 3.1 Trigger: record-time, server-side, unconditional (NOT a self-tag; NOT lease-gated)

At correction-record time the record path **synchronously creates a deterministic `pending`
`ClassReview` shell** (keyed on `dedupeKey`, with a **provisional `semanticClassId = dedupeKey`** so
the shell is complete without waiting on collapse) — a row that always exists the moment the
correction does — and the async fill (§3.2) then (a) runs the two-question LLM judgment and (b) runs
semantic collapse (§3.8), which may **attach** the shell to an existing class's `semanticClassId` or
leave the provisional one. **Collapse RE-POINTS the `semanticClassId`; it NEVER removes,
supersedes, or clobbers a shell** (F3): both the incoming shell and the class's existing shell
remain distinct, resolvable rows keyed on their own `dedupeKey`, and only the downstream OUTCOME
(Initiative/Action) dedupes per `semanticClassId` — so the per-`dedupeKey` shell the §3.5 gate reads
always survives. (The same-`dedupeKey` operator/deterministic `superseded` transition of §3.6 is a
separate lifecycle WITHIN one `dedupeKey` and likewise leaves the resolvable row in place, linked to
its supersessor — never a silent clobber.) The fill is retried under backoff, dead-lettered after N (§3.7). This resolves the "synchronous record-time vs provider-failure
retry" tension (codex-r2): the *required artifact* (the shell) is guaranteed present by
construction, while its *verdicts* fill async. The instance-fix gate (§3.5) requires the shell to
exist; in **enforce** mode it additionally requires the verdicts to be filled (not a bare
pending shell), while in **dry-run** mode a pending shell satisfies the would-refuse check.

The class-review fires for **every** correction, **unconditionally** — and the record-side `kind`
can NEVER be the field that suppresses it for an operator's correction. **F2 — `kind:noise` cannot
dodge the class-review for an operator-attributed correction:** the agent-supplied `kind`
(`infra-gap|user-preference|noise`) is read straight from the `POST /corrections` body
(routes.ts ~21849, validated only against the enum) and is therefore **agent-settable**, so for
every `operator-attributed` correction (origin **server-derived**, non-forgeable — see below) the
review fires **regardless of the agent-supplied `kind`, `noise` included**. If such a correction
genuinely is noise, the two-question judge (§3.2) resolves it `not-applicable` on both arms → a
terminal ClassReview with ZERO Initiative/Action (the same terminal the garbage-correction demo
asserts, §9) — the disposition is made by the server-derived origin + the LLM judge, never by an
agent-writable field. A `noise` `kind` may skip the review ONLY for an `agent-self` correction (the
agent electing not to review its own low-value self-note — no operator signal is at stake; and this
is distinct from the recurrence analyzer's `kind:'noise'` exclusion of §1, which governs only the
separate preference-distillation path, not this un-gated class-review path). So the "no record-side
tag the agent can omit-or-set to dodge the review" property actually holds. This is the
load-bearing design choice, chosen over an agent-supplied tag or a status-sweep for three reasons
review surfaced:

1. **"Class before instance" becomes true by temporal construction** (adversarial A2): the review
   is produced *when the correction is recorded*, which is necessarily before any later fix — so
   the meta-rule needs no fix-side tag the agent could omit to dodge it.
2. **It avoids the two-writers-on-`status` collision** (lessons-aware): the recurrence path owns
   `correction.status` (`open→acted-on`); the class-review path writes only its **own** separate
   `ClassReview` row and **NEVER mutates `correction.status`**. The §-old claim "the correction's
   ledger status advances only when its class-review closes" is **deleted** — the two lifecycles
   are orthogonal.
3. **It is not lease-holder-gated** (integration M2): a correction captured on a standby machine
   must still be class-reviewed, or the exact orphaning bug returns cross-machine. Record-time
   firing runs on whichever machine took the message.

A **backstop sweep** (daily; see §Frontloaded FD-A) covers records that missed the synchronous
fire (a crash between record and review) and the existing 24-record backlog. The sweep queries
**corrections that have no `ClassReview` row for their `dedupeKey`** (a left-anti-join against the
ClassReview store) — NOT `status:'open'` — so it never contends with the recurrence path's pool.
It runs on **every** machine over its own ledger, writing to the **unified** ClassReview store
(§3.9), idempotent per `dedupeKey`.

**Origin segregation** (adversarial A10): each correction carries `correctionOrigin` —
`operator-attributed` (the record came from an authenticated operator correction) vs `agent-self`
(the agent's own `POST /corrections` self-note). *(Naming — decision-completeness: this
`correctionOrigin` is distinct from the fix-Action's `origin: correction` tag in §3.5/FD-D;
the two are never conflated in the build.)* The **full** un-gated review + Initiative/Action
minting runs on `operator-attributed` corrections. `agent-self` corrections take a **lighter**
path: the review runs and logs, but only *proposes* above a confidence-or-recurrence bar, so a
session self-recording liberally cannot flood the operator's ratification queue with self-authored
proposals.

**`correctionOrigin` is non-forgeable — server-derived, never agent-settable** (lessons-aware N2 /
security NEW-3 — Know Your Principal): because it gates the authority level, it is **stamped
server-side from which authenticated path created the record** (an authenticated operator message
vs the agent's own `POST /corrections` bearer path) — it is **never** read from a request field. An
`agent-self` note asserting `correctionOrigin: operator-attributed` to self-escalate is
structurally impossible; the unknown/unresolvable case defaults to `agent-self` (the lower-privilege
direction), never `operator-attributed`.

**Observations are modeled separately from the review** (codex-r3): the same `dedupeKey` can be
recorded on two machines or by two origins, so a `ClassReviewObservation(correctionId,
correctionOrigin, machineId, recordedAt)` child list is kept per `ClassReview`; the review's
**effective origin is the highest-authority observation** (any `operator-attributed` observation
makes the class operator-attributed). This prevents an `agent-self` re-record from downgrading a
class an operator already raised.

### 3.2 The two coupled questions (judge by MEANING; a deterministic contract specifies)

For a correction `r`, one LLM call (routed through the shared `IntelligenceProvider`, §7; input =
`r.scrubbedSummary` ONLY, never `r.learning` — §7/§6-S5) reasons by meaning over the summary + a
**bounded** standard index (the registry standard *titles* only, not full bodies — D12) and emits
**structured, enum-constrained output** (a tool-call, never free text keyword-matched):

```jsonc
{
  "standardReview": {
    "verdict": "covered" | "needs-upgrade" | "new-standard-needed" | "not-applicable",  // closed enum
    "standardRef": "Bug-Fix Evidence Bar",   // required unless new-standard-needed / not-applicable
    "proposedDelta": "…what the standard should say to prevent this CLASS…",  // UNTRUSTED text (§6-S2)
    "isPolicyRelaxation": true | false        // by-MEANING judgment, NOT a regex (§6-S2)
  },
  "processReview": {
    "verdict": "covered" | "process-gap" | "not-applicable",   // closed enum
    "proposedDelta": "…a gate / ratchet / review-step / test that would catch this CLASS…"
  },
  "rationale": "…scrubbed free text…",
  "confidence": "low" | "medium" | "high"     // coarse band, not a false-precision float
}
```

The deterministic contract that keeps "judge by meaning" honest and testable (codex X1):

- **Independent verdicts.** The two verdicts are NOT forced to pair (adversarial A14) — one may be
  `not-applicable` while the other is `process-gap`. The prompt must not prime over-pairing.
- **`not-applicable` is a first-class exit** (adversarial A3): a garbage/low-value correction
  resolves to `not-applicable` on both arms → a logged terminal ClassReview with **zero**
  Initiative/Action. The garbage-correction acceptance demo (§9) asserts exactly this.
- **`low` confidence never auto-proposes** — it routes to Attention for human disposition (an
  unsure proposal is a question, not an assertion).
- **Golden corpus** — a checked-in fixture set of correction→(expected verdict-pair) cases (incl.
  the drive's two founding corrections + a garbage case) is the prompt regression bar; a prompt
  edit regressing it fails CI (mirrors `gate-prompts-judge-by-meaning`).
- **`isPolicyRelaxation`** is judged **by meaning in the same structured call** — NOT by the
  legacy `matchesPolicyRelaxation` regex (which review flagged as the spec's own forbidden
  anti-pattern, and which is trivially evaded). A `true` verdict routes the delta to Attention for
  human disposition, never auto-records.

### 3.3 The ClassReview record — the required artifact (Observation Needs Structure), independent of correction.status

A durable `ClassReview` row, keyed on `r.dedupeKey` (**one resolvable row per `dedupeKey`, never
collapsed away — F3**), carrying a `semanticClassId` (§3.8) that **groups rows into the
outcome-class**: "one durable outcome per CLASS" is modeled as *one Initiative/Action per
`semanticClassId`* spanning *many per-`dedupeKey` rows*, not emergent. The row is the unit the §3.5
gate resolves; the `semanticClassId` is the unit the downstream outcome dedupes. Fields:
`dedupeKey`, `semanticClassId`, `observations[]` (the `ClassReviewObservation` child list of §3.1),
`effectiveOrigin` (derived, highest-authority observation), `fillState`
(`pending→filled|dead-lettered` — the shell vs the LLM-authored verdicts, §3.1), `standardReview`,
`processReview`, `confidence`, **`standardOutcome`** ⟂ **`processOutcome`**, each with lifecycle
`proposed→ratified|shipped|rejected|deferred|expired-unreviewed|no-action` — **split by outcome
dimension** so a correction that needs both a standard proposal and a process action can terminalize
each independently (codex X2 / adversarial A8). The **`no-action` terminal** (adversarial NEW-3) is
set **immediately** when that arm's verdict is `covered` or `not-applicable` — there is nothing to
propose, so the arm is born terminal (a `not-applicable` review is therefore fully terminal at
fill-time with ZERO Initiative/Action, which is what §9's garbage-correction demo asserts). A
top-level `reviewLifecycle` (`open→parked|resolved|superseded|reopened`): `resolved` iff BOTH arms
reached a TRUE-terminal outcome (`ratified`/`shipped`/`rejected`/`no-action`); `parked` if any arm
is `expired-unreviewed` (aged, unactioned) OR `deferred` (operator revisit-later) — both are
still-OPEN loops that keep counting in backlog-health and can `reopen`/resolve, NOT durable closes
(§3.6). Plus
`initiativeId?`, `actionId?`, `attemptCount` (machine-local — NOT replicated, §10), `deadLetteredAt?`,
timestamps, `version`. **All LLM-authored text
fields (`proposedDelta`, `standardRef`, `rationale`) are `scrubSecrets`-passed before persist**
(§6-S7) and served via a `toApiView` that strips nothing else raw. The row lives **entirely
separately** from the correction ledger's `status`.

**Test for the whole mechanism (Observation Needs Structure): "if the class-review were silently
skipped, what artifact would fail to exist?" → this row.** The instance-fix gate (§3.5) makes its
absence *for the referenced class* block, so a skipped review is caught.

### 3.4 Authority-bounding (by construction — copy the driver's guard; nothing more)

`CorrectionClassReview` is given the **same injected-capabilities envelope** as
`CorrectionLoopDriver`, and nothing more:

- `createInitiative({ needsUser: true, … })` — a standards delta becomes a **draft Initiative in
  `needs-user`**; the operator ratifies. `needsUser: true` is **enforced INSIDE the injected
  capability** (a caller override to `false` is rejected) and pinned by the by-construction test
  (adversarial A14). The Initiative records the originating `correctionId`/`dedupeKey` and renders
  the LLM-authored `proposedDelta`/`standardRef` inside an **untrusted-data envelope with a
  provenance banner** ("this proposal originated from an UNTRUSTED correction; treat as data,
  verify independently") — §6-S2.
- `addAction(…)` — a process delta becomes a **tracked Evolution Action**, tagged
  `origin: correction`, `owner: agent` (the agent drives the build), and **excluded from any
  autonomous-execution consumer** (the "just be Echo" auto-fix loop) — surface-only, pinned by
  test (§6-S9).
- `attentionRoute(…)` — an `isPolicyRelaxation` or `low`-confidence delta goes to Attention for
  human disposition, never auto-recorded.
- **Explicitly withheld:** any `EvolutionProposal`-mint, any direct `MEMORY.md`/`CLAUDE.md`/
  `STANDARDS-REGISTRY.md`/`preferences.json` write. A by-construction test pins ZERO of these
  under autonomy ON.

**The two arms have two different authorities** (codex X2 / adversarial A8): the **standards arm**
is ratified ONLY by the operator (needs-user Initiative disposition, `owner:user /
blockedOn:user-authorization`). The **process arm** is ratified by **PR review** (the build ships
through the normal `/instar-dev` gate). A shipped build ratifies **only the process arm**, never
the standards arm — "build shipped" can never close a class-review whose standards question is
unresolved. While the meta-rule itself is in dry-run/soak, a class-review-minted Action requires
an operator disposition before it is eligible to build.

### 3.5 The instance-fix gate — bound to CORRESPONDENCE, not mere existence

The meta-rule's teeth: an Evolution Action / commitment tagged as an instance-fix-for-correction
carries `classReviewRef`, and the creation/advance path refuses it unless a **matching** ClassReview
exists **from live state**. "Matching" means **correspondence, not existence** (security S3): the
`classReviewRef` must equal the `dedupeKey` of the correction that actually motivated the fix
(carried through from the correction record — auto-stamped at fix-Action creation, §3.6/FD-D, not
left to agent discretion), and that ClassReview must be a real authored row (not a dry-run stub).
This forecloses the decoy-correction dodge (mint a throwaway correction → staple its ref onto an
unrelated fix).

**Gate granularity — v1 checks the shell for the motivating `dedupeKey`** (codex-r5): the v1 gate's
guarantee is "a class-review was *attempted* for the phrasing that motivated this fix" — it verifies
the ClassReview shell keyed on that `dedupeKey` exists (and, in enforce mode, is `filled`).
**Because every `dedupeKey` retains its OWN resolvable shell regardless of any §3.8 semantic collapse
(F3), this per-`dedupeKey` lookup ALWAYS resolves** — collapse re-points `semanticClassId` and
dedupes only the downstream outcome, never the row the gate reads. Verifying
the broader *semantic-class outcome state* (has the `semanticClassId` this shell attached to actually
reached a resolution?) is a stronger check that belongs to the out-of-scope enforce/block phase
(FD-C), not v1 — so the spec does not over-claim closure the v1 gate doesn't verify.

**Honest scope (soften "impossible to hide"):** the gate enforces *that a class-review artifact
was produced for the referenced class*; the operator's ratification is the real authority. Only
Actions/commitments explicitly tagged `origin: correction` are gated (over-scoping would block
unrelated work — Q-D). Cross-machine: the gate reads the **unified** ClassReview (§10); when a
peer is dark it **fails toward allow-with-audit** (a hard block on a peer-held artifact would
strand real work — reachability-wins). Ships dry-run first (logs would-refuse); the enforce flip
is the operator's (§Frontloaded).

**Honest guarantee — "a class-review was ATTEMPTED before the fix," not "reviewed"**
(codex-r4): record-time firing (§3.1) guarantees a review *attempt* precedes any later fix; the
enforce gate cannot guarantee the LLM *completed* the review, because a provider outage can
dead-letter it. That honest scoping matters for the two fail-open branches below.

**Fail-direction is uniform: a review the agent could not complete never blocks the fix**
(adversarial NEW-1 / lessons-aware N3 / decision-completeness). Enforce mode requires the verdicts
*filled* — BUT a **`dead-lettered`** ClassReview (verdicts a provider outage prevented from ever
filling, §3.7) **fails toward allow-with-audit**, exactly like the dark-peer branch. A transient
off-Claude outage must never strand a legitimate `origin: correction` fix. To stop a dead-lettered
allow from becoming a **permanent bypass** (codex-r4), every dead-lettered ClassReview opens **one
visible follow-up item** (owner:agent — retry the review when the provider recovers), so the loop
is tracked, never silently dropped. The only state that hard-blocks in enforce mode is a
genuinely-absent review (no shell at all) — which record-time firing makes near-impossible and the
daily backstop closes. **Table:** shell `filled` → gate satisfied; shell `pending` (verdicts still
filling) → enforce-blocks / dry-run-allows; `dead-lettered` → allow-with-audit + a tracked retry
follow-up; no row at all → block (enforce) with the loud "no class-review for this class" reason.

### 3.6 Deliberate terminal state, aging, reopen, supersede (Close the Loop — both directions)

- **`resolved` (true terminal) requires a real outcome on each arm** (§3.3): `ratified`/`shipped`
  (the correction improved the system), `no-action` (a `covered`/`not-applicable` arm — nothing was
  warranted), or an **explicit operator `rejected`** (a logged decision that no standard/process
  change is warranted — a durable decision, loop genuinely closed). Only these close the loop.
- **`deferred` is NOT a terminal close — it is parked-open WITH a tracked follow-through**
  (conformance-gate round 4, *No Deferrals*): an operator "defer / revisit later" disposition does
  NOT close the correction loop, because a deferral without tracked follow-through is exactly the
  *No Deferrals* violation. A `deferred` outcome opens a **tracked revisit commitment** (owner:agent
  drives the re-surfacing) and the loop stays OPEN in backlog-health until it later reaches
  `ratified`/`shipped`/`rejected`/`no-action`. `deferred` (revisit later) and `rejected` (decided
  against) are thus distinct: only the latter is a terminal close.
- **`expired-unreviewed` is a PARKED-OPEN state, NOT a durable close** (adversarial A9 / codex-r2 /
  conformance-gate round 4 — resolving the *Never-Waste Feedback* / *No Deferrals* tension): when a
  `proposed` outcome sits unactioned past a window (default: mirror the commitment-overdue cadence,
  D13) it moves to `expired-unreviewed` with **one coalesced** operator heads-up (P17) — this stops
  the *pipeline* from re-spawning LLM work every tick and stops the nagging, but it is **explicitly
  NOT a resolution**: the correction's loop stays **OPEN** in `/metrics/features` backlog-health,
  keeps re-surfacing on a slow cadence (Close the Loop), and can `reopen` at any time. A correction
  can therefore NEVER reach a "durable but non-improving end" by inaction — it either improves, gets
  an explicit operator decision, or stays visibly parked-open until one of those. `expired-unreviewed`
  (operator never looked) is thus a DISTINCT, non-terminal state from an explicit human `deferred`
  (operator looked and chose not-to).
- **Process arm → `shipped` transition** (adversarial NEW-6 — the Close-the-Loop wiring): a
  `processOutcome` reaches `shipped` when its minted Evolution Action completes (or a merged PR that
  references the `classReviewRef` closes it). While that linked Action is `in_progress`, the aging
  timer is **suspended** — so a process delta whose build genuinely shipped is never mis-aged to
  `expired-unreviewed`. (Without this the A8 split-outcome fix couldn't actually close its process
  half.)
- **Reopen** (adversarial A12): a `rejected`/`deferred` ClassReview may `reopen` on a recurrence
  spike on the same `dedupeKey` or explicit operator reopen — the dedupeKey idempotency does not
  permanently silence a once-rejected class.
- **Supersede** (security S8): `superseded` is an **explicit, audited** transition — set by the
  operator OR by a deterministic same-`dedupeKey` rule — **never LLM-decided**; a superseded review
  stays visible with a link to its supersessor (an injected follow-up can't bury a pending review).
- **Rows are terminal-RETAINED, never evicted** (integration N2): a ClassReview row is the audit
  trail AND the artifact the instance-fix gate reads from live state, so rows are **never deleted or
  aged-out** — which means no tombstone kind is needed for the replicated store (the gate always
  resolves; there is nothing to resurrect). The "size/age cap or rotation" of §6-S6 applies **only
  to `logs/completion-claim-audit.jsonl`**, never to the ClassReview store.

### 3.7 Bounding, brakes, and self-action convergence (No Unbounded Loops P19 + Capacity Safety)

- **Per-tick ceiling** `maxReviewsPerTick` (overflow re-picks next sweep; mirrors `maxRoutesPerTick`).
- **Backoff + breaker + dead-letter** (lessons-aware LML4): a per-`dedupeKey` `attemptCount` with
  exponential backoff; after N failed reviews (provider persistently down, or output that never
  parses for that record) the record is **dead-lettered** and surfaced ONCE (Self-Heal-Before-Notify;
  §6). Not retried-every-tick-forever.
- **Standing cap on OPEN class-review-originated artifacts** (adversarial A4): a ceiling on the
  number of open class-review Initiatives/Actions; at the ceiling, new proposals coalesce onto
  existing ones (§3.8) or hold. Backlog depth is surfaced in `/metrics/features` and alerts once at
  a threshold.
- **Self-action controller** (Capacity Safety): the class-review's Initiative/Action minting is a
  self-triggered cost-bearing action → registered in `SELF_ACTION_CONTROLLERS` with a
  `self-action-convergence.test` proving the open-artifact count settles under sustained pressure
  (corrections arriving faster than reviews close).
- **Supervision** (P7 / LM12): the sweep job declares `supervision: tier1`. The **LLM class-review
  call itself is the supervising intelligence** (a reasoning step over the correction, not a
  deterministic script); the enum/schema validation of its structured output (§3.2) is the
  after-every-step validation Tier-1 mandates. (This is not "a deterministic validator standing in
  for an LLM supervisor" — the supervisor IS the LLM judgment; the schema check is the guardrail
  on it — clarified after the conformance gate flagged the wording.)

### 3.8 Near-duplicate semantic collapse (the "one durable OUTCOME per CLASS" invariant, made true — per-`dedupeKey` shells preserved, F3)

`dedupeKey` collapses **exact** normalized-summary matches (so the *same* correction on two machines
→ one review — good for cross-machine dedup, §3.9). It does **not** collapse near-duplicate
*phrasings* (§0). To make "one durable outcome per CLASS" true (lessons-aware LB1 / adversarial A5 /
scalability P5 / integration M4):

- **`semanticClassId` is modeled, not emergent** (codex-r2): the ClassReview carries a
  `semanticClassId` distinct from `dedupeKey` — so "one durable outcome per CLASS" is a first-class
  field, not an emergent property of an LLM's per-call whim.
- **Bounded candidate selection before the LLM — a specified algorithm** (codex-r2/-r3 — avoid O(N)
  prompt growth): collapse runs a cheap deterministic candidate pre-select FIRST: (1) exact
  `standardRef` index hit, else (2) a normalized-token **Jaccard** similarity over open proposals'
  summaries, taking the **top-K (K = 5)** by score; the judge-by-meaning LLM then **adjudicates only
  those K** ("is this the same class as candidate X?", structured yes/no + the matched
  `semanticClassId`). The LLM never scans the whole open set. `semanticClassId` is **immutable once
  assigned** (an attach points a new shell at an existing id; it never rewrites an assigned one); a
  tie in candidate scoring is broken toward the **oldest open proposal** (deterministic).
  The candidate-recall step is a swappable primitive: **Jaccard is the auditable baseline; SQLite
  FTS5/BM25 or an embedding ANN index is an equally-acceptable v1 implementation** of the same
  contract (LLM-adjudicates-top-K + conservative-no-collapse) — the builder picks by measured recall,
  the spec does not mandate the primitive. A Jaccard/recall miss fails SAFE (a redundant review, never
  a wrong merge — the floor is "on uncertainty do NOT collapse"). Because a redundant review still
  costs a little operator/process load, the soak tracks a **duplicate-fragmentation rate** (distinct
  `semanticClassId`s that a human later merges) in `/metrics/features` (codex-r5) — the empirical
  signal for whether the recall primitive needs upgrading from the baseline.
- On a match, the new correction's shell **attaches to** the existing open proposal's `semanticClassId`
  (adding an observation, §3.1) instead of minting a duplicate OUTCOME — the per-`dedupeKey` shell the
  §3.5 gate reads is never removed, superseded, or clobbered (F3); only the downstream Initiative/Action
  dedupes per `semanticClassId`. **Floor: on uncertainty, do NOT collapse** — a redundant review is
  safer than a wrongly-merged class.
- Proposals additionally dedup on `standardRef`: two open proposals targeting the same standard
  collapse to one.
- The backlog drain therefore emits **one aggregated operator-facing item carrying the count + the
  list** (P17 / `notification-flood-burst-invariant.test`), never one Initiative per correction.

### 3.9 (Multi-machine specifics are consolidated in §10.)

---

## 4. Mechanism 2 — Verify-Before-Done (the un-descoped A2)

### 4.1 The generalization

*Bug-Fix Evidence Bar* covers fixed/wired/working; the Action-Claim Sentinel covers FUTURE claims.
**Neither covers a completion ASSERTION** — including the present-continuous "in-progress asserted
as effectively done" that the founding incident ("getting Codey his assignment **now**") actually
is. Mechanism 2 is the structural detector for that class; §8.2 proposes the generalized standard.

### 4.2 The detector — one deterministic-prefiltered, fire-and-forget, structured call

**Boundary with the Action-Claim Sentinel is by ASSERTION-TYPE, not grammar, and enforced by a
SHARED arbiter** (adversarial A1 / A13 / NEW-5): the distinction is **commitment-to-act** (future —
Action-Claim's job: opens a follow-through commitment) vs **asserted-current-fact** ("it's done /
I'm handing it off now / it's live" — this detector's job). Disjointness is **architected, not
merely asserted**: the two sentinels do NOT run two independent classifiers on the same clause.
Server-side, a **single clause-labeling classification pass** assigns each clause to **at most one**
of `{future-commitment, completed-or-in-progress-assertion, neither}` and **routes it to exactly one
downstream sentinel** — a completion clause suppresses any Action-Claim commitment on that same
clause, and vice-versa. **Fleet-safety invariant (F1 — the suppression arm is gated on the
completion detector being LIVE):** the completion→suppress-Action-Claim arm takes effect ONLY where
the completion detector is actually **enabled-and-enforcing**; whenever completion detection is
dark / disabled / dry-run — which is its fleet default (§11) — that arm is **INERT** and the shipped
Action-Claim Sentinel's behavior is preserved **byte-for-byte**. This matters because the LIVE
`classifyActionClaim` (`src/core/action-claim.ts`) ALREADY fires on present-progressive first-person
clauses ("I'm deploying it now", "Pushing it now"); if the arbiter suppressed those into a dark
detector the fleet would silently REGRESS a live feature. So the §4.2 either/or routing resolves in
the fleet-safe direction: **the completion arm may claim a clause away from Action-Claim ONLY once
the completion detector is live and can actually act on it** — until then Action-Claim runs exactly
as it does today. The shared arbiter checks the completion detector's live/enabled state (never
merely its constructed presence) before suppressing, and fails toward NOT suppressing on any
uncertainty. Concretely: the new completion-observe route and the existing
`/action-claim/observe` route consult the one shared classifier (either a unified route both hooks
feed, or the completion route's classifier is authoritative and its per-clause labels gate the
action-claim commitment). Labeling is at **clause granularity, not message granularity** (codex-r5):
a mixed message like "I pushed X and will deploy Y" splits into a completion-clause ("pushed X" → this
detector) AND a future-commitment-clause ("will deploy Y" → the action-claim sentinel), each routed
independently — so the shared arbiter does not SUPPRESS a legitimate second clause, it just prevents
TWO sentinels firing on the SAME clause. §9's disjointness test exercises the **shared** path (an
ambiguous single clause like "getting X now" yields exactly one sentinel firing) AND a
**preservation** test pins that existing future-commitment ("I'll deploy Y") behavior is unchanged —
NOT each hook in isolation.

Pipeline (scalability P1/P2):

1. **Deterministic candidate pre-filter — client-side in the hook, BEFORE TurnEvidence
   construction** (scalability P1 / R3-SCAL-1): the hook runs a high-recall, drop-only pre-filter
   (mirrors `classifyActionClaim`) over `last_assistant_message` (already in the Stop payload)
   FIRST; it may only DROP a no-completion-shape turn toward pass-through, never DECIDE a positive
   (Intelligence Infers / Intelligent Prompts — the LLM remains the authority on candidates). Only a
   turn that PASSES the pre-filter proceeds to build `TurnEvidence` (§5) — so the tail-read +
   extractors run on the ~5–20% of turns that survive, not on every turn. ~80–95% of turns never
   reach either the transcript parse or the LLM.
2. **One fused structured LLM call** on a candidate: classify (`{ assertsCompletion, claimText?,
   actionKind, completionScope }`, `actionKind` a **closed enum** `sent|deployed|handed-off|
   committed|pushed|merged|restarted|fixed|other` — D11) AND corroborate against `TurnEvidence`
   (§5) per the §4.3 decision table, emitting `{ corroborated, verdict, basis, corroboratingToolCall? }`.
3. **Fire-and-forget siting** (P2): the hook POSTs `{message, structured-TurnEvidence, clause-labels}`
   and `exit(0)` **immediately** — never awaits the verdict (v1 never blocks — §4.4), so the LLM runs
   async server-side and adds **zero** latency to turn-completion. (It never blocked the
   user-visible reply either way — the Telegram relay runs mid-turn.)

### 4.3 Corroboration judged on SPECIFICITY; the honest limit; the named false-positive class

- **Specificity, not mere presence — deterministic match first** (adversarial A6 / codex-r2 #4):
  corroboration requires a tool call whose extracted `targetSummary` (§5) **actually names the
  claimed object** (a `git push` of the claimed branch; a `send-keys` to the *named* pane), not
  merely `hadToolCalls && ok`. For a **known `actionKind`** the object↔tool-call correspondence is a
  **deterministic match** (`actionKind: pushed` + claimed branch `foo` ↔ a `git push` extractor with
  `branch: foo`), not an LLM inference — so a decoy `echo done` cannot manufacture corroboration.
  The LLM adjudicates only the residual ambiguous cases (an unusual phrasing, an `actionKind: other`)
  where deterministic matching is inconclusive.
- **A trace corroborates; it does not PROVE** (Verify the State, Not Its Symbol): a `send-keys` ran
  ≠ Codey received it. So the detector is a **signal that fails toward NOT flagging** (precision
  over recall) — an un-flagged claim that was actually fine is the SAFE direction; a nagging
  false-flag is the SCARRING direction.
- **Named false-positive class — multi-turn / background completion** (lessons-aware LML7 /
  adversarial A7): a completion legitimately reported in a *later* turn ("did it land?" → "yes, it's
  live"), or a truthful narration of a **server-side/background** outcome (a job posted; the
  class-review ran) has **no this-turn client tool call** — so it must NOT be scored un-corroborated.
  The classifier emits `completionScope: this-turn | prior-turn | background`; only
  `this-turn`-scoped assertions are eligible to be flagged. This carve-out is a **precondition** on
  any future graduation to a would-block (§4.4).
- **The explicit flag/not-flag decision table** (adversarial NEW-2 — resolving the decoy-vs-unknown
  contradiction). The verdict is a deterministic function of (`actionKind` known/other) × (a matching
  extractor's evidence present/absent) × `completionScope`; the LLM only adjudicates the
  `actionKind: other` residual:

  | completionScope | actionKind | matching evidence | verdict | note |
  |---|---|---|---|---|
  | this-turn | known (pushed/merged/…) | present + names the object | **corroborated** (not flagged) | the happy path |
  | this-turn | known | absent / names a different object | **flagged `uncorroborated-contradicted`** | the founding mode: "I pushed X" with no push-of-X — the decoy `echo done` lands HERE |
  | this-turn | other | (no deterministic matcher) | LLM adjudicates; if inconclusive → **not flagged**, recorded `uncorroborated-unknown` | can't judge → don't accuse (safe) |
  | prior-turn / background | any | any | **never flagged** | the carve-out above |

  This resolves the §5 "unknown tool → {tool,ok} → not-flag" vs §9 "decoy `echo done` must not
  corroborate a pushed-branch claim" tension: an **unknown TOOL** (no extractor) can't *corroborate*,
  but a **known actionKind with no matching evidence** is *flagged* — the decoy case is the latter,
  because `pushed` is a known action and there is no `git push` of the named branch. `echo done`
  being present is irrelevant; it is not a push.
- **Authoritative signals beat tool traces where they exist** (codex-r3 C3-3, tracked follow-up): for
  known actionKinds the deterministic extractor already reads the authoritative local signal (the
  actual `git push` result, the actual exit status). A fuller **authoritative-verifier registry**
  (CI/deploy APIs, queue/message ids, supervisor state) is a tracked v2 enhancement for the
  out-of-scope block phase (§4.4/FD-C) — not v1, which is observe-only over the tool trace.

### 4.4 It does not block (v1); graduation measures BOTH error directions

v1 is **observe-only**: it records to `logs/completion-claim-audit.jsonl` (scrubbed — §6-S6) with
the denominator (turns evaluated) so rates are computable. It never blocks or rewrites a send. The
audit **segments the un-corroborated verdicts** (codex-r3 C3-4) into `uncorroborated-contradicted`
(a known actionKind whose evidence is absent/wrong — the real over-claim signal) vs
`uncorroborated-unknown` (an `other` actionKind or unknown tool the detector genuinely couldn't
judge — recorded but never an accusation), so the false-NEGATIVE measurement isn't diluted by
un-judgeable cases. Any future blocking authority lives in the full-context response-review/tone-gate
(Signal vs. Authority), decided AFTER a measured soak — and the soak must measure the
**false-NEGATIVE** rate too (adversarial A6 / codex X4): seed the audit with known over-claim
fixtures (a decoy tool call present) and require the detector to catch them as
`uncorroborated-contradicted`, because the founding failure mode is precisely an over-claim with
weak evidence — graduating only on a low false-positive rate graduates blind. **The
enforcement/block phase is OUT OF SCOPE for this spec** (its own future spec + operator decision,
fed by the measured rates — Q-C).

### 4.5 Framework scope (Framework-Agnostic — declared + tested no-op)

`TurnEvidence` reads the Claude-Code session transcript, so the completion detector is
**Claude-Code-scoped**; on other frameworks it is a **declared, unit-tested no-op**
(`TurnEvidence.unavailable` → detector no-ops), never a silent assumption (conformance-gate G1). A
codex/gemini transcript-trace equivalent is a tracked follow-up (FD-E). The class-review
(Mechanism 1) is framework-agnostic — it runs on `scrubbedSummary`, no transcript.

---

## 5. The `TurnEvidence` primitive (resolves CMT-1554 — structural-only, scrubbed, jailed, tail-bounded, canaried)

Claude Code's Stop-hook payload includes **`transcript_path`** (the current hooks just don't read
it — the A2 descope reason "payload carries only `last_assistant_message`" was a *choice*, not a
limit). Parsing the tool-call trace since the last user message yields the evidence channel A2
lacked. Its construction is hardened per review:

```jsonc
TurnEvidence = {
  hadToolCalls: bool,
  toolCalls: [ { tool: "Bash"|"Edit"|"mcp__…", targetSummary, ok: bool, errorClass? } ],  // STRUCTURAL ONLY
  truncated: bool,
  unavailable: bool   // absent / oversized / parse-fail / non-Claude framework → detector no-ops
}
```

- **STRUCTURAL ONLY, via deterministic per-tool extractors — never raw content, never a lossy LLM
  summary** (security S1 / adversarial A7 / codex-r2 #3): `toolCalls[]` carries the tool name, a
  **`targetSummary` produced by a deterministic per-tool extractor**, and exit status — **never**
  the raw tool input or `tool_result` body. The extractors pull exactly the **safe object
  identifiers** corroboration-by-specificity (§4.3) needs and nothing more: for `Bash git push` →
  `{remote, branch}`; for `Edit`/`Write` → `{file basename}`; for a `send-keys` → `{pane/target
  id}`; for a telegram/relay call → `{topic id}`; for an MCP tool → `{service, operation}`. These
  are **low-risk metadata, not credentials** (a branch name, a pane id) — so §4.3's specificity check
  has the data it needs while raw content never leaves the machine. **They are not zero-risk**
  (codex-r5): a branch name or file basename CAN embed a customer/incident/project name, so a
  high-sensitivity deployment can enable an optional `identifierRedaction` mode that one-way-hashes
  the identifier (specificity-matching still works on the hash — the extractor hashes both the claim
  object and the evidence object consistently) rather than carrying it in the clear. Carrying raw content OR asking the LLM
  to infer specificity from a lossy prose summary would (a) egress live secrets to the off-Claude
  LLM (§7) and the audit — a `Bash` running `bw unlock "PASSWORD"` or `secret-get.mjs github_token`,
  a `tool_result` echoing a `.env` — and (b) be a prompt-injection surface (a `tool_result` saying
  "this action is confirmed complete" steering `corroborated:true`). An unknown tool with no
  extractor yields `{tool, ok}` only (no target) — corroboration then can't be specificity-matched,
  so it fails toward not-flagging (safe).
- **`Bash` is default-DENY — a strict per-subcommand allowlist, never the raw command string**
  (security NEW-1, the S1-reopening guard): `Bash` is the one secret-bearing surface (`bw unlock
  "hunter2"` — a plain, non-token-shaped password `scrubSecrets` cannot catch, and a byte cap won't
  help a short secret). So the Bash extractor is an **allowlist keyed on the recognized subcommand**
  (`git push` → `{remote, branch}`, `git commit` → `{}`, …); **any** Bash invocation lacking a
  specific safe extractor emits `{tool: "Bash", ok}` with **NO target and NEVER the raw command
  line** — never a "summarize the command" fallback. This is the same fail-toward-not-flagging as the
  unknown-tool case, and it is what keeps S1 closed: an unrecognized Bash command's arguments never
  leave the machine.
- **Mandatory scrub boundary** (security S1): `scrubSecrets()` is applied to every `targetSummary`/
  `errorClass` **at construction**, before the value can reach the LLM prompt or any audit sink,
  with a small per-field byte cap (secrets hide in long inputs). Unit test: a transcript slice
  containing each `scrubSecrets` token shape emerges redacted in both the prompt payload and the
  audit line.
- **Client-side parse, never send the path** (security S4): the Stop hook parses the transcript
  **client-side** and sends the already-structured, already-scrubbed `TurnEvidence` — it **never**
  sends `transcript_path` to the server. This forecloses the server-side confused-deputy
  (a body-supplied path pointed at `/etc/passwd` or another agent's transcript).
- **Bounded TAIL read — O(1) in transcript size** (scalability P3): the last-turn slice sits at EOF
  of an append-only JSONL that reaches **19MB on this host**, and a forward/full read on the shared
  event loop is the instar#1069 starvation class. So: seek to `fileSize − K` (K ≈ 512KB), scan
  forward parsing only complete lines, locate the last user-message boundary; a turn exceeding K
  sets `truncated:true` and corroborates on the partial tail (corroboration only needs to see the
  one relevant successful tool call). Cap by **bytes read** (constant), not entries. (Client-side,
  this doesn't touch the server event loop at all — a second reason for the client-side parse.)
- **Canary + drift** (lessons-aware LML8 / L5): a positive-control fixture (a known real transcript
  slice with a known tool call) is parsed at boot/test; if the parser returns `unavailable`/empty on
  the canary, a **drift signal fires once** — a Claude Code JSONL format change can't silently turn
  the whole detector into a permanent no-op.
- **Transcript reality** (codex X3): the parser handles tool_result entries that are async /
  truncated / retried / emitted after assistant text, and associates a claim with a specific tool
  call by target match (§4.3), not position.

---

## 6. Security & privacy (the injected-correction + secret-egress surface)

The authority-bounding-by-construction (§3.4) genuinely holds against **enactment** (security
review CONFIRMED: no auto-write of any authority). The real residual risks are **secret egress**
and **operator-facing framing**, addressed here:

- **S1/S5 scrub before any LLM egress.** The class-review reads `scrubbedSummary` ONLY, never
  `learning` (the longer, higher-residual-risk field; `scrubSecrets` is best-effort, and §7 routes
  off-Claude to a third-party CLI). `TurnEvidence` is structural-only + scrubbed (§5). Re-run
  `scrubSecrets` at the egress boundary as defense-in-depth regardless.
- **S6 audit hardening.** Both `logs/completion-claim-audit.jsonl` and the ClassReview store scrub
  every field before write, `mode:0o600`. The **size/age cap or rotation applies ONLY to the audit
  jsonl** — the ClassReview store is terminal-retained, never evicted (§3.6/integration N2), so it is
  never rotated (that would starve the instance-fix gate of a legitimately-referenced row).
- **S2 injection framing.** LLM-authored `proposedDelta`/`standardRef` render inside an
  untrusted-data envelope + provenance banner on every operator surface; `isPolicyRelaxation` is a
  by-meaning judgment (not a regex); the Initiative carries the originating `correctionId`.
- **S10 route auth.** The new routes — `GET /class-reviews` (read-only, `toApiView`-scrubbed,
  `?status=` filter, bounded limit) and the completion-observe write (carries `X-Instar-Request:1`
  like `POST /corrections`) — land under the global bearer gate, NOT any exempt prefix.
- **S9 inert Action.** Class-review-minted Actions are surface-only, `origin: correction`, excluded
  from every autonomous-execution consumer; pinned by test.

---

## 7. Intelligence routing, cost, and failure (No Silent Degradation / Bounded Blast Radius / Token-Audit)

- Both LLM calls route through the shared `IntelligenceProvider` (spawn-cap funnel —
  `buildIntelligenceProvider`), inheriting the host concurrent-spawn ceiling and per-component
  framework routing (default off-Claude: `reflector`/`gate`). Both carry
  `attribution.component` (`correction-class-review`, `completion-claim-verify`) so
  `/metrics/features` + usage-coverage are not audit-blind (Token-Audit Completeness / LM10).
- **Class-review** (reflector, proposal): on provider failure it **fails toward NOT producing a
  review** (record stays un-reviewed, retried under backoff, dead-lettered after N — §3.7). Never
  fabricates a delta; no brittle keyword fallback.
- **Completion** (signal): on provider failure or unavailable `TurnEvidence` it fails toward
  **not-flagging** (do-not-accuse). No brittle keyword fallback.
- **Per-turn cost** is bounded by the deterministic pre-filter (§4.2 — ~80–95% of turns never call
  the LLM) + fire-and-forget (off the turn path) + the fused single call on candidates. The
  completion audit grows at the **flag** rate (only un-corroborated this-turn claims), not the turn
  rate.
- **Standard index** passed to the class-review is the bounded list of standard *titles* (D12), not
  the full registry — no token-budget/spawn-cap pressure.

---

## 8. Standards deltas this spec proposes (into the amendment loop — operator ratifies)

Surfaced as PROPOSALS (not self-ratified) — the class-review outputs for the drive's own founding
corrections:

1. **"Every Correction Is a Durable Outcome"** *(sharpens Never-Waste Feedback).* A single
   operator correction MUST produce a durable outcome — a class-review + a recorded terminal outcome
   (a standard delta proposed, a tracked build action, OR an explicit logged decision-not-to).
   Recurrence-gating remains ONLY for noisy auto-preference distillation. *Earned from: 2026-07-19,
   24 `open` corrections producing zero durable outcome, incl. Justin's own three notes.*
2. **"Verify Before You Claim Done"** *(generalizes Bug-Fix Evidence Bar).* Extend the evidence bar
   from fixed/wired/working to EVERY completion assertion (done/sent/handed-off/**getting-done-now**/
   deployed/live). A this-turn-scoped completion assertion SHOULD be corroborated by the turn's own
   evidence; an un-corroborated one is a signal, fail-toward-not-flagging, blocking authority (if
   ever) only in the full-context gate and only for this-turn-scoped claims. **The *principle* is
   universal (an agent should not claim done before verifying); the *automated signal* only operates
   where a verified `TurnEvidence` equivalent exists** (Claude Code today — §4.5), and the standard
   must not imply automated coverage broader than the primitive supports (codex-r4). *Earned from:
   2026-07-19, "getting Codey his assignment now" asserted before the dispatch channel was
   verified.*

(Issues 2 & 3 from `.instar/drive7-class-reviews.local.md` — the grounding-guard false-positive and
the mentor→mentee reachability standard — are class-reviews for OTHER corrections and route to the
backlog; not part of this WS1 build.)

---

## 9. Testing (Testing Integrity Standard — all three tiers)

- **Unit.** Class-review: enum-schema validation; independent verdicts; `not-applicable` produces a
  terminal row with ZERO Initiative/Action; `low`-confidence → Attention; the by-construction
  authority test (ZERO proposals/memory writes; `needsUser` override rejected); origin segregation;
  near-dup semantic collapse; backoff/breaker/dead-letter; standard-index bounded to titles.
  Completion: the deterministic pre-filter drops no-claim turns; the fused structured call;
  corroboration-by-specificity (a decoy `echo done` does NOT corroborate a "pushed branch X" claim);
  `completionScope` carve-out (prior-turn/background never flagged); disjointness (one clause ≤1
  sentinel). `TurnEvidence`: structural-only + scrub redaction (each token shape) + bounded tail
  read on a 19MB fixture + fail-open on absent/oversized + the **canary** drift-fires-on-format-change.
- **Integration.** `POST /corrections` (operator-attributed) → a ClassReview row appears (dry-run:
  logged, not created) with correction.status **unchanged**; `GET /class-reviews` serves scrubbed
  rows; the instance-fix gate refuses an Action whose `classReviewRef` does NOT correspond to a real
  authored ClassReview for its motivating correction (would-refuse in dry-run) AND is not fooled by a
  decoy correction; the completion route records a scrubbed would-flag with the turn-denominator.
- **E2E (acceptance demo = WS1-3) — STRUCTURAL, not LLM-prose** (adversarial A11 / lessons-aware
  LML6): feed the REAL founding correction; assert (a) a ClassReview row exists and **precedes** any
  instance-fix action (ordering — the meta-rule's real claim); (b) `standardReview.verdict ∈
  {needs-upgrade, new-standard-needed}` with a `standardRef`, `processReview.verdict = process-gap`
  → a tracked Action — via deterministic schema/enum check, with a **stub/replayed provider** for
  any exact-content assertion so CI isn't at the mercy of live-model wording; (c) a **garbage**
  correction closes `not-applicable` with ZERO Initiative/Action. Plus the "feature is alive"
  200-not-503 test for the new routes.
- **Wiring integrity.** Every injected dep on `CorrectionClassReview` is non-null and delegates to a
  real implementation. `self-action-convergence.test` proves the open-artifact count settles under
  sustained correction pressure.

---

## Multi-machine posture (P21 — An Instar Agent Is Always a Multi-Machine Entity)

*(Heading deliberately un-numbered so `lint-machine-local-justification.js`'s `POSTURE_SECTION_RE`
scopes the marker-contract checks to this section — integration reviewer note.)*

machine-local-justification: hardware-bound-resource

| Surface | Posture | Mechanism / justification |
|---|---|---|
| **ClassReview store** | **`unified`** | A new `multiMachine.stateSync.classReview` kind keyed on the machine-independent `dedupeKey`, replicating **only** scrubbed fields + verdicts + outcomes + status (raw `learning` NEVER crosses the wire). Makes the instance-fix gate correct cross-machine (M3), dedupes proposals fleet-wide → one Initiative per class (M4), inherits CoherenceJournal durability/backup (M10). Ships dark + dryRun-first. **See the merge/hardening/coherence rows below.** |
| **ClassReview merge rule** | **lifecycle-MONOTONIC, single-writer per transition** (NOT the relationships PII no-clobber) | A ClassReview is a monotonic lifecycle record, not a PII value, so the PII no-clobber/preserve-both rule is WRONG for it (adversarial NEW-4 / lessons N1): **create-if-absent; `fillState` advances `pending→filled` first-writer-wins (a second machine's fresh `pending` shell NEVER regresses or conflicts with an already-`filled`/advanced row — it no-ops)**; outcome transitions (`ratified`/`rejected`/`shipped`/`superseded`/`reopen`) are **single-writer** (the operator's machine at ratification time is authoritative — an amendment ratification is one operator act); `observations[]` increments are **additive/commutative** (CRDT-like, safe to merge). A same-`dedupeKey` correction on machine B thus never raises a spurious conflict nor clobbers machine A's ratified verdicts. |
| **ClassReview hardening + gate-consumption** | **enum-clamp on receive; replicated row satisfies the gate's EXISTENCE arm ONLY** | Every replicated enum/structural field is clamped to its closed set on receive (security NEW-2); LLM-authored text is `<replicated-untrusted-data>`-enveloped + scrubbed. Because the instance-fix gate CONSUMES this store (a stronger consumer than the display-only relationships precedent), a replicated ClassReview satisfies only the gate's **existence** check — its `ratified` status is **advisory** and NEVER substitutes for LOCAL operator ratification of a standards amendment. Rows are **terminal-retained, never evicted → no tombstone kind needed** (§3.6), so the gate always resolves. |
| **Coherence-manifest membership** | **register `classReview` in `COHERENCE_STATE_SYNC_STORES`** (8th coherence-critical store) | Integration N1: a new `multiMachine.*` `DEV_GATED_FEATURES` entry not in the coherence manifest fails `machine-coherence-manifest.test`. It is genuinely coherence-critical (a non-advertising peer silently dropping the kind reintroduces the M3 orphaning), so it belongs IN `COHERENCE_STATE_SYNC_STORES` with its guarantee string — NOT in `COHERENCE_MANIFEST_EXCLUSIONS`. |
| **Correction backlog / class-review sweep** | **run on EVERY machine** (not lease-holder-gated) over its own local ledger, writing to the unified ClassReview store | A correction captured on the standby machine must still be reviewed, or the orphaning bug returns cross-machine (M2). A bare "machine-local" backlog is unjustifiable under the closed taxonomy — an argument for the unified output. |
| **`completion-claim-audit.jsonl` + `TurnEvidence` + completion detector** | **`machine-local` BY DESIGN** · `machine-local-justification: hardware-bound-resource` | The Claude Code JSONL transcript physically lives on the disk of the machine that ran the session; a session runs on one machine at a time (precedent: `framework-permission-prompt-robustness.md` per-session pane state; `llm-decision-quality-meter.md` provenance rows). Pool-visible would-flag view is `proxied-on-read` (`?scope=pool`, redacted). |
| **`attemptCount` / `/metrics/features` keys** | **`machine-local`, NOT replicated; pool-view `proxied-on-read`** | `attemptCount` is per-machine backoff bookkeeping (excluded from the replicate-set so a provider outage's retries don't generate replication churn — scalability nit). Metrics inherit the `feature_metrics` posture. |

The `machine-local` surfaces carry the taxonomy marker so `scripts/lint-machine-local-justification.js --strict` passes; they are correct by design, not defects.

---

## 11. Deployment, migration, rollback, guards (Migration Parity + guard manifest)

- **Guard manifest** (M5): add `GUARD_MANIFEST` entries for the instance-fix gate (and the two
  mechanisms as applicable) with `criticalPath`, `soakWindowDays`, `declaredLoadBearingAt`. **On
  the fleet the guard is `dark-default` (quiet)** — the meta-rule mechanism isn't shipped-live
  there, so there is no unguarded critical path and no false `loadBearingGap` HIGH alarm. On the dev
  agent during `dryRun` it is `loadBearingSoaking` within the declared `soakWindowDays`; only once
  enabled+enforcing on the dev agent is a dark posture a genuine `loadBearingGap` (integration M5).
  The `loadBearingGap` alert is the *A Dark Feature Guards Nothing* forced-decision surface
  (graduate/accept) — explicitly exempt from Self-Heal-Before-Notify (no bounded self-heal for
  "operator hasn't graduated the feature") — LM11.
- **Hooks** (m7 — correcting the round-1 grounding error): add a `getCompletionClaimObserveHook()`
  getter in `PostUpdateMigrator.ts`; an always-overwrite `writeFileSync` block in `migrateHooks()`;
  a `getHookContent()` switch + type-union entry; an `init.ts` Stop-array registration (new agents)
  AND an **explicit** `migrateSettings()` Stop-array registration (existing agents —
  `.some()`-check + `push`, matching `action-claim-followthrough.js`). The hook **fails-open /
  no-ops when its route 503s** (the built-in hook is always-overwritten and can't be removed by
  config, so disabling the feature must leave it a silent no-op).
- **Config** (m8): OMIT `enabled` on `monitoring.correctionClassReview` and
  `monitoring.completionClaimVerification`; register BOTH in `DEV_GATED_FEATURES` (with a
  ≥12-char justification); `migrateConfig`/`ConfigDefaults` add only the non-`enabled` fields
  (`dryRun`, `maxReviewsPerTick`, windows). No hardcoded `enabled:false` (fails
  `lint-dev-agent-dark-gate.js`).
- **Coherence manifest** (integration N1): the new `multiMachine.stateSync.classReview`
  `DEV_GATED_FEATURES` entry MUST also be added to `COHERENCE_STATE_SYNC_STORES` in
  `src/core/machineCoherenceManifest.ts` (with its guarantee string) — NOT to
  `COHERENCE_MANIFEST_EXCLUSIONS` — or `machine-coherence-manifest.test` fails; it is
  coherence-critical (a non-advertising peer dropping it reintroduces the M3 orphaning).
- **CLAUDE.md awareness** (M6): add the section to `generateClaudeMd()` (new agents) AND an
  idempotent, content-sniff-guarded `migrateClaudeMd()` block (existing agents — Migration Parity
  item 3).
- **Dashboard** (m11): the ClassReview lifecycle (`proposed→ratified/rejected/deferred`) and the
  completion would-flag audit surface on the existing **Preferences dashboard tab** (already the
  corrections read surface), not curl-only (Agent Awareness).
- **Rollback** (m9): rollback is a **config flag flip** (`enabled:false` / `dryRun:true`), NOT hook
  removal (the hook stays installed, no-ops on 503). Because the class-review lifecycle is
  orthogonal to `correction.status` (§3.1), turning the feature off does NOT re-strand corrections
  in `open`. The `migrateSettings` Stop entry is not de-registered (migrations only add); the hook
  no-ops.
- **Backup/restore** (M10): the machine-local `completion-claim-audit.jsonl` joins the state backup
  manifest; the unified ClassReview store inherits the CoherenceJournal's durability.

---

## Frontloaded Decisions

- **FD-A — Class-review trigger siting = record-time (primary) + daily backstop sweep.** Fire
  synchronously at `POST /corrections` record time (server-side, unconditional, per-machine),
  writing the ClassReview row; a **daily** (not the weekly `correction-analyzer` cadence — P4)
  backstop sweep over corrections lacking a ClassReview row catches missed fires + the existing
  24-record backlog, on every machine, idempotent per `dedupeKey`. First-enable does a one-time
  higher-cap backfill so the founding demo isn't gated on steady-state cadence (c12). Acceptance
  criterion: **drain-rate ≥ arrival-rate.** *Reversibility: internal wiring behind dark/dry-run; no
  external side-effect — but a real architecture fork, so frontloaded.*
- **FD-B — Class-review input = `scrubbedSummary` ONLY (Q-B closed).** NOT the raw `learning`
  field — it egresses to an off-Claude third-party provider (§7), and the boundary discipline is
  "only scrubbed text leaves." *Durable external side-effect / data-handling → NEVER cheap; locked
  now.* If richer fidelity is ever needed, that is a separate, explicitly-gated decision behind a
  first-party-provider check.
- **FD-C — Completion-claim enforcement/block phase = OUT OF SCOPE (Q-C closed).** v1 is
  observe-only and never blocks. The would-block graduation is its own future spec + operator
  decision, fed by the measured false-positive AND false-negative rates from `/metrics/features` +
  the audit, and gated on the `this-turn-scope` carve-out (§4.3). *v1 ships behind observe-only, so
  v1 is cheap; the block phase (a user-visible interface change) is explicitly deferred, not left
  open.*
- **FD-D — Instance-fix gate scope = Actions/commitments tagged `origin: correction` only, tag
  auto-stamped (Q-D closed).** `origin: correction` + `classReviewRef` are auto-stamped at the point
  a fix Action is created from a correction record, not left to agent discretion (closes the
  self-tag dodge). Over-scoping to arbitrary PRs would block unrelated work. *Reversibility:
  internal-action-creation predicate behind dark/dry-run → cheap; frontloaded.*
- **FD-E — Cross-framework `TurnEvidence` = declared + unit-tested no-op (Q-E closed).** v1 is
  Claude-Code-only; non-Claude turns yield `TurnEvidence.unavailable` and the detector no-ops,
  asserted by test (§9). A codex/gemini transcript-trace equivalent is a tracked follow-up.
  *Additive, no external side-effect → cheap; frontloaded as declared+tested.*
- **FD-F — `actionKind` = closed enum** (`sent|deployed|handed-off|committed|pushed|merged|
  restarted|fixed|other`), consistent with the spec's enum discipline (D11). *Cheap; frontloaded.*

## Decision points touched

*(One decision point per line; the classification token is on each line — the structural gate flags any non-blockquote line lacking `invariant`/`judgment-candidate`.)*

- `instance-fix gate` (blocks Action creation, §3.5) — **invariant**: a deterministic correspondence + existence check on live state (`classReviewRef == motivating dedupeKey` AND a real authored ClassReview row exists) plus a deterministic `origin: correction` tag check; no meaning is weighed, a false refusal is never a judgment call (mirrors the apprenticeship doc-as-required-artifact gate); cross-machine fail-direction is fixed (dark peer or dead-lettered review → allow-with-audit).
- `class-review two-question judge` (§3.2) — **judgment-candidate**: floor = fails toward NOT producing a review (retried under backoff, dead-lettered after N), never fabricates a delta, authority-bounded to PROPOSE-ONLY, `low`-confidence routes to Attention; arbiter = operator ratifies the standards arm (needs-user Initiative), PR review ratifies the process arm.
- `completion-claim classification` (§4.2, completed-assertion vs future-commitment vs neither) — **judgment-candidate**: floor = deterministic client-side pre-filter may only DROP toward pass-through, the LLM decides positives, fails toward NOT-a-completion-claim; arbiter = the shared clause classifier routes to exactly one sentinel, and the response-review/tone-gate (never the detector) holds any post-soak block authority.
- `completion-claim corroboration` (§4.3, corroborated vs not — among competing signals) — **judgment-candidate**: floor = observe-only, fail-toward-not-flagging, do-not-accuse on unavailable `TurnEvidence`, `this-turn`-scope-only eligibility, the explicit decision table is deterministic for known actionKinds and never blocks in v1; arbiter = any future blocking authority lives in the full-context response-review/tone-gate, decided post-soak on BOTH error rates, NOT in the brittle detector.
- `class-review routing → Attention` (policy-relaxation / low-confidence, §3.4) — **invariant**: route-only, never blocks (a human dispositions it) so a mis-route is harmless, the `never-block` floor is explicit.
- `near-duplicate semantic collapse` (§3.8, is this the same class as an open proposal?) — **judgment-candidate**: floor = on uncertainty do NOT collapse (mint a distinct review rather than wrongly merge — the safe direction is a redundant review, not a lost class), bounded to deterministic top-K candidates; arbiter = the operator sees the aggregated item and can split/merge; the `dedupeKey` exact-match collapse underneath it is invariant.
- `ClassReview cross-machine outcome merge` (§10, concurrent ratify/reject/fill across machines) — **invariant**: lifecycle-monotonic single-writer transitions (fill = first-writer-wins, outcome transitions single-writer-authoritative, observation counts additive/commutative); a replicated row satisfies only the gate's existence arm and never substitutes for local operator ratification, so no cross-machine judgment is weighed.

## Open questions

*(none)*
