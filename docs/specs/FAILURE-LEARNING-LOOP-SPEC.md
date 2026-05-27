---
title: Failure-Learning Loop
slug: failure-learning-loop
author: echo
created: 2026-05-26
owner: echo
status: draft
eli16-overview: FAILURE-LEARNING-LOOP-SPEC.eli16.md
topic: 13201
---

# Failure-Learning Loop — attributing downstream failures to the spec, project, and dev toolchain that produced them

**Status:** DRAFT (pre-convergence). Author: echo · Created: 2026-05-26 · Topic: 13201 (🧹 SessionReaper → Graduated Rollout → this)
**Companion:** `FAILURE-LEARNING-LOOP-SPEC.eli16.md`

> This is the third link in an arc. SessionReaper shipped a risky feature safely; Graduated Feature Rollout made "ship dark, then mature it without forgetting" a structural standard. This spec closes the loop on the *other* side: when something we built later **breaks**, capture it, trace it back to what produced it (the spec, initiative, project — and the dev tools/skills used), and learn from the accumulated record so the dev process itself gets better over time.

---

## 1. Problem — failures teach one person once, then evaporate

Justin (2026-05-26, topic 13201):

> "We are often designing specs that are linked to initiatives and possibly projects, then building, testing, and deploying. However almost ALWAYS there is a failure down the road that is related to what was built. We need a way to track these failures and learn from them. This should be mandatory. Failures should be traced back to the spec/initiative/project/feature they were associated with AND the development tools/skills used to create them (including all review skills/etc). Tracking these can give us better insight into what went wrong and how to fix it AND … we can start analyzing the failure properties and metrics to see what patterns emerge and start identifying gaps in our development process (bad spec? missed something in the review? bad build?). This should all be automatic, and the end result should be a system that continues to improve and design and build with less failures. Finally, we recently decided that it might be beneficial to have different build skills for Instar development vs Other development … This means its critical to be able to trace failures back to the development skills/tools that were used."

**The gap, stated precisely:** instar tracks *forward progress* (specs → initiatives → rollout stages) but has **no backward failure forensics**. When a merged feature breaks weeks later, the fix happens, one agent learns one thing, and nothing structured survives. There is:
- no centralized failure record,
- no link from a failure back to the feature/spec/initiative/project that caused it,
- no link from a failure back to the **dev toolchain** (which build skill, which review skills, how many convergence rounds) that produced the faulty work,
- and therefore no way to ask "*what about how we work keeps letting this class of bug through?*"

That last question is the whole point. Tracking individual failures is table stakes; the value is the **process-level pattern** — a weak spec template, a review angle that never catches concurrency bugs, a build skill that skips a step — surfaced from accumulated, attributed data.

## 2. What already exists (so we extend, not reinvent)

Grounding pass (2026-05-26) against the live codebase:

- **`InitiativeTracker` (`src/core/InitiativeTracker.ts`) — the lineage spine.** Already stores per-feature `specPath`, `prNumber`, `mergeCommitOid`, `ciCheckedAt`, `links[]`, OCC `version`, and a `pipelineStage` enum that already includes **`regressed`** (`outline → spec-drafted → spec-converged → approved → building → merged → regressed → skipped`). Its in-process reconciler already **detects** regression (a merged commit no longer reachable from main → writes `regressed`). Tasks roll up to projects via `parentProjectId` / `rounds[].itemIds`.
- **instar-dev trace files (`.instar/instar-dev-traces/*.json`, schema v2) — the provenance stamp.** The instar-dev commit gate **already refuses any `src/` commit without a trace.** Each trace records `sessionId`, `timestamp`, `specPath`, `coveredFiles`, `artifactSha256`, `secondPass`, `reviewerConcurred`, `phase`. Written by `skills/instar-dev/scripts/write-trace.mjs` at commit time.
- **`DegradationReporter` (`src/monitoring/DegradationReporter.ts`)** — runtime fallback events with a `{redacted, full}` reason split. A *runtime* failure source.
- **Learning registry (`EvolutionManager`, `<stateDir>/learning-registry`)** — `LearningEntry` with `source`, `tags`, `appliedTo`. The natural **output sink** for "what we learned from this failure."
- **Spec frontmatter** — `approved-at`, `review-convergence`, `review-iterations`, `owner`, `slug`, `ships-staged`, plus the `rollout:` block.

