---
title: "Decision Replayability — an unreplayable decision is an unaccountable one"
slug: "decision-replayability-standard"
author: "echo"
status: "draft"
created: 2026-07-27
parent-principle: "Observability — you can't tune what you can't see"
sibling-principles: "Decision Provenance & Outcome Review; Observable Intelligence; Judgment Within Floors; Signal vs. Authority; Know Your Principal; Structure beats Willpower"
origin: "Operator directive, 2026-07-26 18:32Z: 'we tend to not record data for the sake of privacy. However, this is against the EXO 3.0 fundamentals which requires everything to be fully auditable. This is not a privacy issue. It's a safety and coherence issue and all the data needs to be recoverable so that the situation could be fully replayed and reevaluated.' Plus his 19:34Z follow-up asking me to decide the screenshot question."
eli16-overview: "decision-replayability-standard.eli16.md"
---

# Decision Replayability

> **The rule.** When an autonomous component makes a choice on the operator's behalf, the record
> must be sufficient to REPLAY that choice: what was on offer, what was picked, why, and enough
> surrounding state to re-evaluate it later. Recording only that a decision happened is not an audit
> trail — it is a receipt.

**How to read this document.** It states rules, not their history. What earlier drafts got wrong, and
why each rule is shaped as it is, lives in the convergence report
(`docs/specs/reports/decision-replayability-standard-convergence.md`). That separation is deliberate:
a spec that narrates its own review history grows its reviewable surface every round and cannot
converge.

## 0. Relationship to *Decision Provenance & Outcome Review*

This standard extends a ratified article rather than competing with it.

*Decision Provenance & Outcome Review* requires that every **LLM judgment call** durably log the
context it was handed and the decision it made — scrubbed, retention-bounded, machine-local-full /
HTTP-redacted — outcome-annotated and periodically graded. `src/core/JudgmentProvenanceLog.ts` is its
live implementation.

**The contribution here is one word: DETERMINISTIC.** A component deciding on the operator's behalf
owes the same record whether the decider is a model or a regex. The deterministic case arguably needs
it more: an LLM decision carries reasoning a reviewer can read; a pattern match leaves only "rule 7
fired."

Inherited verbatim, not re-derived:

| contract | value | source |
|---|---|---|
| retention | **14 days** | `JudgmentProvenanceLog` (`provenance.retentionDays`, default 14) — the sibling's real bound for CONTENT. The 30-day figure in *Observable Intelligence* governs metadata, which the registry distinguishes in kind because content carries disclosure risk. |
| read contract | machine-local-full / HTTP-redacted | *Decision Provenance & Outcome Review* |
| scrub-before-write | non-overridable | the credential-exposure wall |

Where the two articles appear to disagree, the sibling is authoritative and this one is the
deterministic-case extension.

## 1. The failure this closes

Components repeatedly narrow what they record, citing privacy. The clearest case is the
permission-prompt auto-resolver, documented as recording **"matched-pattern names only, never raw
pane text."** It presses a key on the operator's behalf and records only which regex matched.

That cannot be replayed. It cannot answer *what was I choosing between?*, *what else was offered?*, or
*would that choice still be right?*

**The operator's correction governs:** this is not a privacy question but a safety and coherence one.
A decision that cannot be reconstructed cannot be audited, and an unauditable autonomous decision is
unaccountable.

**Read precisely, because the sentence is load-bearing in one direction only.** It rejects privacy as
a reason to record *nothing*. It is not a licence to record *indiscriminately*, and reading it that
way would license exactly the overcapture §3 and §4 spend their length preventing. The operative
form: **auditability is mandatory, and it is implemented by minimization** — the smallest capture that
answers the audit question (§2.2), bounded region (§3), scrubbed, classified (§4), retention-bounded
(§0), machine-local (§6). Every one of those is a privacy control; none of them is optional; and the
standard is stricter for having them, not weaker.

## 2. The record

### 2.1 Field set

Fixed. Not per-component judgment.

