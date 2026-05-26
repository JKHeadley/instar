---
title: Graduated Feature Rollout
review-convergence: "3-way (codex/gpt-5.5 + 2 code-grounded Claude passes), 2026-05-26"
approved: true
eli16-overview: GRADUATED-FEATURE-ROLLOUT-SPEC.eli16.md
topic: 13201
---

# Graduated Feature Rollout — making the InitiativeTracker self-populating and self-driving

**Status:** v2 CONVERGED + RATIFIED (user-approved 2026-05-26, topic 13201; driver cadence = twice weekly). codex cross-model + 2 code-grounded Claude passes.
**Topic:** 13201 (🧹 SessionReaper → generalized)
**Author:** echo · **Created:** 2026-05-26 · **Converged:** 2026-05-26
**Companion:** `GRADUATED-FEATURE-ROLLOUT-SPEC.eli16.md`

> **Convergence changelog (v1→v2).** Review (grounded in the real tracker code) found the strategy right but the v1 design wrong in concrete ways; all fixed below:
> - **§4.3 was factually false** — auto-complete is *phase-based*, not `pipelineStage`-based (`InitiativeTracker.ts:918-923,1136-1142`). Rewritten: model rollout stages as real `phases[]` (keeps the initiative `active`), and the genuine risk is the *irreversible* terminal TaskFlow `succeeded` state when the last phase goes `done` (`:592,640-647`) — so `default-on` must NOT mark the final phase done / must stay reopenable for regression.
> - **`POST /initiatives` drops `kind`/`pipelineStage`/`parentProjectId`/`specPath`/`prNumber`** (`routes.ts:5725,5743-5746`) — auto-registration MUST run **in-process** against the tracker (Open Decision 1 resolved to the in-process reconciler), not over HTTP.
> - **Retroactive `parentProjectId` attach is rejected** by bidirectional validation (`:1101-1120`) — auto-registered tasks are **top-level**; project membership stays a deliberate `/instar-project` act.
> - **Near-silent violation** — every-session digest injection leaks routine noise; narrowed to a `needs-user` *edge* trigger.
> - **`default-on` authority** — the rollout phase is *derived from the observed config flag*, never the reverse → silent auto-default-on is structurally impossible.
> - **`/capabilities` suppression of `initiatives` is intentional** (`CapabilityIndex.ts:739`, "surfaced inside evolution subsystems") — un-suppression is now argued, not asserted as oversight.
> - Added: lifecycle/abort branches (§4.7), boundaries vs Evolution Queue/Commitments (§4.8), backfill bounding, id-normalization + `ifMatch` OCC, the `ships-staged` residual-manual backstop, and session-start hook migration. Full table: §9.

---

## 1. Problem — two asks, one gap

Justin (2026-05-26), after SessionReaper shipped behind a dry-run/off flag with a hand-authored weekly promotion-review job:

> "We should make this 'review job' a standard for features like this that need time to mature and develop. … please spec this properly, and see if it needs its own feature or if we can just leverage the initiative tracker. Also, I want to make sure the initiative tracker is actually being used. … If this initiative was NOT already automatically added to that tracker then I think our infra/sentinels needs improving to better match the goal of 'users should not have to know' (i.e. Instar optimally takes advantage of its own features/infra automatically)."

**The dogfood finding (verified 2026-05-26):** the InitiativeTracker is live and works, but its **only** creation paths are an explicit `POST /initiatives` or the `/instar-project` skill. There is **no auto-capture** — nothing watches specs, topics, commits, or PRs and registers an initiative. Consequence:
- **SessionReaper** — a fully spec'd, converged, ratified, built, and merged feature — **never entered the tracker.**
- This very "graduated rollout" idea wasn't auto-added either.
- The only items in the tracker are `codex-full-parity*`, present solely because someone ran `/instar-project`.

So the tracker is a **passive ledger that depends on an agent remembering to register** — the exact "users shouldn't have to know / Instar should use its own infra automatically" violation Justin named.

**The realization:** Justin's two asks are the **same underlying gap**. A graduated rollout needs (a) something to *create* the track without anyone remembering, and (b) a recurring driver that *surfaces the decision* to advance. Those are precisely the two things missing for the tracker to be "actually used." Fix them once and both asks are satisfied.