**What is missing (verified absent):** any failure record; any attribution join; any record of *which dev skills/tools/versions* built or reviewed a feature (the trace records `secondPass`/`reviewerConcurred` booleans but **not** the toolchain identity); any analysis surface.

## 3. Verdict on Justin's question (own feature vs. extend)

**A net-new capture-and-analysis subsystem, but NOT a parallel silo.** It hangs off the two existing structures rather than duplicating them:

1. **Attribution reuses the InitiativeTracker lineage** (`mergeCommitOid`/`prNumber`/`specPath`/`parentProjectId`) — a failure attaches to an existing initiative record; we do not re-model features.
2. **Toolchain provenance reuses (by enriching) the already-mandatory instar-dev trace** — we add a `toolchain` block to the trace the commit gate already forces. This is the key structural enabler: provenance is stamped *at build time*, never reconstructed.
3. **The "what we learned" output reuses the learning registry.**

The genuinely new pieces are: a **FailureLedger** (the records), an **attribution engine** (the join), and an **analyzer** (the pattern layer). This mirrors the Graduated-Rollout verdict shape ("extend the spine, add the active layer") and the same lesson that drove it: don't build beside existing infra.

## 4. Design

### 4.1 Provenance enrichment — the toolchain stamp (the critical enabler)

The instar-dev commit gate already mandates a trace per `src/` commit, so capture is *already structurally mandatory*; we only enrich **what** it stamps. Trace schema **v2 → v3**, additive:

```jsonc
"toolchain": {
  "buildSkill":   { "name": "instar-dev", "version": "<from SKILL.md frontmatter or skill dir>" },
  "reviewSkills": [
    { "name": "spec-converge", "version": "…", "outcome": "converged", "iterations": 3 },
    { "name": "crossreview",   "version": "…", "outcome": "concurred"  },
    { "name": "code-review",   "version": "…", "outcome": "applied"    }
  ],
  "convergence":  { "models": ["codex","gpt-5.5","claude-x2"], "iterations": 3, "reportPath": "docs/specs/reports/<slug>-convergence.md" }
}
```

- `write-trace.mjs` gains `--build-skill`, `--review-skills`, `--convergence` inputs; the instar-dev / build skills pass them as they invoke the gate. Where a value is unknown the field is omitted (not faked).
- **Migration:** v2 traces lack `toolchain`; the analyzer treats a missing toolchain as `unknown` (a first-class analysis bucket), never an error.
- **Why this matters for the "different build skills" plan:** each build/review skill self-identifies in the trace, so when failures cluster the analyzer can say "work built with skill A regresses 3× more than skill B" — the dev tools become *measurable*. This is the field that makes Justin's final requirement (trace failures to the dev skills used) possible at all.

### 4.2 FailureLedger — the records (multi-source, automatic)

New `FailureLedger` class in `src/monitoring/` (sibling to `DegradationReporter`), persisted via the same pattern the InitiativeTracker uses (TaskFlow when wired, else `<stateDir>/failures.json`), with OCC `version` for single-writer safety. `FailureRecord`:

```jsonc
{
  "id": "FAIL-001",
  "detectedAt": "<ISO>",
  "source": "ci | revert | regression | degradation | agent-diagnosed | bugfix-commit",
  "severity": "low | medium | high",
  "summary": "<short, redacted-safe>",
  "detail": { "redacted": "…", "full": "…" },        // mirrors DegradationReporter's split
  "category": "concurrency | config-parse | wiring | logic | migration | test-gap | …",  // §4.4 classified

  // attribution (the join — never silently guessed)
  "initiativeId": "<InitiativeTracker id>",
  "projectId": "<rolled up from initiative.parentProjectId>",
  "specPath": "docs/specs/<slug>.md",
  "causeCommitOid": "<commit that introduced it>",
  "prNumber": 401,
  "toolchainRef": "<trace file id of the build that produced the cause>",
  "attribution": "automatic | one-tap | inferred",
  "attributionConfidence": 0.0,                       // 0–1; low stays unattributed, see §4.3

  // lifecycle
  "status": "open | attributed | analyzed | resolved | reopened",
  "fixCommitOid": "<commit that fixed it, when known>",
  "learningId": "<LRN-… produced by the analyzer/agent>",
  "createdAt": "<ISO>", "updatedAt": "<ISO>", "version": 1
}
```

**Ingestion sources** (all automatic except where noted):

1. **`regression`** — the InitiativeTracker reconciler **already** writes `pipelineStage: regressed`. We hook that exact transition to auto-open a FailureRecord. The initiative (and thus spec/PR/toolchain) is already known → fully attributed with zero new detection logic. *This is the cheapest, highest-confidence source and the recommended first slice.*
2. **`revert`** — detect `Revert "…"` / `git revert` commits at merge; the reverted commit → its PR → initiative (reverse lookup via stored `mergeCommitOid`/`prNumber`).
3. **`bugfix-commit`** — parse a commit trailer convention: `Fixes-Feature: <initiative-id>` and/or `Fixes: <FAIL-id>`. Links a fix to the feature/failure deterministically, agent-supplied at commit time (one line, not a form).
4. **`ci`** — a lightweight poller (mirroring how the reconciler already checks merge reachability) records a FailureRecord when CI fails on a known feature branch. Attribution via branch → PR → spec → initiative. *(Open question §5: poll vs webhook.)*
5. **`degradation`** — a DegradationReporter event **may** promote to a FailureRecord when it correlates to a known feature (subsystem → initiative map). Off by default to avoid runtime-noise flooding the dev-process ledger; opt-in per subsystem.
6. **`agent-diagnosed`** (the *only* manual surface — one tap) — `POST /failures {summary, initiativeId|specPath, causeCommitOid?, severity}`. When an agent diagnoses a bug that traces to past work, it files one record. A behavioral hook can *prompt* this when a fix commit lands referencing changed feature code — turning even the manual path into a nudge, not a chore.

### 4.3 Attribution engine — automatic where clean, one-tap where not (never silently wrong)

- **Clean chain → automatic, high confidence:** `commit → PR → mergeCommitOid → initiative` reverse lookup off the InitiativeTracker's stored fields.
- **Ambiguous → one-tap:** filed by the diagnosing agent with an explicit `initiativeId`/`specPath`.
- **`inferred` → low confidence, never presented as fact:** a record whose attribution is a guess stays `status: open` / surfaces on the *pull* surface as "needs attribution," and is **excluded from analysis aggregates** until confirmed. The honesty rule from the Telegram framing is structural here: the system says "automatic where the trail is clean, one-tap where it isn't," and a low-confidence guess is labeled, not laundered into a claim.

### 4.4 Analyzer — the pattern layer (signal-only, small-N-honest)

A periodic analyzer (a **sibling** builtin job, *not* folded into the twice-weekly rollout driver — failures want a slower, larger-N cadence; lean: weekly + threshold-triggered) computes metrics over **attributed** records, grouped by provenance dimension:

- failure rate per **build skill** and per **review configuration** (did convergence run? how many iterations? second pass? crossreview?)
- correlations with **spec properties** (skipped convergence, missing ELI16, short spec, no `ships-staged` for a dark-shipped feature)
- **category** distribution and **mean-time-to-failure-after-merge**
- the **`unknown`-toolchain** bucket size (pre-v3 traces) — itself a signal of how much history we can't yet attribute

It emits **findings** → the learning registry (`addLearning`) and out to the feedback channels in §4.5 *only when a trend crosses a support+effect threshold*. Example finding: "5 of 6 concurrency regressions this month were in features whose convergence ran a single iteration — recommend the adversarial reviewer get a concurrency-specific checklist." 