| field | requirement |
|---|---|
| `matchedSpans` | For each pattern that contributed: its name AND the scrubbed text span it matched. **The load-bearing field** — see §2.2. |
| `observedOptionsDigest` | **An equality check over a NORMALIZED option model, not over raw screen text.** See §2.5 — digesting raw text would measure line wrapping, ANSI codes, and redraws, so it would fire constantly on presentation and prove nothing about drift. Keyed (HMAC-SHA-256, `digestKeyId`) because option labels are low-entropy and a bare hash of "1. Yes / 2. No" falls to a dictionary in seconds. A record carrying only the digest is NOT replayable and is `degraded` by definition. |
| `observedOptionsText` | The scrubbed choice set itself, where §3's region bound permits it. Where it does not, the record is `degraded` (§4) and the digest carries the drift signal alone. |
| `expectedOptionSchema` | What the matched rule expected to be offered, from authored data. **REQUIRED for any component whose patterns are authored** — a mismatch against the observed digest is the one purely mechanical drift signal available, and making it optional would make drift detection optional. |
| `optionChosen` | The action taken. |
| `outcome` | What happened after. Arrives on a LATER record referencing the opener's `recordId` — never by mutating the opening record, which append-only forbids (§2.4). |
| `context` | Session, framework, and the captured region (§3). |
| `schemaVersion` | Integer. Without it a reader cannot distinguish "old format" from "field legitimately absent". |
| `redactions` | Kind and count of scrubbed spans, never the bytes. Includes the whole-field failures in §4. |
| `componentVersion`, `ruleSetId`, `configDigest` | Which decider produced this — see §2.3. |
| `sequence`, `writerIdentity`, `timestamp` + source | Ordering and provenance. These live INSIDE `payload` so they are hash-covered — see §2.4. The cryptographic envelope (`recordId`, `prevHash`, `hash`) wraps them. |

"Enough to replay" is the bar: if a reviewer cannot reconstruct the situation well enough to disagree
with the choice, the record is insufficient.

### 2.2 The rationale must carry the input that DRIFTS

The motivating risk is **pattern drift** — a rule silently matching a *different* prompt than it was
written for, and approving it. Where the rules are prose patterns, drift happens **in the prose**. A
record capturing the options but not the matched prose spans cannot show it, and fails at exactly the
case it exists for while looking complete.

**A name list is not a rationale.** The name says which rule fired; the span says what it fired ON.

This is the smallest capture that works. Recording only *expected* options is blind to drift by
construction — under drift it is confidently wrong, which is worse than absent. Recording the whole
pane over-captures for no additional signal.

### 2.3 The record must identify the DECIDER

A reviewer facing a surprising approval has two candidate explanations — **the input drifted** or
**the rule changed** — which call for opposite responses. A record carrying only inputs cannot
separate them, and a year-old record without `componentVersion` / `ruleSetId` / `configDigest` cannot
be interpreted at all.

### 2.4 Append-only decision-event stream

This is an append-only event stream, not a mutable debug log. Naming the pattern imports requirements
that would otherwise be re-derived piecemeal, and tells an implementer which known shape to build.

| element | requirement |
|---|---|
| `recordId` | stable, so a record can be cited and its absence noticed |
| `sequence` | monotonic **per log** (not per episode — an episode-scoped counter cannot detect deletion of a whole episode). Episode ordinality is a separate field. |
| `writerIdentity` | which process/machine produced it |
| `timestamp` + source | a record whose clock is unattributable correlates with nothing |
| chaining | each record carries the prior record's hash. **On writer start the chain is re-anchored from the file tail**, and a re-anchor is itself a recorded event — instar restarts on every auto-update, so a verifier that treated a boot boundary as tampering would be worse than no chain. |
| write failure | appends MUST NOT throw into the decision path. `sequence` is assigned only on success, so a gap always means deletion and never a dropped write. **Every failed append is itself durably recorded** — outside this log, carrying component, time, failure reason, and the decision class attempted. That record is the evidence that a decision happened unrecorded; without it the FIRST failure is already an unaccountable decision by §1's own definition, and a threshold of N would silently permit N−1 of them. **The failure sink can itself fail** — disk-full and permission errors hit both logs — so the ladder terminates in-process: durable sink, else the server log, else an in-memory counter surfaced on the component's health surface. The last rung survives nothing, and saying so is the point: there is no durable guarantee left at that depth, and a spec claiming one would be inventing it. The threshold governs only when the OPERATOR is notified, not when the failure is recorded. Whether the component keeps deciding is out of scope (§5.1); whether it does so invisibly is not. |
| pruning | retention deletion is a recorded prune event carrying the age window and the id range removed. Prune events are constrained to age-only so the audited party cannot disguise a deletion as policy. |

