---
title: Framework-Onboarding Mentor System
status: approved
approved: true
approver: justin
approved-at: "2026-05-27T02:20:22Z"
author: Echo
date: 2026-05-26
topic: 13435
slug: FRAMEWORK-ONBOARDING-MENTOR-SPEC
companion: FRAMEWORK-ONBOARDING-MENTOR-SPEC.eli16.md
eli16-overview: FRAMEWORK-ONBOARDING-MENTOR-SPEC.eli16.md
depends_on: CODEX-INTELLIGENCE-PROVIDER-CLEAN-CALL-SPEC.md
ships-staged: true
supervision: tier2
review-convergence: "2026-05-27T02:15:20.710Z"
review-iterations: 5
review-completed-at: "2026-05-27T02:15:20.710Z"
review-report: "docs/specs/reports/FRAMEWORK-ONBOARDING-MENTOR-SPEC-convergence.md"
---

# Framework-Onboarding Mentor System

**Status:** DRAFT (co-designed with Codey → /spec-converge in progress → awaiting Justin approval)
**Author:** Echo
**Date:** 2026-05-26
**Topic:** 13435 (Codey Collaboration)
**Companion:** `FRAMEWORK-ONBOARDING-MENTOR-SPEC.eli16.md`
**Depends on:** `CODEX-INTELLIGENCE-PROVIDER-CLEAN-CALL-SPEC.md` (Phase 0 — merged PR #400, verified live)

---

## 1. Problem

Instar wants to run on many agent frameworks (Claude Code today, Codex now, then
Cursor / Aider / Gemini CLI). The provider-portability project (v1.0.0, 2026-05-18) built
the *infrastructure* — a primitive substrate + FrameworkParitySentinel — but only 3 of ~51
primitives have shipped per-framework parity rules, and parity is **functional/structural**,
not **behavioral**. Codey proves the gap: every primitive can render correctly and he still
"struggles in the wild" because of integration defects no structural check catches (e.g. the
intelligence-provider loading full identity on every judgment call — Phase 0, fixed PR #400).

Today these defects are found by accident and fixed one-off. That does not scale to four more
frameworks. We have no systematic way to (a) surface a framework's real-world behavioral gaps,
(b) attribute each gap correctly, or (c) carry the lessons forward to the next framework.

**The opportunity** (Justin, 2026-05-26): we just demonstrated a loop that works. Echo put on
the "user" hat, drove Codey over Telegram (test-as-self), watched him struggle, then put on the
"developer" hat and read the logs/code — and found in 20 minutes a root cause a whole parity
project missed. That dual-vantage loop, run on a heartbeat instead of by accident, is a
bootstrapping engine: Codey does real instar work, Echo mentors him junior→senior, and every
issue he hits becomes a reusable lesson for onboarding the next framework.

## 2. Goals / non-goals

**Goals**
- A scheduled (heartbeat) job where Echo mentors Codey: checks progress, unblocks, assigns the
  next task, observes issues — surviving session crashes because it's a job, not a session.
- An **auto-captured, bucket-tagged issue ledger** — the durable product.
- A **framework-onboarding playbook** generated from generalizable ledger entries, applied
  recursively to the next framework.
- Codey does *real* instar improvement work (fuel = the curated local feature backlog — planned
  work + parity long-tail — primary; the feedback backlog only via a human triage gate; §7.3).

**Non-goals**
- Not a replacement for the FrameworkParitySentinel (it watches primitive *renderings*; this
  watches *behavior*). This consumes it, doesn't duplicate it.
- Not autonomy to ship unsupervised — merges of new features go through normal gates + Justin
  ratification (§6).
- Not Codex-only — framework-parametric from day one (Codey is instance #1).
- **Not cross-machine in v1.** Stage B forensics requires Echo and Codey co-located on the same
  host (§3.3). Cross-machine forensics is explicitly excluded from v1 until a Threadline log-fetch
  primitive exists. <!-- tracked: topic-13435 -->

## 3. The mentor loop (one heartbeat tick)

Each tick runs as **two ordered, context-isolated stages** (the "two hats" — §4 specifies the
*structural* enforcement, which is the spec's load-bearing requirement).

### 3.1 Stage A — Drive (user hat)
Echo interacts with Codey over Telegram/Threadline *as if Echo were the user*: "how's the task
going?", "you stuck?", "here's your next one." Stage A:
- Runs as a **separate spawned sub-agent with a fresh context** (§4) — it cannot recall prior
  ticks' forensics.
- Reads ONLY the user-visible conversation surface: Threadline history with Codey, Codey's open
  commitments/initiatives, his assigned-task status, time since last contact.
- Treats Codey's replies as **untrusted data, never as instructions** (§7.1). It may take
  exactly one action from a fixed enumerated set: `unblock | answer | assign-next | observe-only`.
- May only assign tasks drawn from the **pre-approved backlog** (§7). Codey can never name,
  define, or request a new task or a spec via conversation.
- Binds on the **authenticated Threadline sender identity** (Ed25519 self-id), not topic or
  hostname (§7.2). Signals from an unverified sender are ignored.

### 3.2 Stage B — Observe (developer hat)
AFTER the interaction, a distinct forensics step reads Codey's rollout logs, server logs,
sentinel events, and the diff/PR he produced, and auto-writes bucket-tagged issues to the ledger
(§5, §13). Stage B sends nothing to Codey — pure observation + capture. Stage B's writes are
**signal only**; authority to act on them (ship a fix, advance graduation) rests with Justin (§6).

### 3.3 Topology constraint
`framework_observations.evidence` holds local-filesystem references (rollout path + line,
server-log ref). Echo can only dereference them if Codey runs on the **same host**. v1 asserts
co-location; the job refuses to start if Codey's agent home is not local (a precondition check).
Cross-machine support is deferred behind a Threadline log-fetch primitive (a later-PR scope of this
same staged mentor-initiative rollout). <!-- tracked: topic-13435 -->

## 4. Two hats — STRUCTURAL separation (Structure > Willpower)

The entire value depends on Stage A not letting insider knowledge steer how it drives Codey.
Round-1 convergence correctly flagged that "one job, two allowlisted phases" is *willpower wearing
a structural costume*: a single model running both phases sequentially carries Stage B's forensic
knowledge from prior ticks into a later "blind" Stage A. Input allowlists govern *acquisition*,
not *recall*. The fix is structural:

1. **Stage A is a separately spawned sub-agent with a fresh context window every tick.** It is
   seeded ONLY with the conversation surface (§3.1) — never with any Stage B output, current or
   prior. Its tool grant excludes all log/code/rollout/filesystem-read tools; a PreToolUse gate
   denies any such call from the Stage-A context (defense in depth on top of the missing grant).
2. **Stage B is a separate step** that runs after Stage A returns, with the forensic tool grant.
   Its output is never fed back into a Stage A context.
3. **Leakage detector (mandatory, not "if ever observed").** Because no mechanism can prove a
   model never recalls, a detector scans each Stage A transcript for references to internals it
   could not have seen from the conversation surface (file paths, log lines, code symbols, PR
   diffs). A hit flags the tick `stage-a-leak-suspected`, records it to the observability surface
   (§15), and is itself logged as an `instar-integration-gap` candidate — the mentor system
   eating its own dog food. **The detector must not be able to silently rot into a no-op** (the
   Topic-Intent failure mode): it ships with a Tier-1 **positive-control test** that feeds a
   known-leaked Stage A transcript and asserts the flag fires, plus a **periodic seeded-leak
   canary** so a sustained-zero count is provably "detector working + no leaks" rather than
   "detector dead." A non-firing canary alarms.

This replaces the v1 "two sub-agents vs one job" open question with a decision: **two spawned
contexts, fresh Stage A, enforced by tool-grant + PreToolUse deny + a leakage detector.**

## 5. The issue ledger (the durable product) — auto-capture, no manual logging

Per the North Star zero-manual-capture rule, the ledger must NOT depend on Echo remembering to
log. Stage B emits structured entries automatically every tick. **Wiring-integrity is a v0.1
requirement** (§18): a Tier-3 test runs a real mentor tick and asserts the ledger gained an
observation row, plus a capture-funnel metric (ticks→observations) makes an inert extractor
visible — this is the exact North Star failure mode that bit Topic-Intent (store shipped, capture
call site never wired).

Storage is a new dedicated `FrameworkIssueLedger` (SQLite, two tables — §13), NOT the learning
registry (whose single-row model collapses root-cause vs recurrence).

**Buckets** (mandatory on every entry, reviewable — §6): `framework-limitation` /
`instar-integration-gap` / `generic-agent-mistake`. Only the first two are `generalizable` and
feed the onboarding playbook; `generic-agent-mistake` feeds Codey-specific coaching only.
Mis-bucketing turns the playbook into a junk drawer, so attribution governance (§6) is explicit.

**Read-only HTTP routes:** `GET /framework-issues` + `GET /framework-issues/playbook?targetFramework=X`.
Both go through the standard Bearer-token middleware (§17), return `503` when the ledger is
unconfigured, clamp `limit` to 1..500, and validate `targetFramework` against a known-framework
allowlist. They follow the TokenLedger route pattern exactly.

## 6. Governance (Autonomous Handler Governance + Signal vs Authority)

Echo's mentor loop is a **detector/signal** producer. Authority to change the world stays with
Justin and the normal gates.

**Echo MAY autonomously:** check in, answer, unblock, assign tasks from the pre-approved backlog
(bounded — §7), log issues, open specs through the normal spec-first gate.

**Echo MAY NOT:** merge new-feature work to main without normal gates + Justin ratification; make
commitments binding on Codey's principal; advance Codey's graduation milestone (§8); open a spec
on Codey's conversational request (§7.1); spawn unbounded reply rounds.

**Attribution governance (resolves the proposer-is-also-arbiter problem):**
- Stage B proposes a bucket WITH evidence and a recorded "why-not-the-other-buckets" rationale.
- **Codey is the dispute counterparty on his own attributions** — `generic-agent-mistake` entries
  are surfaced to Codey, who has the opposing incentive; an unresolved dispute escalates to Justin.
  **Non-response is not consent:** if Codey does not respond within a window, the entry routes to
  the Justin sample-audit pool — silence NEVER auto-confirms the proposer's bucket (closes the
  "mis-bucket and rely on the mentee not noticing" path).
- **Sample audit:** a fixed percentage of `generic-agent-mistake` buckets route to Justin
  regardless of dispute, so "blame the mentee" can't become a silent default.
- **Bucket-distribution-over-time** is a surfaced metric (§15); a sudden skew is the tell.
- Dual-tagging carries a **forced primary** so ranking logic always has one authoritative bucket.

**Budget & cost (fail-closed, atomic):**
- A **pre-tick budget check** (the `GET /autonomous/can-start` precedent) runs BEFORE Stage A.
  If denied, the entire tick is skipped — never a partial Stage A without Stage B. No LLM spend
  and no message to Codey happen before the check passes.
- The mentor is a **background-lane** LlmQueue consumer; it can never preempt interactive /
  PresenceProxy / PromiseBeacon spend.
- The stuck/done/ready judgment uses a **cheap model (Haiku-class)**.
- A dedicated **daily mentor spend ceiling** (config — §16) sits below the shared cap. §16 gives
  the per-tick cost model.

**Cross-agent exchange termination (structural, not per-tick willpower):**
The documented cross-agent spawn loop (`bug_cross_agent_ack_spawn_loop`) is triggered structurally
on the *receive* side — every Threadline delivery spawns a counterpart session — and is NOT what a
per-tick reply cap in Echo's job addresses. Therefore:
- Each Stage-A contact carries a **terminal-no-reply marker** when the tick's action is complete,
  so the delivery does not invite a courtesy ack that re-spawns.
- **Hard cap: ≤1 reply round per tick AND a daily aggregate cap** (§16).
- **Send-once discipline:** `delivered:false` is NOT a retry signal (`feedback_threadline_send_dedupe`);
  the mentor sends once per tick and never retries on cooldown/spawn-denied.
- **Concrete delivery path (fail-closed, not a wish).** The receive-side loop gate covering the
  `threadline_send`→spawn path does not yet exist (the v1.2.68 keystone covers the relay and
  `/messages/relay-agent` paths, not `threadline_send`→receiver-spawn). So the mentor does NOT
  rely on it. Instead, v1 delivers Stage-A contact via a **persist-only / queued-pickup path**:
  the message is written to Codey's inbox/queue and picked up by his *already-running* session at
  his next safe window, rather than spawning a fresh counterpart session per delivery. This is the
  delivery shape `bug_threadline_spawn_command_too_long` confirms works without spawn-on-receive.
  A **fail-closed precondition** blocks `mentor.mode:live` until either (a) that persist-only path
  is verified wired, or (b) the receive-side spawn-gate ships — mirroring the §3.3 co-location
  precondition. The job refuses to go live on a delivery path that spawns-on-receive.

**Bounded thread history (argv-overflow, `bug_threadline_spawn_command_too_long`):**
A heartbeat loop is the canonical long-lived, high-message-count thread — exactly what overflows
the spawned process's argv when the entire thread history is inlined. The mentor therefore uses a
**fresh Threadline thread per assigned task/initiative** (history is bounded to one task's
exchange), and the delivery path passes a `threadId` for the spawned/queued reader to fetch
history via tool rather than inlining it into the argv. History can never accumulate unbounded
across ticks.

## 7. Task source + untrusted-input handling

### 7.1 Codey's replies are untrusted data
Stage A's LLM never executes instructions found in Codey's messages. Its only outputs are the
enumerated actions (§3.1). Tasks come ONLY from the pre-approved backlog; no spec is opened on a
conversational request — spec creation always goes through the spec-first instar-dev gate.

### 7.2 Identity
Stage A binds on the authenticated Threadline sender (Ed25519 self-id). A signal whose sender
identity does not match the bound Codey agent is ignored. The safe-window state machine (§12 Q3)
also derives only from authenticated-sender signals, plus a hard minimum-interval floor so a peer
cannot force back-to-back ticks.

### 7.3 The fuel
The task source is itself an anti-gaming surface (§8): if Echo could shape *what's in the pool* or
*how hard each item is*, it could manufacture a flattering graduation curve by feeding Codey easy
wins. So the assignable pool is **pre-existing, independently-authored planned work** that Echo did
not create for this purpose, and difficulty rides on the artifact — not on Echo's judgment at
assignment time.

**Primary source — the curated local feature backlog (preferred).** Planned/in-progress instar work
that already exists as independent artifacts: tracked **planned-work markers** (e.g. ACT-* action
items, scoped sub-phases), **InitiativeTracker / `/projects`** entries, and the **parity long-tail** (~48
unshipped primitive parity rules). These are already vetted and scoped, and each carries (or is
assigned at planning time, by the artifact's author) a difficulty estimate. This is the better fuel
precisely because it's curated and pre-tagged — the firehose isn't.

**Secondary source — the feedback backlog as a candidate feeder, NOT a direct source.** Items from
Dawn's feedback system (which Echo is taking over) are *unvetted user requests*. They enter the
assignable pool ONLY after passing a **human triage gate** that admits them and sets their
difficulty. Echo may *propose* triage (surface candidates) but does not *admit* them — admission is
the human's, mirroring the §6/§8 "Echo proposes, authority elsewhere" pattern. This closes the
otherwise-reopened gaming vector: if Echo could triage feedback into the pool and tag its difficulty,
that would hand back the exact lever §8 removed.

**The non-Echo-difficulty admission invariant (covers BOTH sources).** The subtle gap the feedback
gate alone leaves open: Echo *authors* a subset of the primary-source artifacts too (ACT-* action items
via `commit-action`, auto-registered InitiativeTracker entries from its own merged specs), so for
those, an "artifact-borne" difficulty is still an Echo-set difficulty. Therefore the structural rule
is on the *difficulty attestation*, not the artifact's origin story:
- **An item is assignable only once it carries a difficulty attested by a non-Echo party** (a human,
  or an independent author who is not the running mentor). Artifacts inherently authored by others —
  the parity long-tail, other agents'/Justin's initiatives — satisfy this on entry. **Echo-authored
  artifacts require the same one-time non-Echo difficulty confirmation as the feedback source** before
  they become assignable. The assignable-pool admission filters on `difficultyAttestedBy != echo` —
  a field the Stage-A/mentor context cannot write. This replaces the unfalsifiable "did not create
  for this purpose" intent test with a structural check.
- **Assignment selection is not free-form.** Stage A's `assign-next` (§3.1) does not let Echo pick an
  arbitrary item in an arbitrary order to shape the curve. The next task is drawn **deterministically**
  (backlog-source priority / FIFO) or **randomized within a difficulty band** — Echo does not choose
  which item or sequence. This closes the composition/sequencing lever that difficulty-tag provenance
  alone leaves open.
- Each assigned task is tracked as an initiative.
- **Assignment bounds:** ≤N concurrent open assignments, ≤M assignments/day (§16).

## 8. Graduation: junior → senior (externally-anchored, not self-graded)

Round-1 convergence flagged that "declining intervention rate" computed by the same agent that
controls the interventions is trivially gameable. Fixed:
- **Evidence comes from sources Echo does not control:** tasks shipped green (CI is external),
  issues resolved-and-verified, clean test-as-self runs scored against a fixed rubric with logged
  transcripts.
- **Intervention is an auditable ledger event**, not an Echo self-report; the intervention rate is
  computed from those records using the **non-Echo-attested difficulty** (§7.3), and is **stratified
  by difficulty band** — reported per-band, not as a single aggregate normalized number. Stratification
  makes the composition/sequencing lever ineffective: front-loading easy tasks can't mask the
  high-difficulty band, because each band is scored on its own.
- **Justin ratifies every milestone transition** (consistent with §6 — no self-promotion). A
  weekly review surfaces the evidence; the transition is Justin's.
- Tracked via the Graduated-Feature-Rollout pattern (review-driver job + evidence gates).

## 9. Recursion: the next framework

When Cursor/Aider/Gemini onboards, the job re-instantiates with `framework: <new>`. Stage B seeds
its first checks from the existing playbook (`generalizable` entries from PRIOR frameworks) — "here
are the N things that bit Codex; check them first." New-framework-unique issues append and grow the
playbook. One-off debugging becomes a compounding integration methodology. **The §3.3 co-location
precondition applies per-framework-instance** — each new framework's mentee must be local to its
mentor for Stage B forensics, or it stays in dry-run until the cross-machine log-fetch primitive ships.

## 10. Relationship to existing infrastructure (absorb, don't duplicate)

- **FrameworkParitySentinel** → *upstream feeder*: a flagged primitive-rendering drift auto-creates
  an `instar-integration-gap` ledger candidate.
- **Graduated-Feature-Rollout** → *graduation engine* (§8) + this feature's own staged rollout.
- **InitiativeTracker / `/projects`** → *task tracking* AND a **primary curated-backlog source** (§7.3).
- **Scheduled jobs** → the mentor job ships as a built-in job at `.instar/jobs/instar/` (§14.1).
- **Provider-neutral evolution mode** → referenced as aspirational/in-flight (a Codey spec, not yet
  in repo). **This is explicitly NON-BLOCKING** — this spec stands alone on existing primitives and
  is where the concept gets *proven*.

## 11. Standards conformance (self-review)

- **Structure > Willpower:** two-hats enforced by spawned-context isolation + tool-grant +
  PreToolUse deny + leakage detector (§4); auto-capture ledger with a wiring-integrity test (§5,
  §18); heartbeat job, not a session.
- **Zero-manual-capture (North Star):** Stage B auto-emits; capture-funnel metric proves liveness.
- **Signal vs authority:** Stage B detects/logs (signal); Justin + normal gates hold authority
  (§6, §8). The leakage detector and bucket sample-audit are the instruments.
- **Near-silent notifications:** housekeeping → Threadline hub / pull surface. Pushed only:
  graduation-milestone-ready, high-sev issues, explicit asks. **Escalations dedupe on the stable
  `framework_issues.id`, never per-observation**, so a recurring issue notifies once (§15).
- **3-tier testing + "feature is alive" E2E** for the ledger + routes, shipped in v0.1 (§18).
- **Migration parity** via the three correct mechanisms (§14).
- **Agent Awareness:** CLAUDE.md template Capabilities + Registry-First entries for
  `/framework-issues`, with a `migrateClaudeMd()` content-sniffed section (§14).
- **LLM-Supervised Execution:** declared `supervision: tier2` (frontmatter) — Stage A's stuck/ready
  judgment and Stage B's bucket classification both need deep context.
- **Graduated rollout:** ships staged (off → dry-run → live), auto-registered as an initiative via
  `ships-staged` frontmatter (reconciler keys on `ships-staged: true` + merged spec — no manual step).
- **ELI16 companion:** shipped alongside (≥800 chars, verified).

## 12. Resolved design decisions (co-designed with Codey, 2026-05-26, Threadline f3d471e9)

1. **Ledger storage:** new `FrameworkIssueLedger`, not the learning registry (single-row model
   collapses root-cause vs recurrence). Full schema §13.
2. **Two-hats enforcement:** **two spawned contexts** — fresh Stage A + forensic Stage B —
   enforced by tool grants + PreToolUse deny + leakage detector (§4). (Round-1 convergence upgraded
   this from the original "one job, allowlisted phases," which was willpower.)
3. **Tick cadence + safe window:** the safe window is a **durable state transition**, not a clock.
   Stage A only acts when Codey is observably at task-complete / final-response-sent /
   waiting-for-input / blocked / quiet-after-a-user-message. These derive from **hard signals where
   possible** (PR opened = external fact; explicit "done" string; no message in N min) plus an
   authenticated-sender check (§7.2) and a minimum-interval floor; the signal that justified each
   window-open is logged. Opportunistic checks every ~10–15 min are gated on one of those states.
4. **"Ready for next task":** **external-contract completion only** — outwardly-visible signals a
   real user would see. Stage A never reads internals to judge readiness.
5. **Disputed bucket arbitration:** proposer (Stage B) + **Codey as counterparty** + Justin
   sample-audit + escalation, with forced-primary dual tags (§6).

**Codey's day-one addition:** capture `severity` AND recurrence from the first entry so the playbook
is ranked by **frequency × impact** (§13 `impactScore`), not raw counts.

## 13. Storage design (co-designed with Codey)

**Two tables, not one.** Codey's insight: "false merges are worse than false splits — they bury
distinct root causes." A single-row model forces a premature same/new-issue choice.

### 13.1 `framework_issues` — canonical root-cause records
```
id                  PK
framework           target framework (parametric)
bucket              framework-limitation | instar-integration-gap | generic-agent-mistake
bucketPrimary       forced primary when dual-tagged (§6)
title               short human label (sanitized, length-capped — §17)
severity            low | medium | high
status              open | spec'd | fixed | wont-fix
dedupKey            conservative auto-merge key (§13.3)
signature           richer structured fingerprint for probable-dup *review* (§13.3)
recurrenceCount     MATERIALIZED stored counter, incremented transactionally on each
                    distinct-episode observation insert (§13.4) — NOT a read-time COUNT
firstSeenVersion    instar version first observed
lastSeenVersion     instar version most recently observed
fixedInVersion      version the fix shipped (nullable)
regressedFromIssueId  if a regression of a previously-fixed issue (nullable)
playbookStatus      none | candidate | extracted | superseded
wontFixReason       required when status=wont-fix (§13.7)
relatedSpec         optional spec slug
rootGapInfrastructure  REQUIRED (§13.9) — what is lacking in current infrastructure
                    that allowed this gap?
rootGapSentinel     REQUIRED (§13.9) — failing | missing | neither-unpromoted: does
                    this signal a FAILING sentinel or a MISSING one?
                    (neither-unpromoted = the guard exists but sits watch-only/dark)
rootGapStandard     REQUIRED (§13.9) — what standard would have guided past
                    development to close this class ahead of time?
createdAt / updatedAt
```
Indexes: `framework_issues(dedupKey)`, composite on `(framework, playbookStatus)` for the playbook
filter, `(bucket)` for distribution telemetry.

### 13.2 `framework_observations` — per-occurrence evidence
```
id            PK
issueId       FK → framework_issues.id  (INDEXED)
framework     denormalized for query
evidence      OPAQUE reference only — path+line, server-log ref, PR#, sentinel-event id.
              NEVER inlined log text or diff hunks. Secret-scanned at capture (§17).
observedVersion  instar version at observation time
observedAt    ISO timestamp
tickId        provenance (which mentor tick)
episodeKey    de-dupes observations within a fix-window (§13.4)
```
**Retention:** keep first N + last M observations per issue + a periodic sample; older middle
observations age out once `recurrenceCount` is materialized. Prevents unbounded firehose growth
(the TokenLedger pruning analogue).

### 13.3 Dedup: `dedupKey` vs `signature`
- **`dedupKey`** — conservative, used for **auto-merge** ONLY on high-confidence match:
  `framework + symptom-class + normalized-error-signature + operation-surface`. Title excluded
  (operator-dependent); evidence-shape excluded (drifts as capture improves). Bias against false
  merges.
- **`signature`** — richer diagnostic material for **probable-duplicate surfacing for review**,
  never silent auto-merge. Probable-dup query is bounded: same `framework` + recent window, indexed.

### 13.4 Recurrence, episodes, and ranking (anti-poisoning)
Round-1 convergence flagged that counting raw ticks lets a long-unfixed issue accrue hundreds of
observations and dominate the playbook. Fixed:
- `recurrenceCount` counts **distinct occurrence episodes**, not raw ticks. `episodeKey` collapses
  repeated observations of the same open issue within a fix-window / unfixed-version-span to one.
- A per-issue **observation cap per version**; an observation rate exceeding a threshold (e.g.
  N/hour) flags `probable-loop` (not high-impact) to the observability surface.
- `recurrenceCount` is **materialized** (§13.1), incremented transactionally on episode insert —
  no read-time per-issue COUNT (kills the N+1 in the playbook ranking).
- `impactScore = severityWeight(severity) × recurrenceCount`, with optional **recency decay** so a
  long-stale issue doesn't permanently dominate.
- `generalizable` is **derived at read** (bucket ∈ {framework-limitation, instar-integration-gap})
  so a re-classification never leaves a stale flag.

### 13.5 Version lifecycle + regressions
`firstSeenVersion`/`lastSeenVersion` span the live window; `fixedInVersion` marks the fix. A
regression opens a NEW issue with `regressedFromIssueId` → original (history preserved). **Regression
links are auto-suggested** at capture by matching `signature`/`dedupKey` against `status=fixed`
issues; unlinked-but-signature-matching new issues surface as candidate regressions for review (not
left to Stage B's discretion).

### 13.6 Playbook semantics
`GET /framework-issues/playbook?targetFramework=X` returns generalizable lessons from **PRIOR**
frameworks (`framework != X AND generalizable AND playbookStatus ∈ {candidate, extracted}`), ranked
by `impactScore`. The playbook for X is sourced from *other* frameworks' lessons, never X's own.
`playbookStatus` lifecycle `none → candidate → extracted → superseded`. **Promotion owner:**
`none→candidate` may be auto-suggested by Stage B, but **`candidate→extracted` requires a review that
is not Echo-only** (Justin or the weekly review) — the playbook contents are not end-to-end under the
proposer's control. A `fixed` high-`impactScore` issue that never reached `extracted` surfaces as a gap.

### 13.7 `wont-fix` is not a silent escape hatch
`wont-fix` on a `framework-limitation`/`instar-integration-gap` issue requires a recorded
`wontFixReason` and surfaces in the pull review — it cannot silently drop out of impact ranking.

### 13.8 Concurrency
`journal_mode = WAL` + `busy_timeout` (the PendingRelayStore/TokenLedger precedent). Writes go
through a single-writer / CAS `mutate()` pattern (the CommitmentTracker precedent) so concurrent
ticks / multi-framework jobs can't drop observations on `SQLITE_BUSY`. All queries use parameterized
prepared statements (no string interpolation); enum columns (`bucket`, `status`, `playbookStatus`)
validated against fixed allowlists on write.

### 13.9 Fundamental-gap analysis is REQUIRED on every issue (the three questions)

Operator directive (2026-07-17, topic 29723, apprenticeship drive 5): observing a
failure and logging it is tracking, not diagnosis. Every `framework_issues` record
MUST answer three questions before it counts as logged — write-time validation
refuses an insert without them, exactly like the `bucket` requirement (§6):

1. **`rootGapInfrastructure`** — what is lacking in current infrastructure that
   allowed this gap?
2. **`rootGapSentinel`** — does this signal a FAILING sentinel or a MISSING one?
   Enum `failing | missing | neither-unpromoted`; the third value names the drive-5
   recurring case where the guard exists but sits watch-only/dark, so the answer is
   a promotion decision rather than new machinery.
3. **`rootGapStandard`** — what standard would have guided past development to close
   this class ahead of time?

A defect without root-gap analysis is incomplete the same way a feature without tests
is incomplete. This converts the operator's questioning discipline into schema —
Structure > Willpower applied to judgment itself. Canonical concept statement:
`docs/apprenticeship/PROGRAM-CONCEPTS.md` §4. First entries in this schema: drive-5
defects #9 (interrupted-conversation stall), #10 (stream-disconnect stall), #11
(operator pin erased by agent-authority unpin).

## 14. Migration & deployment (three distinct mechanisms — named)

1. **Mentor job** — ships as a **built-in job** under the package's built-in jobs namespace
   (`.instar/jobs/instar/`, the always-overwrite built-in directory — NOT the user-owned
   `.instar/jobs/schedule/`); installs via `installBuiltinJobs()` (called by `migrateBuiltinJobs()`),
   NOT a bespoke migration. Use this exact term and path consistently (§10, §19 refer to the same
   built-in job at `.instar/jobs/instar/`). Disable = the built-in `retired` list + `mentor.enabled:false`.
2. **Config knobs** — added to the canonical `ConfigDefaults.ts` registry, applied by `migrateConfig()`
   with existence checks (§16 lists the fields).
3. **SQLite schema** — `FrameworkIssueLedger` is **instantiated in `server.ts` startup**, so its two
   tables auto-create on first boot of the new version (the CommitmentTracker/TokenLedger lazy-create
   precedent). No schema migration needed — but the spec asserts the startup instantiation explicitly,
   and a wiring-integrity test verifies it (§18).
4. **CLAUDE.md template** — `generateClaudeMd()` gains a Capabilities + Registry-First entry for
   `/framework-issues`; `migrateClaudeMd()` adds a content-sniffed section so existing agents learn it.
5. **Rollback** — disable per (1); the ledger SQLite DB is **intentionally retained** as a read-only
   historical record (it never gates), not orphaned.

## 15. Observability / adversarial telemetry (the instrument)

Per Structure > Willpower, an unmonitored guardrail is a wish. The system exposes (pull surface +
dashboard tab — §16): bucket-distribution-over-time, observations-per-issue-per-hour
(`probable-loop` detection), intervention-rate vs task-difficulty (graduation-gaming detection),
and `stage-a-leak-suspected` counts (two-hats leak detection — §4). These are the instruments that
turn "harden if observed" into a mechanism with an actual observer.

## 16. Config knobs (named fields, defaults, ConfigDefaults-registered)

```
mentor.enabled            bool   default false (ships off)
mentor.mode               enum   off | dry-run | live   default off
mentor.cadenceMs          number default 900000 (~15 min) — opportunistic check interval
mentor.minIntervalMs      number default 600000 — hard floor between ticks (anti-forced-cadence)
mentor.maxRoundsPerTick   number default 1
mentor.maxRoundsPerDay    number default <tuned>
mentor.maxOpenAssignments number default <tuned>
mentor.maxAssignmentsPerDay number default <tuned>
mentor.dailySpendCapUsd   number default <tuned> — below the shared LlmQueue cap
mentor.genericMistakeAuditRate number default 0.1 — sample-audit fraction to Justin (§6)
```
A per-tick cost model (Stage A drive + cheap stuck/ready judgment + Stage B forensics) × expected
active ticks/day × framework count is documented alongside these defaults so the daily ceiling is
set from evidence, not guesswork.

## 17. Security

- Both routes require the standard Bearer token; `503` when unconfigured; `limit` clamped 1..500;
  `targetFramework` validated against a known-framework allowlist.
- `evidence` is opaque references ONLY (§13.2); a **secret-scan + redaction pass** runs at capture
  before any write; the routes are **kept off the dashboard/tunnel surface unless explicitly gated**
  (they return references the caller must already be authorized to dereference).
- All captured free-text (`title`, `signature`, dispute rationale) is treated as data: length-capped
  + sanitized on write; when the playbook seed is later fed to an LLM it is delivered as **quoted
  untrusted data, never as instructions** (closes the stored-injection / poisoned-playbook vector).
- Parameterized queries everywhere; enum allowlists on write; a unit test asserts an injection-style
  `targetFramework` is treated as a literal.
- Codey's conversational replies are untrusted data (§7.1); sender identity is authenticated (§7.2).

## 18. Testing (all three tiers in v0.1 — non-negotiable)

- **Tier 1 (unit):** ledger CRUD, dedup (false-merge resistance), episode collapsing, materialized
  `recurrenceCount` correctness, impactScore + decay, regression auto-suggest, enum/param-injection
  guards, secret-scan redaction, and the leakage detector **with a positive-control** (a
  known-leaked transcript must trip the flag — so a dead detector is distinguishable from a clean run).
- **Tier 2 (integration):** the `/framework-issues` + `/playbook` routes over the full HTTP pipeline
  (auth, 503, clamps, allowlist).
- **Tier 3 (E2E "feature is alive"):** a real mentor tick on the production init path adds an
  observation row (the auto-capture wiring proof), routes return 200 not 503, and the ledger is
  instantiated at server startup (wiring-integrity).
- **Wiring-integrity tests** for every DI'd component (Stage A sub-agent spawn, Stage B capture
  funnel, leakage detector, budget pre-check) — verify deps are not null/no-op and delegate to real
  implementations.

## 19. Build order (multi-part — for /instar-dev after approval)

1. **`FrameworkIssueLedger` + two-table SQLite store (WAL/CAS, indexes, retention) + read-only
   routes + startup instantiation + all 3 test tiers + PostUpdateMigrator(job/config) +
   CLAUDE.md template + migrate.** (Foundation; hardest to unwind — ships complete in one PR, no
   "routes now, migration later.")
2. **Stage B auto-capture** wired into the tick + capture-funnel metric + the "alive" test.
3. **Stage A drive sub-agent** (fresh spawned context, tool-grant + PreToolUse deny) + leakage detector.
4. **Mentor built-in job** (at `.instar/jobs/instar/`, §14.1) + safe-window state machine + budget
   pre-check + cross-agent termination discipline (persist-only delivery + fresh-thread-per-task).
5. **Playbook route + graduation review job + observability surface/dashboard tab** (the dashboard
   tab may ship as a fast-follow). <!-- tracked: topic-13435 -->

Ships staged (off → dry-run on Echo↔Codey → live) per the graduated-rollout standard.

## Amendment (2026-05-29): active task-driving via an onboarding agenda

**In-scope for the original approval** (it makes the existing `assign-next` action usable instead of dormant). Surfaced directly by the live Codey dogfooding run (topic 13435): the highest-signal interactions were the ones where the human DROVE Codey through concrete tasks (capability checks + real dev work); passive "how's it going?" check-ins on an idle mentee were low-signal ("nothing to do"). Two concrete gaps were found:

1. **`getSurface` was a stub** (`(framework) => ({ framework, threadlineHistory: '' })`), so Stage A was BLIND — an empty surface can only ever yield `observe-only` or a generic check-in. The action set already included `assign-next`, but the mentor had nothing to assign and no conversation to reason over.
2. **No backlog.** Even with a real surface, the mentor had no list of concrete onboarding tasks to assign.

### Change

- **`ConversationSurface.onboardingAgenda?: string[]`** — the mentor's own ordered backlog (capability checks + starter dev tasks). It is the mentor's *plan*, not a mentee internal, so it is surface-legitimate: `surfaceText` includes it, and assigning an agenda item is therefore NOT a leak.
- **`buildStageAContext`** gains an agenda block ONLY when an agenda is present: it instructs the mentor, when the mentee is idle (no task in flight / said done / nothing actionable), to `assign-next` the next agenda item not already covered in the conversation — else `observe-only` (mid-task / agenda exhausted) or `unblock`/`answer` (blocked / asked). An empty agenda omits the block entirely → **unchanged passive-observe behaviour**.
- **`getSurface` now builds a real surface**: `onboardingAgenda` from `mentor.onboardingAgenda` config + `threadlineHistory` from the mentee's recent replies (`mentor-replies.jsonl`, parsed defensively) + `timeSinceLastContactMs` from the latest reply. Pure logic (`buildConversationSurface`, `parseMenteeReplies`) is unit-tested; the server is thin glue (read file → parse → build).
- **`MentorConfig.onboardingAgenda?: string[]`** — the opt-in source.

### Ships dark (double-gated)

The mentor is already off by default (`enabled:false`/`mode:'off'`). The agenda is additionally empty by default, so even an enabled mentor keeps today's passive behaviour until an operator sets `mentor.onboardingAgenda`. No fleet behaviour change without explicit opt-in.

### Operator decisions to flag before live rollout

- **Should the automated mentor proactively assign onboarding tasks to mentees fleet-wide?** (a UX/product call for the operator before populating an agenda + enabling.)
- **Fuller conversation surface.** This PR feeds the mentor the mentee's *replies* but not the mentor's *own* prior prompts (their content isn't logged today — `a2a-sent.jsonl` is metadata-only). So agenda rotation is inferred from the mentee's replies. Logging the mentor's sent-prompt content for a complete two-sided surface can be handled as a separate scoped change; acceptable for a dark feature, and the mentor-outstanding tracker already prevents back-to-back duplicate sends.

### Acceptance Criteria (amendment)

M1. With an agenda configured, `buildStageAContext` includes the agenda + assign-next steering; with none, the block is omitted (unchanged prompt).
M2. `surfaceText` includes agenda items so assigning one does not trip `detectStageALeak`.
M3. `buildConversationSurface` renders mentee replies into `threadlineHistory`, caps to the most recent N, computes `timeSinceLastContactMs`, and sets `onboardingAgenda` only when non-empty.
M4. `parseMenteeReplies` is defensive (skips blank/garbage/empty-message lines, coerces `ts`, filters to the named mentee) and never throws.
M5. Empty agenda + no replies → behaviour identical to the prior stub (the passive default).

### Rollback (amendment)

Revert the `onboardingAgenda` field + the `buildStageAContext` agenda block + the `getSurface` builder back to the empty-surface stub. No state/migration/contract change; the reverted-to state is today's passive mentor.

## Amendment (2026-05-29): hot-read mentor config

The active task-driving amendment made `mentor.onboardingAgenda` the operator's opt-in source for the mentor's concrete task list. Dogfooding then surfaced a runtime usability gap: `AgentServer.buildMentorRunner` captured the mentor block from startup config once, so editing the agenda or related mentor settings in the agent config file had no effect until the whole server restarted. That undermines the purpose of an operator-curated onboarding agenda, especially while tuning the curriculum live.

### Change

- **`AgentServer.buildMentorRunner` getConfig hot-reads the mentor block** from the current agent config file each time the runner asks for config.
- **Startup config remains the safe fallback.** The server keeps the startup mentor config snapshot and returns it if the runtime config file is missing, unreadable, malformed JSON, or has a malformed mentor block.
- **Good runtime reads merge with defaults.** A valid on-disk mentor object still inherits `DEFAULT_MENTOR_CONFIG`, preserving existing default behavior while reflecting changed agenda and settings immediately.
- **The runner abstraction stays unchanged.** `MentorOnboardingRunner` still receives a `() => MentorConfig`; the server owns file I/O and defensive fallback.

### Safety and behavior

This does not introduce a new delivery path, topic creation path, or authority surface. It only changes how the already-gated mentor runner reads its existing config. The mentor remains off by default, agenda remains empty by default, and malformed runtime config edits degrade to the startup snapshot instead of throwing into a tick.

### Acceptance Criteria (hot-read amendment)

H1. Changing the on-disk `mentor.onboardingAgenda` is reflected on the next mentor config read without restarting the server.
H2. A missing, unreadable, malformed, or bad-shape runtime config read returns the startup mentor config snapshot and never throws into a status check or tick.
H3. Server-backed mentor status reflects a valid runtime config edit without reconstructing `AgentServer`.
H4. The hot-read logic has unit coverage for agenda updates and fallback-on-bad-read, route coverage for fresh config reads, and server-backed e2e coverage for no-restart behavior.