- **Small-N honesty (mandatory):** the analyzer reports counts + a confidence band and **must not escalate a "pattern" below a minimum support count** (default `minSupport: 4`, configurable). Two data points never become a recommendation. This is the dual of the §4.3 attribution-honesty rule.
- **Signal vs authority:** the analyzer *detects and recommends*; it never blocks a merge, never grades a person, never auto-edits a skill. Process changes stay a human decision. (Matches `feedback_signal_vs_authority`, `feedback_notifications_near_silent`.)

### 4.5 How it feeds back to the user — three layered channels (Justin's explicit asks)

The feedback surfaces follow the near-silent standard strictly: **detail lives on a pull surface; only thresholded, decision-bearing insights are pushed; nothing routine ever buzzes the user.** Three channels, by increasing push-aggressiveness:

1. **Dashboard — "Process Health" tab (PULL, full detail).** A new dashboard tab where Justin browses freely:
   - **Ledger view** — every FailureRecord, filterable by feature / project / build-skill / review-config / category / attribution status / time window.
   - **Analysis view** — failure-rate-by-toolchain (which build skill, which review configuration), category distribution, mean-time-to-failure-after-merge, and the size of the `unknown`-toolchain bucket.
   - **Insights board** — the standing recommendations and, critically, **each one's loop status** (discovered → acted-on-via-initiative-X → verified-it-worked / didn't, per §4.9). This is the at-a-glance "is our process actually getting better?" view.
   - Mobile-responsive like the rest of the dashboard, reachable via tunnel; backed by the same `/failures*` routes.