**The scheme is fixed here, not deferred** — an on-disk format is a durable side effect, so leaving it
open would violate §7's own never-cheap rule:

- **Shape:** each record is `{ payload, recordId, prevHash, hash }`.
  **`payload` carries everything the record ASSERTS** — every §2.1 field INCLUDING `sequence`,
  `writerIdentity`, `timestamp` and its source. The three envelope fields are purely cryptographic
  wrapper and are the only things outside it.

  This split is load-bearing: `recordId` covers `payload`, so anything outside `payload` is
  **not hash-covered and therefore freely editable**. Putting `sequence` or `timestamp` in the
  envelope would leave the two fields most useful for disguising a deletion unprotected — the
  opposite of the intent.
- **Canonicalization:** RFC 8785 (JSON Canonicalization Scheme), applied to `payload` ONLY.
- **`recordId`** = SHA-256 of the canonicalized `payload`. Content-derived, so an id cannot be minted
  independently of what it names.
- **`hash`** = SHA-256 of `prevHash || recordId`. Chain position and content are separate inputs.

Defining the hashed object explicitly matters: hashing "the record excluding its own hash" while
`recordId` is itself a hash of the record is circular and cannot be implemented. Naming `payload` as
the sole canonicalized object removes the recursion.

- **Digest key:** `observedOptionsDigest` carries a `digestKeyId`. Keys are per-install, rotated by
  minting a new id (never by rewriting old records), and a record whose key is unavailable — a
  restored machine, a rotated-away key — verifies as **`unverifiable`, never as a mismatch**. A lost
  key must not be able to manufacture evidence of drift.

**Durability.** Records are appended with a single atomic write and fsynced before the append is
treated as successful, under the writer lock the component already holds for its log. A torn trailing
line is discarded on read and counted, never repaired — repairing it would rewrite evidence.

**Scope honesty — what the chain does NOT give.** A purely local chain detects a **mid-chain edit**.
It does **not** detect an actor with write access rewriting the file and its tail together, because
that actor can recompute every subsequent link. Detecting *that* requires an anchor the writer cannot
rewrite.

**Anchor requirement:** chain heads are periodically written to a store outside this log — at minimum
the server log, which has a different lifecycle and rotation. A component may use a stronger anchor.
Without an anchor the honest claim is only "mid-chain edits are detectable", and a spec claiming more
would be the overclaim this standard exists to catch.

### 2.5 The normalized option model

A digest is only as meaningful as the object it covers. Terminal and UI text varies with line
wrapping, ANSI sequences, redraws, cursor position, localization, and incidental whitespace — none of
which is drift. A digest over raw text would alarm on all of it and would therefore be turned off
within a week, which is worse than not having one.

**The digested object is a normalized model, not the screen:**

| element | rule |
|---|---|
| ordinal | the option's number as presented |
| label | scrubbed, ANSI-stripped, whitespace-collapsed, trimmed |
| enabled | whether the option was selectable |
| ordering | by ordinal, so a redraw that re-emits options in a different order is not drift |
| excluded | cursor position, glyphs, colour, wrapping, and the surrounding prompt text — all presentation |

**Scrub before digest, never after.** Digesting pre-scrub text would make the digest a verification
oracle for redacted content: an attacker who could submit candidate values and compare digests would
recover exactly what the scrubber removed.