## 2. What already exists (so we extend, not reinvent)

`docs/specs/INITIATIVE-TRACKER-SPEC.md` + `src/core/InitiativeTracker.ts` already provide:
- **Arbitrary per-initiative `phases[]`** with independent `status` (`pending|in-progress|done|blocked`) — phase status is decoupled from initiative status.
- **`pipelineStage`** enum that *already models the dev lifecycle*: `outline → spec-drafted → spec-converged → approved → building → merged → regressed → skipped`.
- **`needsUser` + `needsUserReason`**, **`nextCheckAt`**, **`links[]`** (spec/PR/commit/topic/doc), **`blockers[]`**.
- **`GET /initiatives/digest`** already computes `stale` (>7d untouched), `needs-user`, `next-check-due`, `ready-to-advance`.
- Full CRUD routes + phase-advance route + OCC versioning + TaskFlow persistence.

**What's missing (the active layer):**
1. **No auto-registration** — §1's gap.
2. **No recurring driver** — the InitiativeTracker spec itself promised a "daily digest job that pings the user when a card goes stale / needs a decision / is ready to advance" and it was **never shipped** (the endpoint exists; nothing calls it). This is the deferred piece this spec resurrects.
3. **No post-ship rollout semantics** — when all phases are `done`, the initiative auto-`completed`s and drops off; there's no first-class "shipped but still maturing (dry-run → live → default-on)" lifecycle.

## 3. Verdict on Justin's question

**Not its own feature — leverage the InitiativeTracker and add the active layer.** A graduated rollout is an initiative whose phases are rollout stages; the tracker's `needsUser`/`nextCheckAt`/`links`/`digest` are exactly the evidence-gate + surfacing primitives. We add: auto-registration, one recurring driver, and post-ship lifecycle rules. The bespoke `session-reaper-promotion-review` job becomes the **first instance** that the generic driver subsumes (it retires once this ships).

## 4. Design

### 4.1 Layer A — Auto-registration (closes the dogfood gap)

Registration is triggered by artifacts that already exist in the workflow, so there is no step for anyone to remember (no-manual-work standard). **It runs in-process** (a server-wired reconciler calling the `InitiativeTracker` instance directly) because `POST /initiatives` deliberately drops `kind`/`pipelineStage`/`parentProjectId`/`specPath`/`prNumber` (`routes.ts:5743-5746`) — the public create surface can't carry what registration needs.

- **Dev-lifecycle tracking (every feature):** the instar-dev flow already emits durable artifacts — an approved spec (frontmatter `approved: true`), a trace (`.instar/instar-dev-traces/*.json` with `specPath`/`prNumber`), and the PR/merge. The reconciler upserts a `kind:'task'` initiative and advances `pipelineStage` from artifact state: spec on disk → `spec-drafted`; convergence frontmatter → `spec-converged`; `approved:true` → `approved`; trace/PR exists → `building`; merge commit reachable from main → `merged`. **SessionReaper would have auto-appeared at approval and walked itself to `merged` with zero manual registration.**
- **Rollout tracking (ships-dark features):** spec frontmatter **`ships-staged: true`** (+ a `rollout:` block: `flagPath`, `evidenceSource`, per-stage `promotionCriteria`) appends rollout stages as **real `phases[]`** — `[dry-run, live, default-on]` — after `merged`. Because completion is phase-based (§4.3), modelling stages as phases is exactly what keeps the initiative `active` post-ship.

**Reconciler mechanics (the feasibility-critical details):**
- **Trigger:** a server-wired reconciler (Open Decision 1, resolved) on a bounded cadence — a since-last-run scan keyed on spec mtime + trace mtime + `git log` since the last processed commit (the `TokenLedgerPoller` byte-offset pattern), **not** a full rescan each tick. Idempotent + self-healing; it also backfills (bounded — see below).
- **Id derivation + dedupe:** initiative id = normalized spec slug (lowercased, `[^a-z0-9-]`→`-`, **truncated to 63 chars** per `InitiativeTracker.ts:895`); on truncation collision, suffix a short hash. Re-runs are storage-idempotent (TaskFlow keys on `idempotencyKey=initiative:<id>`), so upsert never duplicates. **A renamed/moved spec** is detected by matching `specPath`/trace identity, not just slug, so it updates the existing record instead of orphaning a stale one.
- **OCC:** every reconciler write passes `ifMatch` (the read `version`) so it can't last-writer-clobber a concurrent driver write (`update()` only enforces OCC when `ifMatch` is supplied, `:992-998`).
- **Backfill is bounded (anti-flood):** the first run does NOT register all ~57 historical specs as `active`. Historical merged specs register directly in a **terminal** state (recorded for provenance, not surfaced as in-flight); only specs merged within a recent window, or carrying `ships-staged`, become `active` rollout tracks. SessionReaper (recent + ships-staged) and this spec are the intended live tracks.