2. **Dedicated "Process Insights" Telegram topic (PUSH, near-silent).** A single, calm, browsable topic (the **Threadline-hub pattern**, NOT a topic-per-event) where the analyzer posts **only** a freshly-discovered, support-thresholded insight — never a per-failure ping, never routine status. Coalesced into one message per analysis run. This is the "an insight was discovered" channel Justin asked for, and it is the *only* thing that arrives unprompted in the normal case. (Echoes the silently-stopped-trio fix: default to a quiet pull surface, push only what's actionable.)

3. **Attention Queue (PUSH, decision-bearing only).** When an insight crosses from "noticed" into "recommend a concrete process change — approve?", it also queues an Attention item so a *pending decision* doesn't get lost in chat scroll. Routine insights never touch the Attention queue.

- **Discoverability (so I reach for this reflexively):** new routes `GET /failures` (filterable), `GET /failures/:id`, `POST /failures` (one-tap), `GET /failures/analysis`, `GET /failures/insights`. Surfaced in `/capabilities` and the Registry-First table so "why do features keep breaking?" / "what's our failure rate by build skill?" / "are our process fixes working?" route me to the live ledger, never to memory. CLAUDE.md template + agent-awareness section updated (Agent Awareness Standard).
- **Projects:** FailureRecords roll up to the owning project via `initiative.parentProjectId`; a project's status view shows its failure history. It sits *inside* Projects, not beside it (same requirement Graduated Rollout honored).

### 4.6 Mandatory + automatic (Structure > Willpower)

- **Provenance stamp:** already mandatory (commit gate refuses untraced `src/` commits); we only enrich it.
- **Auto-capture (`regression`, `revert`, `bugfix-commit`, `ci`, opt-in `degradation`):** structural — hooks/reconciler/poller, zero human step.
- **`agent-diagnosed`:** the single manual surface, minimized to one tap and hook-prompted.

There is no "remember to log the failure" anywhere in the loop. The mandatory-ness Justin asked for is enforced by where the capture lives (the gate + the reconciler), not by instruction.

### 4.6.1 The closed self-improvement loop — track → discover → implement → deploy → verify

This is the heart of the feature, and the part that separates it from a passive "suggestion box." A discovered insight must be able to travel all the way to a *deployed* process improvement — and the system must then *check whether the improvement actually worked*. The loop rides existing rails at every step rather than inventing a parallel pipeline:

1. **Track** — FailureLedger auto-captures + attributes (§4.2, §4.3). No human step.
2. **Discover** — the analyzer surfaces an evidence-backed, support-thresholded process gap (§4.4). Each one is its own small tracked record, persisted alongside the ledger:
   ```jsonc
   "InsightRecord": {
     "id": "INS-001", "discoveredAt": "<ISO>",
     "summary": "concurrency regressions cluster in single-iteration-convergence features",
     "supportingFailureIds": ["FAIL-003","FAIL-007", "…"],   // the evidence; ≥ minSupport
     "recommendation": "give the adversarial reviewer a concurrency checklist",
     "status": "discovered | acted-on | verified-effective | verified-ineffective | dismissed",
     "actedOnVia": "<initiativeId | ACT-id>",                 // §4.6.1 step 3
     "verifiedOutcome": "pending | effective | ineffective | n/a"   // §4.6.1 step 5
   }
   ```
3. **Implement (tracked, never forgotten)** — when an insight crosses the recommend threshold, the system **auto-opens a tracked improvement item**: an **Evolution Action** (via the existing Evolution Action Queue / `/commit-action`) and, when the fix is a real code/skill change, a **draft Initiative on the board** in `needs-user` state. The insight record stores `actedOnVia: <initiativeId|ACT-id>`. This is the same Structure-&gt;Willpower move Graduated Rollout made: the follow-through becomes a property of the system, not of anyone's memory.
   - **Authority guard (signal vs authority):** the system auto-*opens* the tracked item but **never auto-implements**. Turning an insight into an actual spec/skill change is a human decision — the analyzer recommends, Justin approves. The loop cannot rewrite a review skill or a spec template on its own. (Matches `feedback_signal_vs_authority`; mirrors Graduated Rollout's "never flips the switch itself.")
4. **Deploy** — an approved improvement goes through the *standard* path with zero bespoke machinery: spec → `/spec-converge` → `/instar-dev` → merge → **Graduated Rollout** (matures dark → live → default-on). Because that path already auto-registers on the initiative board and already stamps a v3 toolchain trace, the improvement is a first-class tracked feature from the moment it ships.
5. **Verify (the closure — without this it is not a loop).** Because the improvement is itself a tracked initiative with its own toolchain stamp, the analyzer can later ask the only question that matters: **did the targeted failure class actually drop after the change shipped?** The insight record carries a `verifiedOutcome` field the analyzer fills once enough post-change data exists (e.g. "concurrency regressions fell 5/mo → 0 across the 6 weeks after the adversarial-reviewer checklist landed"). Two terminal branches:
   - **Worked** → insight `status: verified-effective`; the learning is confirmed and the loop closes.
   - **Didn't work** → insight **reopens** (`status: verified-ineffective`) and re-enters discovery — the system *knows its own advice failed* and says so, instead of quietly assuming success.
   - **Recursive closure:** if the improvement *itself* later regresses, it is captured like any other feature (§4.2 source #1) — the loop watches its own outputs. There is no special-casing; self-improvement changes are held to the same failure-tracking as everything else.

The net effect Justin asked for: a clear, unbroken path from a failure, to an insight, to a tracked-and-approved change, to a deployed improvement, to evidence that the improvement reduced that class of failure — and an honest reopen when it didn't.

### 4.7 Boundaries (what this is NOT)

- **vs DegradationReporter:** that's *runtime* fallback observability; this is *dev-process* failure forensics. They connect (source #5) but are distinct ledgers.
- **vs Evolution Action Queue:** that tracks self-improvement items. This loop *feeds* it — a thresholded insight auto-opens an Evolution Action (§4.6.1 step 3) — but failures and insights are not themselves evolution items; they are the evidence and the diagnosis that *justify* one.
- **vs Commitments:** promises to the user; unrelated.
- **vs Learning registry:** the registry is the *output sink* (what we learned), not the failure record itself.

### 4.8 Lifecycle / abort / privacy

- **Reopen:** a failure that recurs after `resolved` → `reopened` (links the new occurrence to the prior fix + toolchain — itself a strong process signal).
- **Privacy/redaction:** `detail.{redacted,full}` split mirrors DegradationReporter; any external/user-facing surface uses `redacted`. The ledger may reference internal paths/commits — `full` is internal-only.
- **Backfill bounding:** historical pre-v3 failures (if any are backfilled from `regressed` history) register as `unknown`-toolchain provenance-only entries, never flooding the active analysis.

## 5. Open questions (for convergence + user)

1. **CI ingestion mechanism** — GH Actions poller (keyed on feature branches, mirroring reconciler reachability checks) vs a webhook vs parsing existing CI state. Lean: poller, lowest new surface.
2. **Analyzer cadence + home** — sibling weekly+threshold job (lean) vs folding into the twice-weekly rollout driver. Failures want larger-N than rollout decisions.
3. **Category classification** — rule-based vs LLM-classified (Tier-1 supervised) at attribution time. Lean: LLM-classified, since categories ("concurrency", "wiring") need semantic read.
4. **First slice** — recommend shipping `regression`-source + toolchain-stamp + ledger + `/failures` routes first (highest confidence, reuses existing detection), then layering `revert`/`bugfix-commit`/`ci`/analyzer. Ships behind a flag → **registers itself on the initiative board** via Graduated Rollout (dogfood: this feature is itself a staged rollout).

## 6. Testing (3-tier, NON-NEGOTIABLE per Testing Integrity Standard)

- **Unit:** FailureLedger CRUD + OCC; attribution engine on clean-chain AND ambiguous inputs (both sides of the boundary); trace v3 schema + v2→v3 migration; analyzer metric math + the `minSupport` small-N guard (must refuse to escalate below threshold); redaction split.
- **Integration:** `/failures`, `/failures/:id`, `/failures/analysis`, `POST /failures`; the reconciler-`regressed` → auto-record wiring (wiring-integrity test: the hook is actually attached, not a no-op).
- **E2E:** Phase-1 "feature is alive" (routes return 200, not 503, on the production init path); **dogfood proof** — drive a real `regressed` transition and assert an attributed FailureRecord appears on its own with the correct initiative + toolchain join.
- **Closed-loop (§4.6.1):** an insight crossing threshold auto-opens an Evolution Action + draft initiative with `actedOnVia` set (and does NOT auto-implement — authority guard asserted on both sides); a post-change drop in the targeted failure class flips the insight to `verified-effective`; *no* drop flips it to `verified-ineffective` and reopens it. Dashboard "Process Health" route returns the insights board with loop status; the Process-Insights topic post fires only on a thresholded insight (and never per-failure).

## 7. Migration parity (Migration Parity Standard)

- Trace schema v2→v3 additive (no migration needed to *read*; `write-trace.mjs` enrichment ships in the skill).
- `failures.json` / TaskFlow records: new state, created lazily.
- New routes + `/capabilities` + Registry-First entries → CLAUDE.md template (`generateClaudeMd`) update + `migrateClaudeMd` content-sniff.
- Analyzer job: builtin job (always-overwrite migration path).
- `instar-dev` / `build` skill enrichment: skill-content migration via `PostUpdateMigrator` allowlist.

## 8. Success criteria

A merged feature that later regresses produces — with no human step — a FailureRecord attributed to its initiative, spec, project, cause commit, and the dev toolchain that built it. After enough records accumulate, the analyzer surfaces an evidence-backed, support-thresholded insight; it shows up on the dashboard's Process Health tab, posts once to the Process-Insights topic, and **auto-opens a tracked improvement that a human approves** — which then deploys through the normal spec→build→rollout path. Finally, the analyzer **verifies whether the targeted failure class actually dropped**, marking the insight effective or reopening it if not. The end state is the unbroken, honest loop Justin asked for: tracking → discovery → (approved) implementation → deployment → verification — so the system measurably builds with fewer failures over time, and admits when a fix didn't take.