**Honest limit:** normalization means a change invisible to this model is invisible to the digest. A
prompt whose *prose* changed while its options stayed identical produces a matching digest — which is
why the matched spans (§2.2), not the digest, are the load-bearing drift evidence. The digest catches
the case where the choice set itself changed.

### 2.6 Recorded context is UNTRUSTED DATA

Captured context is text an outside party may control — tool output, a printed file, a hostile build
log. It becomes durable text a future agent reads when asked "why did this happen?".

**The untrusted-data envelope is part of the STORED record, not a property of a renderer.** Agents in
this project read logs directly from disk; a render-time envelope does not exist when a log is read
as a file.

## 3. What may be captured

**Text wherever text exists.** A pane capture and a screenshot of that pane carry identical
information, but text is scrubable, greppable, diffable, and bytes rather than megabytes. This is not
privacy-squeamishness — it chooses the *more* auditable medium.

**Region bound.** The recorder MUST have its own deterministic region algorithm — stated in the
component's spec, given an explicit upper bound in lines or bytes, and tested against the shapes it
must handle (prompt header, options, warnings, matched spans). It is DERIVED from the detector's
predicate but MUST NOT be bound to it: if the detector's predicate is flawed — the drift case this
standard exists to expose — a recorder bound to it inherits the flaw and records exactly the evidence
that hides it.

Unbounded scrollback is excluded: arbitrary preceding output is pure secret-exposure surface with zero
audit value.

**Images.** Default is **metadata-only** — the §2.1 field set without the image, which is a `degraded`
record by construction and says so. An image is captured only on explicit per-surface opt-in, never
from a surface that may display credentials, and when captured it is local-only, never crossing a sync
or feedback path, under the same region and retention bounds.

The honest consequence: for a GUI surface that may show secrets this standard yields a **weaker**
record than for a terminal. That gap is named rather than closed by permitting an unscrubbable
credential store.

## 4. The scrub floor, stated honestly

Captured context passes the credential-scrubbing chokepoint before it is written.

**Coverage.** The shared scrubber matches KNOWN TOKEN SHAPES. Against novel or obfuscated secrets it
is best-effort. An unlabelled password, a session cookie, or an internal token matching no known shape
is written verbatim. Text capture therefore **reduces** the conflict with the credential wall; it does
not remove it. The region bound (§3), the retention bound (§0), and machine-local storage carry the
residual.

**Whole-field failures.** The scrubber replaces the ENTIRE field on two paths — an input over its size
bound, and any internal throw. Both are unambiguously `degraded`, and both are silent unless the
caller inspects the result. A caller that only asks "were there redactions?" will classify a
scrub-error record as merely partial.

**`degraded` means KNOWN-INCOMPLETE. It is never a claim that no secret survived.** It is set when
scrubbing removed enough that the decision can no longer be reconstructed — not merely when it removed
something. `redactions` (kind + count) lets a reviewer tell "one token removed" from "the choice set
is gone".

**Beyond credentials.** A captured region can contain personal, customer, or regulated data, for which
"it matched no token pattern" is no assurance. A component adopting this standard declares a
**do-not-capture class** for its surface — content excluded regardless of scrub result. What counts as
regulated for a given deployment is a data-classification question this standard requires be declared,
not one it answers.

## 5. Decision points touched

| point | classification |
|---|---|
| what to record | `invariant` — §2.1's field set is fixed |
| text vs image | `invariant` — text where text exists; otherwise metadata-only, image on opt-in only (§3) |
| capture bound | `invariant` — a deterministic, component-specified, tested region algorithm with an explicit upper bound (§3); NOT the detector's predicate |
| scrub-before-write | `invariant` — existing chokepoint |
| `degraded` trigger | `invariant` — a reconstructability test (§4) |
| record integrity | `invariant` — the §2.4 envelope and scheme |

All six are fixed rules over data already in hand, with no competing signals to weigh.

