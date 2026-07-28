# Side-Effects Review — Session-listing hygiene (bounded finished-session retention + active-by-default listing + genuine-duplicate flag)

**Version / slug:** `session-listing-hygiene`
**Date:** `2026-07-10`
**Author:** Instar Agent (echo)
**Second-pass reviewer:** required (session lifecycle surface) — see appended response

## Summary of the change

Fixes the "duplicate sessions" perception problem (CMT-1936, topic 29836; live evidence 2026-07-09: the Mac Mini's `GET /sessions` returned 53 rows of which 52 were FINISHED background runs — 22 `mentor-stage-a-*` headless one-shots, 28 `job-*` records — read by the operator as "duplicate sessions running across both machines"). Three parts:

1. **Bounded retention** (`src/core/SessionManager.ts` `cleanupStaleSessions()`, config in `src/core/types.ts` `SessionManagerConfig.retention`): closes two genuinely UNBOUNDED holes — `failed` records were never pruned at all, and a terminal record with a missing/unparseable `endedAt` was skipped forever (and escaped the hard cap). Headless one-shots (`launchLane === 'headless'`, the mentor Stage-A shape) now get the short background TTL (60 min) instead of the 24 h interactive TTL. The hard cap now counts EVERY terminal class (completed + failed + killed), default 50. All knobs config-tunable via `sessions.retention` (applied at the next server restart — SessionManager snapshots config at boot; absence preserves shipped defaults).
2. **Active-by-default listing** (`src/server/routes.ts` `GET /sessions`): the default view is ACTIVE sessions only (`starting`/`running`); `?include=all` returns the full registry; `?status=<valid>` keeps its exact pre-change semantics. The `scope=pool` fan-out forwards the caller's opt-in to peers AND defensively filters a LEGACY peer's full-registry answer (mirror of the dashboard's existing client-side filter, now structural).
3. **Genuine-duplicate flag** (`routes.ts` pool branch + `dashboard/index.html`): the pool view computes `pool.duplicateTopics` — the SAME conversation (platform + platformId) with a LIVE session on ≥2 machines at once — tagging each such row `duplicateTopic: true` and badging it red on the dashboard. The same recurring job on each machine (benign, by design) is never flagged (job/headless sessions carry no platform binding).

Agent awareness: new `Session Listing Hygiene` CLAUDE.md section (`SESSION_LISTING_HYGIENE_CLAUDEMD_SECTION` in `src/core/PostUpdateMigrator.ts`), used by `generateClaudeMd` (`src/scaffold/templates.ts`) and appended content-sniffed in `migrateClaudeMd` (Migration Parity).

## Decision-point inventory

- `SessionManager.cleanupStaleSessions()` — modify — which terminal session records are removed from the on-disk registry, and when.
- `GET /sessions` default visibility filter (routes.ts) — add — which rows the listing answers with by default (active vs full registry).
- `GET /sessions?scope=pool` remote-row defensive filter — add — drops a legacy peer's finished rows from the default merged view.
- `pool.duplicateTopics` computation — add — SIGNAL-ONLY classification (flags, never blocks or kills).
- Dashboard duplicate badge — add — pure rendering of the server-computed signal.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- The default `GET /sessions` no longer shows finished runs. A caller that legitimately wants them (post-run inspection, history tooling) must pass `?include=all` or `?status=<terminal>`. Consumer trace (2026-07-10, this worktree): NO in-repo consumer reads finished rows from the ROUTE — the dashboard's local tiles come from the running-only WebSocket feed, its remote tiles already client-filter to running/starting (`dashboard/index.html`, the 2026-06-11 closed-sessions-reappearing fix), and the closeout-liveness snapshot excludes terminal entries itself (`src/monitoring/closeoutLivenessSnapshot.ts` TERMINAL_STATUSES). Internal registry consumers call `state.listSessions()` directly and are untouched.
- Retention: headless one-shot records now prune after 60 min instead of 24 h. A human inspecting "what did that mentor run do?" more than an hour later loses the registry row (the tmux transcript/log surfaces remain). Judged acceptable — it is the exact accumulation class that caused the misread, and the window is tunable (`sessions.retention.completedJobTtlMinutes`).
- A terminal record with NO parseable timestamps is pruned immediately. Legitimate records always carry `startedAt` (set at spawn) — only malformed garbage matches.

## 2. Under-block

**What failure modes does this still miss?**

- A GENUINE duplicate involving a session that has not yet enriched a platform binding (e.g. a topic session spawned but not yet registered in the adapter's topic map) is not flagged — platformId is the join key. The flag is best-effort observability, not the safety mechanism (the lease/one-voice layers own prevention).
- The duplicate flag only surfaces in the POOL view (it needs the cross-machine merge). A caller reading each machine's plain `/sessions` separately re-derives nothing — documented in the CLAUDE.md section ("read `pool.duplicateTopics` first").
- Mixed-version window: an UPDATED peer queried by an OLD machine's fan-out (no query forwarded) answers active-only — the old machine's pool view loses the finished rows it used to show. That is the intended direction (fewer stale rows), never data loss (records remain on the peer's disk behind `?include=all`).

## 3. Level-of-abstraction fit

The default-visibility filter lives at the ROUTE (the shared read chokepoint every surface uses: dashboard poll, agent curl, pool fan-out) — the same place the `?status=` filter already lived, so it is the established layer for listing semantics. Retention lives in the ONE existing pruner (`cleanupStaleSessions`) rather than a new janitor. The duplicate flag lives in the ONE place that sees all machines' rows (the pool merge). No parallel mechanism added anywhere. No issue identified.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). Nothing here holds blocking authority over agent behavior: the listing filter changes what a READ answers (full data remains one flag away); `duplicateTopics` is a pure SIGNAL (flags, never kills/blocks — the reaper/lease layers keep their own authority and their own evidence bars); retention prunes only records that are already terminal, through the existing single-writer state path (`state.removeSession`). The brittle-ish join (platform+platformId string key) carries zero blocking authority — exactly the shape the principle prescribes.

## 5. Interactions

- **OrphanProcessReaper** (`listKnownTmuxSessions()` reads ALL statuses from DISK): pruning removes names from its known-set. Exposure judged pre-existing and marginal: jobs already pruned at 60 min pre-change; the newly-shortened class (headless one-shots, ≤5 min lifetime, tmux killed at completion detection) and the newly-pruned class (`failed`, previously immortal) change the window, not the mechanism. The route-level filter does NOT affect it (disk reads, not route reads).
- **Dashboard client-side remote filter** (index.html) and the new server-side defensive filter double-fire harmlessly (both keep active rows; belt-and-suspenders during the mixed-version window — deliberately kept).
- **`POST /sessions/cleanup-stale`** route and the 5-min monitor tick both call the same pruner — unchanged single implementation, no race added (removeSession is idempotent).
- **Resume queue / reap-log / token ledger**: none read the registry's terminal rows (verified in the consumer trace); reap-log is its own append log.
- **`pool.machines[].sessionCount`** now counts the REQUESTED view (active by default) — this un-inflates the Machines tab count and lets the WS4.2 empty-state fire for a machine with only finished records ("online — no active sessions"), which is more honest, not less.

## 6. External surfaces

- API shape: plain route stays an ARRAY; pool response gains ONE additive field (`pool.duplicateTopics`, always an array) and rows gain an optional `duplicateTopic: true`. Back-compatible for every existing consumer shape-wise; the SEMANTIC default change (active-only) is the deliberate, documented fix.
- Cross-version: new fan-out × old peer → defensive filter keeps semantics; old fan-out × new peer → active-only (intended direction). No error paths added; a peer failure still degrades to `pool.failed`.
- No timing/conversation-state dependence beyond what the route already had.

## 6b. Operator-surface quality

The dashboard change is ONE additive badge on the existing sessions list — no new form, tab, or flow.

1. **Leads with its primary action?** Unchanged — the sessions list still leads with the session tiles (name → click to stream); the badge only appears on a flagged row, next to the existing machine badge.
2. **Zero raw internals as primary content?** Yes — the badge text is the plain word "⚠ duplicate" with a plain-English hover title ("this conversation has a live session on more than one machine"); no ids, no JSON, no config keys. The underlying platformId/machineIds stay API-only.
3. **Destructive actions de-emphasized?** No destructive action added — the badge is pure information; the existing close button is untouched.
4. **Plain language at phone width?** Yes — one short lowercase word in the same badge row that already wraps on mobile (same sizing as the machine badge, 10px pill); the removal of ~50 finished-session tiles from the pool poll actively IMPROVES phone usability (the operator's 2026-07-05 screenshot complaint was exactly this wall).

No issue identified.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read: the pool merge (`GET /sessions?scope=pool`) is the merged read, now with consistent visibility semantics forwarded to peers and defensively enforced for legacy peers. Retention is machine-local BY DESIGN (each machine prunes its own registry — the records describe that machine's tmux sessions). The duplicate flag is exactly the cross-machine coherency read this spec family called for. User-facing notices: none added (signal renders in dashboard + API only). No durable state strands on topic transfer (records are per-machine lifecycle facts, not conversation state).

## 8. Rollback cost

Config-only partial rollback: `sessions.retention` restores any TTL/cap (e.g. `{"completedJobTtlMinutes": 1440}` ≈ the pre-change 24 h window for the headless class) — **taking effect at the next server restart** (SessionManager snapshots config at boot; a config edit alone does NOT stop the 5-min pruning tick — restart to apply, and every claim site in code/docs/CLAUDE.md says so after the second-pass fix below). The listing default and duplicate flag roll back by reverting the PR (pure route/rendering logic, no data migration, no persisted format change — pruned records are gone, but they were ephemeral lifecycle rows that the pre-change code also pruned on its own schedule). No agent state repair needed.

---

## Second-pass review

**Concern raised (first pass):** the artifact and four shipped claim sites (types.ts config comment, the cleanupStaleSessions docstring, the fleet CLAUDE.md section, the unit-test title) described `sessions.retention` as "read live each pass — no restart". That was FALSE at runtime: `server.ts` snapshots `{ ...config.sessions }` once at boot and `SessionManager.config` has no reload path, while `PATCH /config` replaces `ctx.config.sessions` with a NEW object the SessionManager never sees. Load-bearing because §8's rollback lever would have let an operator believe pruning stopped while the 5-min tick kept irreversibly deleting records until a restart.

**Resolution (iterated before commit):** all four claim sites plus the ELI16, release fragment, and this artifact now state the true semantics — a `sessions.retention` change takes effect at the NEXT SERVER RESTART. No live-reload machinery added (out of scope; the boot-snapshot pattern is the established SessionManager config contract).

**Reviewer verdict on everything else:** verified accurate — the default filter preserves `?status=<valid>` semantics exactly; the legacy-peer defensive filter mirrors the default AND enforces `explicitStatus` on peer rows; `duplicateTopics` is active-rows-only in both aggregation and flagging, excludes `headless`, and mutates only the enriched copies (never registry state objects); OrphanProcessReaper's known-set dependency fails in the SAFE direction (a pruned name declassifies a leftover process to external/kept — never killed); ResumeQueue entries are self-contained (topicId/resumeUuid/jobSlug in the durable entry), so no revival path reads terminal registry rows past the new TTLs; signal-vs-authority holds; no new race between the 5-min tick and `POST /sessions/cleanup-stale`. Concur with the review as amended.
