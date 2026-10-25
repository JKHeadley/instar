# Side-Effects Review — Dashboard door + model controls (Sessions tab)

**Version / slug:** `dashboard-door-model-controls`
**Date:** `2026-09-27`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (session-lifecycle change: spawn path)`

## Summary of the change

Builds the approved spec `docs/specs/dashboard-door-model-controls.md`. New core
module `src/core/dashboardTopicProfile.ts` (options derivation, the one dashboard
write predicate, the new-topic default store, the creation seed service, the pool
seam + ops, the spawn thunk). `TopicProfileResolver` gains a public tri-state
`doorAdmissibility` (private binary `admissibility` unchanged for its two callers);
`TopicProfileStore` gains `mutateIfAbsent`; `TopicProfileWriteSurface` gains a
read-only `currentRegime()`. `src/server/routes.ts`: `GET /topic-profile/options`,
`POST /topic-profile/new-topic-default`, and a rewritten Telegram branch of
`POST /sessions/create` (raw registry write deleted). `src/commands/server.ts`:
`spawnSessionForTopic` exported + `silentStart`; `_topicProfileCtx` gains
`newTopicDefault`, `audit`, `discloseCreationSeed`, `spawnForTopic`,
`sessionPoolLocalClaim`; `_placementReplicationOn` hoisted; `_dashboardPoolClaimOps`
built beside the router. `OriginDeterministicSend.ts`: producer
`topic-profile-creation-seed`. Registry/classifier entries: WriteDomainRegistry route,
FileClassifier git-sync exclusion, state-coherence registry. Dashboard
(`dashboard/index.html`): modal Door/Model, switch sheet, default row + sheet,
`session.model` escaped. CLAUDE.md template line + `migrateClaudeMd` with its own sniff.

## Decision-point inventory

- Dashboard write predicate (`validateDashboardProfileChoice`) — add — enum + deny set + enabledFrameworks + availability ≠ unavailable; applies to the three dashboard writes only (spec DP 2).
- Options `selectable` — add — derived by running each pair through that same predicate (DP 1).
- Creation-seed eligibility (`mutateIfAbsent`: no entry at all) — add — invariant (DP 4).
- Seed model axis under a non-live regime — add — dropped + audited (DP 5).
- Who may change the new-topic default — add — Bearer + intent header, no PIN (DP 6).
- Pool placement on dashboard create (`evaluateSessionPoolLocalClaim` / claim / settle) — add — invariant table (DP 8).
- Inbound message during a dashboard create — pass-through — the existing `spawningTopics` guard (DP 9).
- `POST /topic-profile/:topicId` bound-operator floor — pass-through, unchanged (DP 3).

---

## 1. Over-block

- A door whose binary is provably missing on THIS machine is refused by the dashboard
  writes although chat would accept it. Intentional (spec §3.5), machine-readable
  (`dashboard-unavailable-door`, `chatPinAllowed: true`), with copy that says chat still works.
- On a pool, a create on a machine that does not hold the lease is refused
  `409 placement-not-authoritative-here` even with no pick. Intentional (spec §3.3 2b):
  today that create spawns off-record and lets the first message land elsewhere.
- A pool that is router-live but has no lease coordinator refuses every Telegram create
  (holder unknown). Intentional: the `: true` fallback is the fail-open write the spec forbids.
- A Telegram create whose topic already has a live session (reused name) now answers
  `409 topic-has-session` instead of spawning a second session for the same topic.
  Behavior change in the safe direction (no duplicate session); no pick is involved.
- If the topic-profile bundle failed to initialize (`ctx.topicProfile` null), a Telegram
  create answers `409 telegram-routing-not-wired`. Previously it spawned via the raw path.
  Only reachable on an install whose profile store threw at boot.

## 2. Under-block

- A never-messaged dashboard topic cannot be switched until its first message (bound
  operator floor) — named v1 UX debt, surfaced in the modal hint and in
  `switchableAfterFirstMessage: true`.
- An `assumed` door (probe fell open) is offered and may then fail at launch; the
  existing breaker + resolver fallback notice handle it (tested).
- An inbound message that races a dashboard create is answered "still starting up" and
  not replayed (today's mid-spawn behavior, spec §3.3 step 5).
- Carrier hop of a retained seed after a released pool placement is not proven (spec
  §3.3 step 7 honest limit); the 500 tells the operator to confirm the door later.

## 3. Level-of-abstraction fit

The seed is a store primitive (`mutateIfAbsent`, same lock as `mutate`) plus one
service; it does not reach the write surface's application arm, so no respawn,
carrier cancel or operator attribution is invented. Spawning goes through the
existing chokepoint (`spawnSessionForTopic`) instead of a second resolver; the only
chokepoint change is `silentStart`, which skips work rather than adding any. Pool
ownership reuses the router's registry, `emitPlacement`, nonce stream and the existing
local-claim confirm; routes never call `cas`. Validation reuses `validateProfileFields`
and the resolver's own launchability probe (tri-state wrapper, same cache/TTL).

## 4. Signal vs authority compliance

- [x] No — this change has no brittle blocking authority over messages or agent behavior.

The refusals added are structural invariants on operator-initiated writes (enum
membership, installed binary, pool lease ownership, "no entry exists") — deterministic
facts, not heuristics over content. Availability `assumed` never refuses (fail-open
preserved); only a probe that verified absence refuses, and only on the dashboard.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Every decision point is
classified `invariant` in the spec's "Decision points touched" table (enumerable
domain: closed enums, file existence, lease ownership, entry presence).

---

## 5. Interactions

- **Shadowing:** the new routes are registered before `/topic-profile/:topicId`, so
  `options` / `new-topic-default` are never parsed as topic keys (the key regex would
  400 them anyway). Tested.
- **Double-fire:** the dashboard spawn and an inbound cold-spawn share the
  `spawningTopics` registry: the thunk checks `topic-has-session`, then `has()`→`add()`
  with no await between, holding ONE token across spawn + `registerTopicSession`,
  cleared in `finally`. The inbound path sees the guard and posts its existing notice.
- **Races:** two concurrent seeds on one key serialize on the per-topic lock; exactly
  one `seeded` (tested with four concurrent calls). A husk blocks a seed.
- **Registry clobber:** the deleted raw `writeFileSync` raced the adapter's atomic
  `saveRegistry()`; registration now goes through `registerTopicSession`.
- **Pool:** place → seed → spawn → register → confirm; a thrown spawn, a failed seed,
  or a `telegram-routing-not-wired` answer (nothing spawned) releases (confirm-if-placing,
  release, journal); `topic-spawning` / `topic-has-session` and a returned spawn with a
  failed registration confirm (never release a live session's record). Settle uses the
  ops that placed. Caveat: if the confirm inside release is itself refused, the FSM
  refuses release from `placing` and the response reports `placement: "unsettled"` —
  surfaced to the operator, not retried.
- **Feedback loops:** none — the default is read only by `/sessions/create`.

## 6. External surfaces

- Telegram: one fixed disclosure line per seeded topic, via
  `sendDeterministicTelegramNotice` with a new closed-union producer id (origin record:
  fixed template, no model). Fire-and-forget; a held send never blocks the create.
- Persistent state: `state/new-topic-default-profile.json` (single record, registered
  in the state-coherence registry, git-sync excluded); seeds live in the existing
  `state/topic-profiles.json`; audit rows in `logs/topic-profile-changes.jsonl`.
- API: two new routes; `/sessions/create` gains optional fields and new 4xx/5xx
  responses that name the step reached.
- **Operator surface (Mobile-Complete):** all three controls are dashboard forms usable
  at phone width; no PIN step (operator decision 2026-09-27).

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes — the Door/Model selects sit directly under
   Platform in the existing New Session modal; the Create button names the pick
   ("Create on Codex CLI · gpt-6-astra") when it differs from the default. The switch
   sheet opens with the current door/model and the two selects above "Switch"; the
   default sheet leads with the required scope copy and the selects above "Save".
2. **Zero raw internals as primary content?** Door names use the existing display
   labels (`FRAMEWORK_DISPLAY_NAMES`); sources are humanized ("pinned by you",
   "seeded at creation", "default"). Model ids are shown as-is — they are the names the
   operator uses in chat ("gpt-6-astra", "claude-opus-5-5"); no JSON, hashes or UUIDs.
3. **Destructive actions de-emphasized?** "Clear" on the default sheet uses the quiet
   cancel style and sits left of the primary "Save".
4. **Plain language + phone width?** Native `<select>` at 100% width with
   `box-sizing: border-box`, long notes wrap (`overflow-wrap: anywhere`), no tables.
   The live-user phone-width drive is the desk's Live-User-Channel step (spec §5).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Topic pins (seeds + switches): replicated** — ordinary topic-profile entries that
  ride the existing TopicProfileTransferCarrier; on a pool the dashboard create places
  ownership on the creating machine through the journaled `emitPlacement`, so the first
  message routes there. One named exception (spec §7): after a released placement the
  carrier hop of the retained seed is unproven; the operator is told.
- **New-topic default: machine-local, migrating-to-unified** — ratified=5a4efecc1,
  tracking issue #2085, expires 2027-03-25; the surface labels it
  `replication: "local-only"` and the sheet says other machines keep their own default.
- **Options route: proxied-on-read (declared)** — operational state probed live on THIS
  machine's disk; v1 has no remote read (remote tiles are read-only).
- Notices: the seed line is sent only by the machine that created and placed the topic
  (one voice). URLs: none generated.

## 8. Rollback cost

Code revert + patch release. `{clear:true}` on the default stops future seeds with no
release. Already-seeded topics keep their pins (identifiable by `updatedBy:
system:dashboard-create | system:new-topic-default`) and clear per topic with the
existing `clear` once bound. The state file is inert without the code. The CLAUDE.md
line is additive text; a stale line after a revert only mentions a missing route.

---

## Class-Closure Declaration

- `unbounded-self-action` — closure: **n/a** (negative declaration). The spawn and the single
  disclosure line added here fire only when the operator taps Create in the dashboard
  (`POST /sessions/create`), once per request, rate-limited by the existing `spawnLimiter`
  (10/min). Nothing re-triggers them: no timer, no retry loop, no watcher. One-shot, user-driven,
  not a self-triggered loop. Matches the machine-readable declaration in the trace.

## Conclusion

Builds the spec as written, including its named limitations. Review-driven design
choices during the build: the spawn thunk and pool ops were extracted into the core
module so the e2e exercises the exact functions server.ts wires; settle uses the ops
that placed (a lease move between place and settle must not leave a `placing` record);
the new state file was registered and git-sync-excluded so the WriteDomainRegistry
story is true. One spec citation does not hold as written: `cooldown-confirm-required`
is returned only by `/topic-profile/:id/reapply`, never by `POST /topic-profile/:id`,
so the switch sheet renders every refusal verbatim and has no "Switch anyway" path —
the behavior contract ("the sheet shows the server's reply verbatim") is unchanged.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read the spec, this
artifact and the src diff; no edits).
**Independent read of the artifact: concern → resolved → concur** (re-check of the three fixes: "Concur with the review")

- `/sessions/create` confirmed the placement when the spawn thunk answered
  `telegram-routing-not-wired` (nothing spawned) — would leave an `active` record with no
  session. Fixed: that answer now settles as `spawn-threw` (release); integration test
  "ready + the spawn guard is not wired ⇒ release" added, plus the `topic-spawning` ⇒
  confirm counterpart.
- A pick with `platform: 'telegram'` on a server with no Telegram adapter fell through to
  a headless spawn and dropped the choice. Fixed: 400 `preference-needs-telegram`; test added.
- `release` ignores the confirm result, so a refused confirm leaves `placing` and answers
  `unsettled`. Stated in §5 above (reported in the response, not retried).

Reviewer confirmed: seed only on a newly created topic and always before the spawn;
`has()`→`add()` with no await, one token across spawn + registration, cleared in
`finally`; `silentStart` skips only the bootstrap build, temp files and relay block
(resolve, notices, identity file, `recordSpawnSuccess` still run); `mutateIfAbsent`
is lock-serialized and rolls back via `flushDurably`; the seam never uses `: true`.

---

## Evidence pointers

- `npx vitest run tests/unit/dashboard-door-model-controls.test.ts tests/unit/spawn-session-silent-start.test.ts tests/unit/dashboard-door-model-server-wiring.test.ts`
- `npx vitest run -c vitest.integration.config.ts tests/integration/dashboard-door-model-routes.test.ts`
- `npx vitest run -c vitest.e2e.config.ts tests/e2e/dashboard-door-model-lifecycle.test.ts`