### 5.1 This standard records; it does not govern what may be approved

A recording standard must not legislate about actions, and this one does not.

- **In scope:** the record must make a decision reviewable, including making visible that a
  high-consequence choice was approved.
- **NOT in scope:** whether that choice should have been permitted. Risk taxonomy, fail-closed
  escalation, and what authority a deterministic detector may hold belong to a companion control
  standard.

**Nothing here ratifies any component's existing decision authority.** In particular, this standard
does not discharge *Judgment Within Floors*' requirement that a static heuristic at a decision point
justify itself — that obligation stays with the component's own spec, and for the first application it
is **open**, tracked as ACT-1500.

**One thing this standard DOES require of every adopter, because it is a recording question:** an
adopting component MUST **declare, per decision class, whether it may act when the record is
structurally incomplete** — `degraded` for any reason, an append that failed, or a do-not-capture
class overlapping the decision-critical region. This standard does not decide the answer; it forbids
the answer being undeclared. An audit trail whose gaps are silent is the failure in §1 wearing a
different hat, and "may I proceed unrecorded?" is precisely the question a reader of the log will
need answered and cannot infer from the log itself.

**On the tension with *No Deferrals*, because it is real and should not be resolved silently.** That
standard says deferring is deleting. Two independent reviewers, meanwhile, held that folding control
requirements into a recording standard is scope creep. Both are right, and the distinction that
separates them:

- **ACT-1503** (the grader) is work THIS standard creates. Deferring it would be deletion — so it is
  registered, scoped, and blocked on a named dependency rather than left as an intention.
- **ACT-1500** (the ungated approval path) is a defect this standard **discovered in a component that
  predates it**. It was not created here and cannot be closed here — a recording standard has no
  authority over what a floor may approve.

**The line: you may not defer YOUR work; you must not annex someone else's.** A recording standard
that quietly took over an approval-policy decision would be a worse outcome than an honest referral —
it would place a control decision in a document no one reviews for control. What *No Deferrals*
legitimately demands is that the referral be real: a registered, scoped action with a named owner, not
a sentence saying "out of scope."

**What is known about that open gap**, recorded because it bears on what the record must show: the
first application's floor fires on ≥2 distinct registered prose patterns, and two of its four are
generic host strings that satisfy the threshold alone. A purely deterministic narrowing exists —
requiring at least one *specific* pattern — which costs no availability for the prompt the floor was
built for. Whether to adopt it is ACT-1500's decision, not this standard's.

### 5.2 Asynchronous grading — a possible consumer, not yet a commitment

The record is a substrate for grading decisions off the critical path and raising an Attention item
when an approval looks wrong. That would satisfy *LLM-Supervised Execution* without putting a model in
a safety floor's path.

**Two constraints if it is ever built**, stated so the idea is not later mistaken for an approved
design:

1. **A deterministic check comes first.** Comparing `observedOptionsDigest` against
   `expectedOptionSchema` catches plain drift with no model at all — cheaper, always-on, and not
   subject to the availability failure a model path introduces. An LLM is for ambiguity, not for
   detecting a mismatch a comparison already finds.
2. **It would be a watcher raising operator notices**, so it inherits *Self-Heal Before Notify* in
   full — `max-attempts`, `max-wall-clock`, `backoff`, `dedupe-key`, `breaker`,
   `max-notification-latency`, `audit-location`, remediation actions, and a severity class — plus its
   own *Decision Provenance* row and token attribution. Its input is attacker-influenceable text and
   its output must be signal-only.

**Registered as ACT-1503**, carrying both constraints above, and blocked on the record existing at all
(ACT-1312) — there is nothing to grade until the record carries matched spans and an observed digest.

**What this does and does not settle.** It gives *LLM-Supervised Execution* a real, tracked path for a
pipeline that cannot host a synchronous supervisor, rather than an intention. It does NOT make the
first application supervised today: until ACT-1503 ships, the deterministic floor runs unsupervised,
and §5.1 is where that gap is owned.

