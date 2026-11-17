# Side-Effects Review — Project apps, part 1 (builtin apps one tap from a project)

**Version / slug:** `project-apps-builtin`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `required (owner-proof gate on an answer route) — see below`

## Summary of the change

Implements `docs/specs/project-apps.md` (converged 6 rounds, approved by Justin, topic 141385 2026-11-16 16:34 PST). A new replicated journal kind `project-app-record` (`src/core/ProjectAppStore.ts`: schema, builders, folds, pin step logic) carries the agent's one offer per (project, app), the owner's answers and the link-pin steps. `src/server/ProjectAppsRuntime.ts` holds the fold, writes offers/answers, and carries out pin steps on the acting machine; `src/server/projectAppsRoutes.ts` mounts the offer / answer / pin-retry / opened / stats routes; `src/server/workProjectsRoutes.ts` adds `apps`/`offers`/`answers`/`addable` to each Work row (and an `invalidate()`); `src/server/projectAppSummaries.ts` derives the maturation board's summary from the board's own pool-scope read over loopback (never stored, never awaited on the Work read). Wiring: `src/core/CoherenceJournal.ts` (the kind's per-kind maps), `src/core/JournalSyncApplier.ts` (state-sync flag), `src/commands/server.ts` (kind registration, store forced on with the switch, runtime construction, commit observers), `src/server/routes.ts` + `src/server/AgentServer.ts` (late-bound runtime), `src/messaging/TelegramAdapter.ts` (`editTopicLinkMessage`, reusing the dashboard-link edit-rejection rules). Console: project rows, offers, Add app, conversation strip (`dashboard/console/*`). Registries: awareness entry, CapabilityIndex, WriteDomainRegistry, feature ladder `projectApps.builtin`. Config: `projectApps.enabled` (dev-gated; needs the Chief of Staff).

Two implementation choices narrower than the spec text, both safer: (1) the summary refresh reads the board route over loopback instead of lifting its cache out of the closure — it reuses the route's 60 s cache and 12/min pool limit exactly; (2) the acting machine for a pin step is decided when the step runs (registered conversation owner, else lease holder) rather than written into the act — acts replicate to every machine, so the machine that is acting at fire time consumes them, and a stale holder stops before its next platform call because the check is made before every call.

## Decision-point inventory

- `attach`/`detach` owner-proof gate (projectAppsRoutes answer route) — add — a plain Bearer is refused `owner-proof-required`; owner proof is the dashboard operator session.
- Agent `withdraw` only while offered (runtime.answer) — add — the agent can take back its own open suggestion, never undo an owner's answer.
- One offer per (project, app ref); refused after a no (runtime.offer) — add.
- Offers only on the lease holder (runtime.offer) — add.
- A new platform message only from an act (nextPinAction) — add.
- Builtin app ref → page/title (BUILTIN_APPS) — add, closed list.

---

## 1. Over-block

- A Bearer `attach` is refused even when the owner said yes in chat: by design (spec §3.3, approved point 6) — the owner taps Attach on the Work row; the refusal says so in plain words.
- An agent cannot re-offer after the owner withdrew/declined, even if circumstances changed: the owner can still attach from Add app (listed with "you said no on …"), so nothing is lost.
- On a machine that is not the lease holder, offers answer 409 `not-lease-holder`; agent sessions for Telegram topics normally run on the holder. Acceptable.

## 2. Under-block

- The operator session is not proof against a hijacked agent that reads its own PIN (spec §4, §8, stated honestly). Accepted for builtin apps: an attach gives such an agent nothing it lacks (it can already post and pin messages). Custom apps (companion spec) will need a phone presence signature.
- Replicated records are shape-validated only; authority rests on the writing route (same as `binding`). Queued as feedback in the run report.
- A crash between Telegram accepting the link message and the `posted` step can leave the pair `uncertain`; re-posting is then a deliberate tap.

## 3. Level-of-abstraction fit

The record kind follows the established per-kind replicated-store pattern (`work-card-record`, `chief-of-staff-record`); the Work row reuses `/work/projects`; owner proof reuses the dashboard operator session; the Telegram edit reuses `takeTelegramEditRejection`; the summary reuses the board's own route. Nothing re-implements an existing primitive.

## 4. Signal vs authority compliance

The gates here are deterministic invariants on a closed domain (who may attach, once-per-pair offers, closed builtin list), each classified with basis and evidence in the spec's Decision points table. No brittle detector holds authority over a judgment call: when to offer is the agent's judgment within the once-per-pair floor.

## 4b. Judgment-point check (Judgment Within Floors standard)

"When to offer" is the only competing-signals point; it is a judgment-candidate (agent judgment from conversation cues) within a structural floor (once per pair, never after a no). No static heuristic was added there.

## 5. Interactions

- Commit observers: added `project-app-record` branches next to `work-card-record`; no change to other kinds.
- The `/work/projects` cache: `invalidate()` added; the 10 s cache otherwise unchanged.
- The maturation board route: read over loopback at most once per 60 s window when a Work read finds the summary stale; a 429 keeps the last value.
- Telegram: one link message per deliberate act through `sendToTopic` with a stamped notification envelope; `setTopicMessagePin` as the existing pin path; `editTopicLinkMessage` mirrors the dashboard-link broadcast's edit rules.
- PR #3247 (owner pause) touches ChiefOfStaffStore; this change does not modify that file.

## 6. External surfaces

- New routes (listed in CapabilityIndex); new fields on `/work/projects` (additive, only when on).
- One pinned message in a project's Telegram topic per attach (live on Echo by intent; never edited for summary changes; an address change edits it in place).
- New config key `projectApps.enabled` (dev-gated; absent = default).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes: the Open button sits on the collapsed project row next to the headline; offers show Attach first.
2. **Zero raw internals as primary content?** Yes: titles come from code ("Feature maturation board"), states are words ("Couldn't pin the link in Telegram: …"); app refs never shown.
3. **Destructive actions de-emphasized?** Remove sits in the row details as a quiet button below the app's Open/headline.
4. **Plain language + phone width?** Plain words throughout; checked at 390x844 and 1280x728 in the live proof recorded in the PR.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **replicated** — offers, answers and pin steps ride the `project-app-record` coherence-journal kind (JournalSyncApplier, `multiMachine.stateSync.projectApps`, forced on with the switch). Older machines skip the unknown kind (applyStream returns early), so their other syncs are unaffected.
- Builtin summaries hold no state (derived on read from the pool-scope board).
- User-facing notices: the pinned link is sent only by the acting machine (conversation owner, else lease holder), once per act.
- URLs: built from the agent's stable public base (named tunnel, else the current tunnel URL), recorded on the step, edited in place when it changes.
- **Status surfaces:** `GET /work/projects/apps/stats` — counts from the replicated fold (whole agent) plus Open taps recorded on this machine's log (machine-local detail, stated in the field name `opens`).

## 8. Rollback cost

Turn `projectApps.enabled` off: routes answer 503, rows omit the new fields, no pin step runs. Records stay inert in their own kind; pins already made stay as ordinary pinned messages. A revert of the code removes the kind; older-build machines already skip it.

## Conclusion

Safe to ship dark-on-fleet / live-on-Echo. The owner-proof limitation is stated honestly and bounded to builtin apps.

## Second-pass review (if required)

**Reviewer:** independent second-pass reviewer subagent (Claude Opus 5.5), 2026-11-17
**Independent read of the artifact: concern raised, then resolved**

Concerns and resolutions:
1. A failed pin/unpin re-ran on every journal flush (unbounded platform calls, journal growth). Fixed: `nextPinAction` returns none after a `failed` step unless a fresh act asks; test "after a failed pin, nothing runs on its own".
2. The fold missed this machine's own unflushed writes, so two acts in one flush window could post twice. Fixed: the runtime keeps its own emitted records in memory until the journal read carries them (deduped by record key).
3. The union read counted own records twice (the stream reader already includes them). Fixed: own records come only from the stream reader plus the in-memory unflushed writes.
4. An unconsumed act could fire days later. Fixed: acts expire after 10 minutes unconsumed (`ACT_TTL_MS`).
5. Emit keys differ from data keys (witness lookup): low severity, same pattern as the Chief of Staff's event-keyed records; left as is.
6. `writeAct` result now checked (503 write-refused). requestId memory is in-process (attach/detach idempotency is also enforced by the fold). Owner proof is the dashboard operator session only in this PR; the phone path is stage 2.
7. Non-owner roles: `/work/projects` returns no projects to members/guests before the cache is read, so the app fields never reach them.
8. Evidence wording corrected: the live proof is recorded in the PR once run.

Also from the companion spec's review (forward compatibility): record types and `custom:` refs unknown to this build are accepted as inert stubs and ignored by the folds, so part 2 can add them without stalling a machine on this build.

## Evidence pointers

- Unit: `tests/unit/ProjectAppStore.test.ts` (15), `tests/unit/ProjectAppsRuntime.test.ts` (12), console model tests.
- E2E: `tests/e2e/project-apps-alive.test.ts`.
- Spec + convergence report: `docs/specs/project-apps.md`, `docs/specs/reports/project-apps-convergence.md`.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a` (negative declaration)
- **reason:** user/owner-driven acts: every new Telegram/Slack message is caused by one deliberate act (owner Attach/Detach/Try again/Update link/Post again, or the agent's explicit Try again); the automatic follow-up steps (pin a posted message by id, unpin, edit in place) send nothing new, run once per state change, and stop after any failed step until a fresh act (`nextPinAction`); unconsumed acts expire after 10 minutes; no timer drives anything.

- Follow-up commit: the `projectApps.builtin` ladder entry now passes the registry check (driver text within 80 characters; the fleet rung carries the same two measures as the development rung).

## Local Verify follow-up (2026-11-17)

Local Verify at 6c5367274 failed three unit files. Each one is fixed with no behavior change:
- **CapabilityIndex:** the `projectApps` entry no longer claims `/work`, which belongs to `workProjects`. It now has no prefix of its own (the sub-feature pattern) and still lists its five endpoints.
- **projects.js:** the "More apps" tap no longer calls `scrollIntoView`. It focuses the apps box (`tabindex=-1`), which follows the keep-place rule.
- **ReplicatedStoreReconcilerWiring:** `projectApps` is added to the reconciler allow-list, with the reason that only the server runtime on the lease holder and the owner-tap routes write it.