### 4.2 Layer B — The recurring rollout-review driver (one job for all)

A single scheduled job (the InitiativeTracker spec's long-deferred digest job, finally shipped), running **twice weekly** (e.g. Mon + Thu; user-ratified cadence 2026-05-26) that each run:
1. Calls `GET /initiatives/digest` for `stale` / `needs-user` / `ready-to-advance`.
2. For rollout-stage initiatives, gathers evidence from the declared `evidenceSource` (e.g. `logs/sentinel-events.jsonl` filtered by feature), checks `promotionCriteria`, and sets `needsUser:true` + a `needsUserReason` recommendation when a stage is ready (or flags an anomaly immediately).
3. Posts a single consolidated, plain-English digest to the user (near-silent: only when something needs a decision, is anomalous, or is stale — matching `feedback_notifications_near_silent`).
4. **Advancement is operator-gated AND flag-derived (no auto-default-on).** The driver only *recommends* ("evidence is clean — flip `flagPath` to live/default-on?"). The **human flips the config flag**; the next reconciler run *observes* `flagPath` in live config and advances the phase to match. Phase advancement is an **observation of the flag, never a command that sets it** — so a feature can never silently reach `default-on` without a human changing `ConfigDefaults`. The driver never mutates `flagPath`.

This **generalizes** the bespoke `session-reaper-promotion-review.md` job to every tracked initiative.

### 4.3 Layer C — Post-ship lifecycle (corrected against the real code)

The tracker's auto-completion is **phase-based, not stage-based**: `setPhaseStatus` flips the initiative to `completed` only when *every* `phases[]` entry is `done` (`InitiativeTracker.ts:918-923,1136-1142`); `pipelineStage` is never read by the status machine. So the v1 worry ("auto-completes at `merged`, drops off") was wrong — modelling rollout stages as real `phases[]` (§4.1) is *exactly* what keeps the initiative `active` through `dry-run → live`, since those phases aren't `done` yet.

The **real** hazard the code imposes: when the *last* phase goes `done`, the initiative → `completed`, and the backing TaskFlow record goes terminal `succeeded`, which is **immutable** (`:592,640-647`) — no later `update()` can reopen it. A `default-on` feature that later **regresses** could not reuse the record. Therefore:
- `default-on` is represented by the **flag observation** (§4.2.4), and the track is **archived** (not driven to all-phases-`done`) when the flag reaches default-on — keeping the record reopenable if the feature is rolled back (which writes the existing `regressed` pipelineStage and reactivates the track).
- This is the §4.7 termination path, not an auto-complete.

### 4.4 The standard (docs/STANDARDS-REGISTRY.md entry)

> **Graduated Feature Rollout.** Any feature that ships behind a dry-run/off flag and matures over time MUST declare `ships-staged` in its spec. Doing so auto-registers a rollout track on the InitiativeTracker; the rollout-review driver then surfaces a recurring, evidence-gated promotion recommendation until the feature reaches default-on. No ship-dark feature may rely on author memory to advance.

### 4.5 Layer D — Discoverability & agent awareness (so the day-to-day agent actually uses it)

Auto-population (Layer A) makes the tracker *authoritative*; this layer makes the agent *reach for it reflexively*. Without it, "what are we working on?" still gets answered from memory — the exact failure mode. Three structural wirings (Structure > Willpower — the agent shouldn't have to remember the tracker exists):

1. **Registry-First table** (`src/scaffold/templates.ts` `generateClaudeMd` §"Registry First, Explore Second", ~line 664): add a row — *"What are we working on? / status of a project or initiative? → `GET /initiatives` + `GET /projects` (and `GET /initiatives/digest` for what needs attention). NEVER answer from memory."* This is the mandatory-lookup gate that turns the reflex on.
2. **`/capabilities`**: `/initiatives` is currently *deliberately* suppressed from the capability matrix (`CapabilityIndex.ts:739`, reason "surfaced inside evolution subsystems") while `/projects` is present. We **revisit that decision** (not "fix an oversight"): first verify whether the `evolution` capability entry already makes `/initiatives` discoverable; if not, un-suppress it — justified precisely by Layer D's requirement that the agent reach for `/initiatives` reflexively.
3. **Session-start injection — edge-triggered, NOT level (near-silent).** Injecting "when the digest is non-empty" would fire nearly every session once Layer A populates the tracker — routine noise that violates the Near-Silent standard. Instead the hook injects a line **only on a `needs-user` edge**: an initiative that became `needs-user` since the last injection (deduped, so the same pending decision is not re-injected every session). Counts, `stale`, and `ready-to-advance` stay **pull-only** (the `/initiatives/digest` endpoint + dashboard). So a session boots quiet unless a *new* decision is genuinely waiting.

Net effect: when Justin asks "what's going on with X / what are our open initiatives," the agent's first move is the tracker (Registry-First reflex), not recollection — and because Layer A keeps it populated, the answer is real. Routine status is always available on pull; only genuinely-new decisions push.

### 4.6 Projects integration (one tracker, not a parallel structure)

The tracker already unifies two `kind`s: **`project`** (parent; has `rounds[]`, `sourceDocs`, child tasks) and **`task`** (the unit of work; carries `pipelineStage`, `parentProjectId`, and — per this spec — rollout phases). The `/instar-project` skill (create/status/next/advance/drift/run-round/halt/ack/resume/abandon/accept-partial/claim-ownership) already drives projects. This spec must slot INTO that model, not beside it:

- Auto-registered features are **top-level `kind:'task'` initiatives** (`parentProjectId` unset). Retroactive attach to a project is **not possible**: `assertValidParentProject` (`InitiativeTracker.ts:1101-1120`) rejects any `parentProjectId` whose project doesn't *already* list the child in some `rounds[].itemIds`, and only `createProjectAndChildren` (via `/instar-project`) seeds that membership at create time. So project membership is established **only** by the deliberate `/instar-project` PlanDoc flow — auto-registration never bolts a task onto an existing project.
- The recurring driver (Layer B) and the digest/discoverability (Layer D) span **both** projects and standalone tasks — one surface answers "what are we working on" across the whole tracker.
- Rollout phases (`dry-run→live→default-on`) live on the task initiative and are orthogonal to project `rounds` (rounds = build sequencing; rollout = post-ship maturation).
- No new persistence or API namespace — everything stays on the existing InitiativeTracker + TaskFlow store. Auto-registration creates only `task`s; promoting a cluster into a `kind:'project'` stays a deliberate `/instar-project` action.

### 4.7 Lifecycle & termination (the abort/stall branches)

Rollout systems fail on the non-happy-path, so each abnormal artifact state maps to an explicit reconciler transition (no card lingers as permanent `stale` noise):

| Situation | Reconciler action |
|-----------|-------------------|
| Spec on disk, never `approved` for N weeks | move task to `skipped` (existing stage), drop from active digest; reactivate if it later gets approved |
| PR closed without merge | revert stage `building → spec-converged`, set a quiet `paused` if no progress for N weeks (no nagging) |
| Merged, no `ships-staged` | register terminal/archived (provenance only; never an active rollout track) |
| `ships-staged`, flag reaches `default-on` | **archive** the track (reopenable), do NOT drive all-phases-`done` (avoids the immutable-terminal trap, §4.3) |
| Feature reverted after `default-on` | reconciler observes the flag dropped → writes `regressed`, reactivates the track |
| **Rollout stalls in `dry-run` indefinitely** | **nag-decay:** the driver recommends for K digest cycles, then stops recommending and parks the track in a quiet `needs-user`/`paused` state that requires an explicit user "resume" — never nag-forever (this is the SessionReaper case itself) |

**Archival/retention:** in-rollout tracks do not emit the `stale` digest reason (they're intentionally long-lived); archived/terminal tracks leave the active set. This caps digest growth so Layer D stays near-silent.

### 4.8 Boundaries with adjacent systems (no double-coverage)

Three registries already exist; this spec must not create a fourth or double-nag:
- **InitiativeTracker (this spec):** multi-session feature/project lifecycle + post-ship rollout. The new driver owns rollout-stage surfacing.
- **Evolution Action Queue** (`/commit-action`, the `evolution-overdue-check` job every 4h): discrete self-improvement commitments. A stalled rollout is **not** an evolution action — the rollout driver and `evolution-overdue-check` must read disjoint registries so the same stalled item is never surfaced by both. (Convergence to confirm the queries don't overlap.)
- **Commitments** (`/commitments`): promises to the *user*, not feature lifecycle.

**`ships-staged` residual-manual backstop:** declaring `ships-staged` in frontmatter is the one author-memory step. Closed structurally per Signal-vs-Authority: the reconciler/convergence detects a spec that adds a config flag defaulting to `false`/`dryRun:true` but lacks `ships-staged`, and *signals* "this looks ship-dark — declare `ships-staged` or mark intentional." Detect-don't-trust-memory.

## 5. Open decisions (most resolved in convergence; remaining for ratification)

1. ~~Auto-registration trigger~~ — **RESOLVED:** in-process server-wired reconciler (HTTP create can't carry the fields).
2. **Rollout metadata storage** — typed `rollout` fields ON the `Initiative` schema (`flagPath`, `evidenceSource`, `promotionCriteria`, `lastDigestNotifiedAt`) vs a small sidecar rollout registry keyed by initiative id. **Recommend typed fields on the schema** (operational criteria must not hide in free-form phase summaries — codex finding #9); convergence to confirm the schema extension + its TaskFlow persistence.
3. **Evidence source contract** — recommend a small typed adapter (`{type:'log-filter'|'endpoint', ...}`) so criteria evaluation is unit-testable.
4. **Dev-lifecycle tracking scope** — **RESOLVED toward bounded:** ALL approved specs are *recorded*, but only recent-merge or `ships-staged` specs become `active` tracks; historical specs register terminal (provenance), so the tracker isn't flooded (§4.1 backfill bound).
5. **Project attach** — v1 keeps auto-registered tasks **top-level** (retroactive attach is validation-rejected, §4.6). A future atomic "attach-child-to-round under OCC" op (codex finding #4) could allow auto-attach later — deferred to a follow-up <!-- tracked: topic-13201 -->, not v1.

## 6. Standards conformance

- **Structure > Willpower / no-manual-work:** registration + surfacing are triggered by existing artifacts, not author memory — the heart of the spec.
- **Near-silent:** the driver posts only decisions/anomalies/stale, consolidated.
- **Signal vs authority:** the driver recommends; the user authorizes phase advancement.
- **Dogfood / self-hosting:** Instar uses its own InitiativeTracker automatically (directly answers Justin).

## 7. Testing (3-tier) + migration parity

- **Unit:** auto-registration upserts/advances pipelineStage from artifact state (idempotent, OCC-safe); post-ship lifecycle keeps rollout initiatives `active` past `merged`; evidence-criteria evaluation; digest reasons.
- **Integration:** the reconciler over the HTTP tracker creates a `merged` initiative for an approved+merged spec and a rollout initiative for a `ships-staged` spec; the driver sets `needsUser` from evidence.
- **Discoverability (Layer D):** `/capabilities` surfaces `/initiatives` (un-suppressed); the generated CLAUDE.md Registry-First table has the "what are we working on → GET /initiatives+/projects" row; **session-start injects ONLY on a new `needs-user` edge and de-dupes** (no injection when the digest is unchanged — the near-silent test). Lifecycle: each §4.7 abnormal state drives the specified transition (abandoned→skipped, closed-PR→paused, revert→regressed, stall→nag-decay). Auto-registered tasks are top-level (no parentProjectId).
- **E2E:** feature-alive (digest job runs on the production init path); a `ships-staged` spec end-to-end produces a tracked rollout track whose phase is **derived from the observed flag**, surfacing a recommendation without ever flipping the flag itself; **backfill test: an existing approved+merged spec gets a terminal record, a recent ships-staged one gets an active track** (the SessionReaper retroactive case).
- **Migration parity:** the driver ships as a real builtin job template (`src/scaffold/templates/jobs/instar/`), lock regenerated/signed; because `InstallBuiltinJobs` **preserves operator `enabled`** on re-install, flipping its default off→on later needs an **explicit versioned migrator** (codex finding #8), not just a frontmatter change. The reconciler is server-wired (existing agents get it on update). The session-start injection rides the **always-overwrite `instar/` hook** path (`migrateHooks`); the Registry-First row needs a **`migrateClaudeMd` content-sniff guard** (template edit alone doesn't reach existing agents). STANDARDS-REGISTRY entry. `ships-staged` frontmatter + the typed rollout schema fields are additive.

## 8. First validation (dogfood, before/with rollout)

As the immediate proof, the reconciler (or a one-shot backfill) MUST register the already-merged **SessionReaper** as a tracked initiative at `merged` + rollout `dry-run`, and this **Graduated Feature Rollout** spec as a tracked `task` initiative — without anyone hand-adding them. If that backfill makes both appear in `GET /initiatives`, the gap Justin named is closed and demonstrated. (Interim: both were registered *manually* on 2026-05-26 to demonstrate the tracker works; the reconciler replaces the manual step.)

## 9. Convergence findings → fixes (codex/gpt-5.5 + 2 code-grounded Claude passes)

| # | Sev | Finding (all three reviewers converged) | Fix in v2 |
|---|-----|------------------------------------------|-----------|
| 1 | BLOCKER | §4.3 false — auto-complete is phase-based, not `pipelineStage`-based; real risk is irreversible terminal `succeeded` at last-phase-done | §4.3 rewritten; rollout stages = real `phases[]`; `default-on` archives (reopenable), never drives all-phases-done |
| 2 | BLOCKER | `POST /initiatives` drops `kind`/`pipelineStage`/`parentProjectId`/`specPath`/`prNumber` | §4.1: reconciler runs **in-process**, not over HTTP |
| 3 | BLOCKER/MAJOR | Lifecycle/abort branches unspecified (abandoned/closed-PR/revert/stall) | §4.7 lifecycle table + nag-decay |
| 4 | BLOCKER/MAJOR | Every-session digest injection violates near-silent | §4.5.3: `needs-user` **edge-trigger** + de-dupe; rest pull-only |
| 5 | MAJOR | Retroactive `parentProjectId` attach is validation-rejected | §4.6: auto-registered tasks are **top-level**; membership only via `/instar-project` |
| 6 | MAJOR | Unbounded tracker growth / no archival; `stale` fires forever | §4.7 archival; in-rollout tracks don't emit `stale`; §4.1 bounded backfill |
| 7 | MAJOR | id truncation/rename/dedupe + missing OCC `ifMatch` | §4.1: normalize+truncate+hash, specPath-identity rename match, mandatory `ifMatch` |
| 8 | MAJOR | `default-on` authority — phase could drive the flag | §4.2.4 / §4.3: phase is **derived from the observed flag**; driver never sets it |
| 9 | MAJOR | Overlap with Evolution Action Queue (`evolution-overdue-check`) | §4.8 disjoint-registry boundaries |
| 10 | MAJOR | `/capabilities` suppression of `initiatives` is intentional (`CapabilityIndex.ts:739`) | §4.5.2: revisit-and-argue the un-suppression, verify evolution entry first |
| 11 | MAJOR | Rollout metadata (`flagPath`/`evidenceSource`/`promotionCriteria`) not in schema | §5.2: typed `rollout` fields on `Initiative` (not free-form summaries) |
| 12 | MAJOR | Builtin default off→on can't flip via frontmatter (`enabled` preserved on re-install) | §7: explicit versioned migrator for the default flip |
| 13 | MINOR | `ships-staged` is a residual manual step | §4.8 backstop: reconciler signals when a ship-dark spec lacks the flag |
| 14 | MINOR | session-start hook + Registry-First row missing from migration list | §7: always-overwrite `instar/` hook + `migrateClaudeMd` guard |
| 15 | MINOR | reconciler cadence/cost unsized | §4.1: bounded since-last-run scan (TokenLedgerPoller pattern) |