## 6. Multi-machine posture

**Posture: `proxied-on-read`** — served from the owning machine on demand, never replicated. A decision
record is evidence of what happened on one machine's session, and the sibling's machine-local-full /
HTTP-redacted contract (§0) already defines this shape.

`machine-local` with a locality justification would be wrong: a log is not a credential, and the
taxonomy's locality keys do not fit content that is trivially replicable.

**Fan-out infrastructure already exists** — `src/core/PoolViewProxy.ts` (holder resolution, concurrency
cap, explicit `holder-offline` state) and `src/server/PoolPollCache.ts` — and `?scope=pool` is served
on several routes today. **No fan-out serves THIS log.** The deliverable is therefore to wire this log
into the existing proxy, not to build one, and the proxy's offline-owner contract ("content
temporarily unavailable — its machine is offline", never stale content, never a bare 404) is inherited
rather than re-specified.

**Known residual:** the machine whose sessions wedge is the machine you cannot reach, and a wedged
machine is exactly when someone reads this log. Replicating the *redacted projection* while keeping
the full record local would preserve locality and remove that correlated failure. Not adopted here —
it widens the disclosure surface for a benefit only realised during an outage — but recorded as a
known trade rather than an oversight.

### 6.1 The read route is a sensitive-evidence API

| element | requirement |
|---|---|
| authentication | the agent's bearer auth |
| authorization | **the operator's dashboard PIN.** Every operator-role decision in this system is PIN-gated precisely because the bearer token is the *agent's* credential; the most sensitive evidence route must not ship at agent-level auth. **A PIN authenticates a session, not a person**, so the audited principal is the resolved operator binding and each read is authorized individually rather than for a session's lifetime. **What a PIN does NOT give, stated rather than assumed:** it is not a human-presence proof. Any component that can observe and submit it holds bearer-equivalent access, so the honest claim is 'gated by a credential the agent is not supposed to hold', not 'unreplayable'. A stronger property needs a mechanism — an origin-bound short-lived capability, a rate limit, or an out-of-band confirmation — and a component that needs one must name it rather than inherit an assurance this standard cannot provide. Offline review is by reading the file on the owning machine, which is already the operator's own access — not by a weaker remote path. |
| redaction boundary | full records local-only; anything crossing HTTP is the redacted projection (§0) |
| read auditing | reads are recorded to the SERVER log, not into this chain, so an evidence store does not grow by being read. Each entry carries **who** (resolved principal), **when**, **which record range**, and the outcome — never record CONTENT, or the read audit becomes a second copy of the evidence with weaker protection. It inherits the server log's existing retention and rotation; this standard does not create a third store. |
| failure behaviour | fail CLOSED. Unresolvable authorization returns nothing and never degrades to serving records. |

## 7. Frontloaded decisions

No open questions. Every implementation decision surfaced in review is decided here. None is
cheap-to-change-after: each touches a durable side effect or an operator-visible surface.

| # | decision | resolution |
|---|---|---|
| 1 | Retention | **14 days**, the sibling's real content bound (§0). |
| 2 | Read surface | A PIN-gated route wired into the existing pool proxy (§6, §6.1). |
| 3 | Capture-mode knob | `replayCapture`: `full` \| `digest-only`, **defaulting to `full`**. Config key `monitoring.permissionPromptAutoResolver.replayCapture`, added to `migrateConfig()` with an existence check. **`names-only` is deliberately NOT an option** — it is the exact state §1 identifies as the motivating failure, so offering it as a supported mode would let a component be configured into non-conformance while appearing configured. Rollback means "record less detail", never "return to the failure this standard exists to close". |
| 4 | `degraded` trigger | Reconstructability, not any-redaction (§4). |
| 5 | Image parameters | Metadata-only default; per-surface opt-in; no credential-bearing surface; local-only; §3's region bound and §0 retention (§3). |
| 6 | Untrusted-data marking | A stored wrapper field, not a renderer property (§2.6). |
| 7 | Migration template text | Replace "matched-pattern names only, never raw pane text" with: *"audit at `logs/permission-prompt-resolver.jsonl` — records the matched patterns, the scrubbed prompt spans they matched, and the options offered, so an auto-approval can be reviewed. Credential-scrubbed before write; records that scrubbing left incomplete are marked as such."* |
| 8 | Per-episode volume | Emit the full payload once — on the record carrying the capture the action was actually taken against (§8.4), which for a component that re-captures before acting is the re-capture, NOT first detection. Later records in the episode reference it by `recordId` and carry only what changed. |
| 9 | Integrity scheme | Per-record hash link over canonical JSON (§2.4) — fixed, not deferred. |
| 10 | Do-not-capture class | Declared per component; its contents are the component's to state (§4). |
| 11 | Read-route principal | The operator, via dashboard PIN (§6.1). |

## 8. Scope and status

**Applied to ZERO components.** The standard is written; the first application is in progress and has
not landed.

| component | status |
|---|---|
| `PermissionPromptAutoResolver` | **IN PROGRESS.** A first implementation was written and rejected in review. |
| every other autonomous decision-maker | **NOT AUDITED.** No claim either way. |

### 8.1 Required deliverables of the first application

1. Correct the migration template sentence (§7 #7) via `PostUpdateMigrator`, and add the new route and
   knob to the CLAUDE.md template per *Agent Awareness*.
2. Correct the foundation spec's "the raw tail is never logged".
3. Wire the log into the existing pool proxy (§6) and ship the PIN-gated read route (§6.1).
4. Ship the capture-mode knob with its `migrateConfig()` entry (§7 #3).
5. Implement the §2.4 integrity envelope — an `invariant`, so not optional.
6. Declare the resolver's do-not-capture class (§4).
7. Store the untrusted-data wrapper (§2.6).
8. All three test tiers per the Testing Integrity Standard, including the Phase-1 "returns 200, not
   503" E2E for the read route.
9. **Propose** the registry entry for this standard; the operator ratifies it. An agent cannot register
   a constitutional article.
10. Add the `/spec-converge` reviewer clause: *"does this component decide on the operator's behalf,
    and if so does its record carry §2.1's field set?"*

Until 9 and 10 land, this standard governs exactly one thing: the change that introduces it.

### 8.2 Honest limits

**A capture-only loop is a half-measure by this standard's own parent principle.** *Observability*
requires metering the whole loop. Deliverable 3 closes this by shipping the read path with the
recorder — the record and the ability to read it land together, or the feature is a write-only log.

### 8.3 The remaining sweep

Finding other components that narrowed what they record for the same reason is an **audit**, and
audits here run to convergence rather than a single pass. Tracked as **ACT-1312**, whose scope
includes "audit other autonomous decision-makers for the same privacy-motivated narrowing."

### 8.4 A property deliberately NOT changed, and its cost

The episode fingerprint stays derived from static pattern names alone, so it remains stable across
redraws and dedupe keeps working.

**The cost:** two different prompts matching the same pattern set collapse into one episode — sharing
the record, the attempt counter, and the retry budget. A later record can then describe a prompt it
never saw.

**The binding rule that resolves it — and it needs TWO keys, not one.** Conflating them is what made
the earlier wording self-contradictory:

| key | derived from | purpose |
|---|---|---|
| **dedupe key** (the existing fingerprint) | static pattern names only | recognising the same prompt SHAPE across redraws. Must stay pane-free or it changes on every repaint and dedupe collapses. |
| **capture-binding key** | `observedOptionsDigest` | binding a RECORD to the specific screen it describes. Never used for dedupe. |

A record MUST derive from the capture the action was taken against: where a component re-captures
before acting, the record is built from the re-capture and carries that capture's binding key. Two
prompts sharing a dedupe key therefore still produce records that are individually faithful — the
episode may be shared, the record never is.

This is a recording requirement satisfied by making the record faithful. It does not decide whether
the component acts, which §5.1 places out of scope.
