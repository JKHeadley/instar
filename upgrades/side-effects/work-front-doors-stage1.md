# Side-Effects Review — Work front doors, stage 1 (three doors, one Needs-you read)

**Version / slug:** `work-front-doors-stage1`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (approved, converged spec `docs/specs/work-front-doors.md`, stage 1 only). Size: about 12 files in the instar repo (one new server module, console nav/strip, wording, migration, capability and awareness entries, tests), plus separate app-repo commits (iPhone e472ce9, Android c394141). Effort: no spec review rounds in this build (the spec was converged before approval); one commit attempt so far.

- **Server:** `src/server/needsRoutes.ts` adds `GET /needs` (bearer) and `GET /mobile/needs` (device, new `DEVICE_ALLOWLIST` rule, tier guest, own bucket). It builds the owner's list by reading Home's own routes over this server's loopback with its own token and running the console's pure models (`needs-model.js` `NEED_SOURCES`/`surfacedNeeds`, `home-model.js` `buildNeeds`/`buildPromised`/`combineNeeds`), so it equals Home's count. A team person's phone gets only the work board, read as that person through the board's own read (`workBoardRoutes.ts` now exposes `boardRead`, the same code `listBoard` uses), and only when the board's own device rule admits that phone. Answers are cached 10 s (single-flight), at most 6 reads in flight, 100 rows sent, every string scrubbed for credentials. `NeedsCanary` runs a synthetic need through the real route hourly and reports through `DegradationReporter` after two misses in a row; `GET /needs/canary` shows its state.
- **Console:** `nav-model.js` adds `DOORS`, `doorHref`, `doorOf`, `resolveRoute`, `startDoor`, `NATIVE_PATHS`, `FLEET_TILES`. `console.js` draws three doors, an Agent page (Fleet, then the four groups as sections, names and icons only), redirects Home/empty/unknown hashes to the Conversations door, and mounts `needs-strip.js` above both front doors (hidden only on a complete zero read). Every old `#/group/page` hash still resolves (tested over every hash linked in the console, server and instructions).
- **Wording:** "in Home's count" → "the Needs-you list" in `SURFACE_REFERRAL_CLAUDEMD_SECTION`, with an idempotent in-place migration in `migrateClaudeMd`; `NEED_EXEMPT` wording; the Registry First row now names `GET /needs`; new awareness entry `src/data/awareness/needs-you-list.md`; capability index entry `needs`.
- **Migration fix found by the suite:** `needs-you-list.md` is the first entry ever in `src/data/awareness/`, which made the Feature notes block non-empty. `insertContextDeathClaudeBlock` appended a new "Critical Anti-Patterns" section after that block, and the next update moved the block back to the end, so a full-layout CLAUDE.md changed on every run (`tests/unit/mobile-native-capacity-screens-claudemd.test.ts` caught it). The step now inserts before the block; `tests/unit/context-death-block-keeps-feature-notes-last.test.ts` pins it.
- **One source fix:** the `plans` source now treats a switched-off initiative tracker as nothing waiting (it read as "could not check plans" forever on such agents, on Home too).

## Decision-point inventory

- `GET /needs` composition — **add** — decides which rows are shown and whether the read is complete. Read-only; it never hides, approves or changes anything.
- `needsViewer` / `teamMayReadBoard` — **add** — decides which sources a viewer gets. It narrows (owner-only sources omitted for team phones) and never widens: a team phone gets the board only when the board's existing device rule would already admit it.
- `DEVICE_ALLOWLIST` / `TEAM_ROUTE_TIERS` — **modify** (one new rule, one named team tier) — admits `GET /mobile/needs` for any active paired person's phone (team phones at guest or above), own rate bucket.
- `needs-model.js` `plans` source — **modify** — a 503 initiative read means "nothing waiting" instead of "could not check".
- Console routing — **modify** — Home and unknown hashes redirect to the Conversations door (web only; phone mode keeps Home).
- `insertContextDeathClaudeBlock` (PostUpdateMigrator) — **modify** — where its section is inserted when a Feature notes block exists; content unchanged.
- Work board approval policy — **pass-through, untouched** (option C ships with the trust-journey spec).

---

## 1. Over-block

No block/allow surface on actions. On reads: a team phone the board's own rule refuses (a team person with no tier) sees an empty, complete list with the board marked `not-for-viewer`; members and guests get the board's cards filtered by the conversations they may read, exactly as `GET /mobile/work-board` gives them. That is what their phone can already see; it is not a new refusal. Found while testing: a new device rule's tier is overwritten unless the route is named in `TEAM_ROUTE_TIERS` (closed by default), so `/mobile/needs` is named there at guest; a unit test pins it.

## 2. Under-block

- A source that is machine-local by design (this machine's health, routing spend, pending Secret Drop requests, context watcher, pairing invites) only shows what the answering machine knows. This is declared per source in `NEED_SOURCE_POSTURE` and is the same as Home today. Two of them are gaps against their own specs, filed: `fb-08fa7be1-424` (feedback authority proposals read the local drain copy) and `fb-225a5392-479` (blockers are not replicated yet).
- The work board answers 503 while it is starting; the console's own rule treats any 503 as "off", so a starting board reads as off for one read. Same as Home.

## 3. Level-of-abstraction fit

Right layer: the composition reuses the console's own pure models instead of re-implementing them, and the route reads the same server routes the console reads (the pattern `mobileConsolePagesRoutes.ts` and `mobileHealthRoutes.ts` already use). The board's per-viewer filtering is reused, not copied (`boardRead`).

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface on actions.

The list and the canary are signals. The list never approves or hides; the canary only raises a notice. The one access decision (which sources a viewer gets) delegates to existing rules (owner check, the board's own device rule) and can only narrow.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The fixed numbers (10 s cache, 6 concurrent reads, 100 rows, 20 s per read, hourly canary, 2 misses) are resource floors and a notice threshold, not judgments between competing signals.

---

## 5. Interactions

- **Home:** unchanged on the server; the console's Home page is now reached only in phone mode. The strip and Home use the same models, so their counts agree.
- **Self-load:** each owner read fans out to about 20 loopback GETs; the 10 s single-flight cache shares one fan-out across every phone, browser and the canary's fresh read is hourly. The pool reads inside it (`?scope=pool`) are already bounded by their own timeouts.
- **Rate buckets:** `/mobile/needs` has its own bucket (`needs-reads`, 30), so polling the strip never uses up a phone's general allowance.
- **Lifecycle:** the strip keeps one 45 s timer across door changes (tested); page refresh timers are unchanged (tested).

## 6. External surfaces

- New routes: `GET /needs`, `GET /mobile/needs`, `GET /needs/canary`. A server without them answers 404; every client treats that as "could not check", never as zero.
- The console's sidebar, bottom bar and Home redirect change what the operator sees. The iPhone and Android apps (separate repos) change their tabs. The Mac app (another session) consumes the same route.
- Agent instructions: one awareness entry, one Registry First row, one reworded sentence (migrated in place).

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: the strip sits above both front doors with each row linking to where it is acted on; the doors open straight on the conversations and the board.
2. **Zero raw internals as primary content?** Yes: rows show the source model's plain titles and reasons; ids never shown; Secret Drop rows never carry their token (checked live: the row links to `#/people/secrets?s=waiting`).
3. **Destructive actions de-emphasized?** The strip has no actions of its own; nothing destructive was added.
4. **Plain language + phone width?** Checked in headless Chromium at 1280x728 and 390x844 on a throwaway agent: no horizontal scroll at either size; the Agent page shows names and icons only; the strip says "Could not check …" in words.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read by composition.** Any one machine answers the person's full list from its own replicas and its own pooled reads (attention `?scope=pool`, promises `?scope=mesh`, accounts `?scope=pool`; the board, the Chief of Staff and learned skills replicate). Machine-local-by-design sources are named with their reason in `NEED_SOURCE_POSTURE` and returned per source as `posture`. No new durable state; no notices except the canary's, which goes through `DegradationReporter` (one voice, deduplicated). Row links are console hashes, valid on any machine. Primary agent and last door are client-device settings.

**Status surfaces:** `GET /needs` is the agent-wide list as seen from the answering machine (each source labelled with its posture; a pooled read a machine did not answer marks that source could-not-check and names the machine). `GET /needs/canary` is this machine's canary. The capability entry `needs` is static.

## 8. Rollback cost

Pure code: revert and ship a patch. No persistent state (the canary keeps its state in memory). The CLAUDE.md wording migration is a sentence swap; a revert leaves the new sentence in place, which is harmless. App changes live in their own repos and builds.

---

## Conclusion

The review changed three things in the build: the plans source fix (found on the live throwaway), the Agent page losing its descriptions and duplicates (found in screenshots), and a separate strip timer period so a leak of either timer stays visible to the lifecycle tests. Two machine-local gaps were filed rather than fixed here. Clear to ship once the second-pass review concurs.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Opus 5.5)

**Independent read of the artifact: concern**

No finding widens access or leaks a credential. Two findings contradict what this artifact claims, so the verdict is concern.

1. **Every team phone (member or guest) is refused `GET /mobile/needs` (fails closed).** The new rule's `tier: 'guest'` (`src/server/mobilePairingRoutes.ts` ~2514) is overwritten by the `DEVICE_ALLOWLIST` mapping (~2568: `tier: rule.ownerOnly ? 'owner' : named ? named[2] : 'owner'`), because `/mobile/needs` is not listed in `TEAM_ROUTE_TIERS`. A probe of the live `DEVICE_ALLOWLIST` printed `/mobile/needs` tier `owner` and `/mobile/work-board` tier `guest`. So the middleware answers 403 `tier-required` to every team phone. The team branch of `needsRoutes.ts` (`team()` 307–321, `teamMayReadBoard` 402–408) is reached only by msp phones. §1 of this artifact also says "the board rule has no tier", which is wrong: `/mobile/work-board` is guest tier, so after the fix a member or guest would get their own board rows as intended. Fix: add `['GET', /^\/mobile\/needs$/, 'guest']` to `TEAM_ROUTE_TIERS`, plus an e2e test that sends a team phone through the real middleware (the current e2e covers only bearer and the owner phone).
2. **`complete: true` with count 0 while a machine in the pool did not answer.** At `needsRoutes.ts:292` the attention source is `ok` whenever `queue.count` is a number. `home-model.js` `buildNeeds` (~205–210) returns `state: 'partial'` for `data.pool.failed` but sets `statusNote` only when there are items. Scenario: two machines, and the peer is offline holding an OPEN attention item. The answer is `complete: true, count: 0, notes: []`, and the strip hides (`needs-strip.js:31`). The artifact's §7 claim that "a failed pooled read lists the missing machine in `notes`" holds only when count > 0. The same applies to accounts `?scope=pool`. Fix: treat a non-empty `pool.failed` as a `couldNotCheck` entry that names the machines.
3. **Any 503 counts as "off"** (`consoleResult` :171 and `sourceState`). This covers "not initialized" and `work-board-starting`, including the `boardFor` fallback in `routes.ts`, and `/commitments` (the promises state at :293). Each of these gives `complete: true`. This is inherited from the console, and §2 notes it for the board. It now backs the apps' "complete" contract, though, so it is worth separating "off" from "starting".
4. **The canary reports false misses.** Its outer read of `/needs` uses the same 20 s `NEEDS_READ_TIMEOUT_MS` as each source read (`needsSelfRead` in `routes.ts`), and a compose runs two rounds of reads one after the other, each read allowed up to 20 s. One source slow to about 20 s for two hourly ticks therefore aborts the canary, and it raises "the read failed" while the list itself works and only marks that one source `couldNotCheck`. Give the canary a deadline longer than the compose.
5. **Composes can overlap.** `singleFlight` dates an entry from when the compose started, so a compose longer than 10 s lets another one start every 10 s. Each adds 6 more concurrent loopback reads and writes the shared `known` map at the same time. This is bounded, but it multiplies load exactly when sources are slow.
6. **The canary's `setTimeout`/`setInterval` in `createRoutes` are never cleared on server close.** They are unref'd. In multi-server tests they can still fire after 2 minutes at a port that may have been reused. Hardening only.
7. **No guard against recursion.** No `NEED_SOURCES` read targets `/needs` today (checked), but nothing stops a future one, and that would make the server read itself on every compose. Add a unit assertion that no source path starts with `/needs`.
8. **Theoretical secret fragment.** `clean()` (:179–184) cuts to max+2048 characters before scrubbing, then folds whitespace. A value with more than 2048 whitespace characters could pull a cut-off secret fragment, which the scrub patterns no longer match, into the visible 400 characters. Fix: fold whitespace before the cut.

Checked and fine:
- **Access.** The bearer is matched only through `bearerMatches`. Browser devices are refused (`/mobile/needs` is not in `BROWSER_ROUTES`). The notify token cannot reach the route, and `/needs` with device headers has no rule, so it is refused. The canary nonce is single-use and honoured only for the owner. The board is read as the caller through the same `boardRead` as `/mobile/work-board`, and `laneFor` makes `waiting-on-you` per viewer. An msp phone gets no more than `/mobile/work-board` already gives it.
- **Secrets.** Secret Drop rows use an index key and a fixed href. Hrefs are limited to `#/` or `/dashboard/`, and the strip renders text only.
- **Console redirect.** Every `#/…` literal in `src/` and `dashboard/console/` resolves to a page or group, except `#/home`, which redirects as intended. The redirect target is always a native page, and `replaceState` does not fire `hashchange`, so the route recurses at most once and cannot loop. Two minor behaviour changes: an unknown `#/group/x` used to show its group and now lands on Conversations, and a phone load with an empty hash now lands on a door rather than Home (`start()`), which contradicts the "phone mode keeps Home" comment.
- **Migration.** Idempotent: the old phrase is gone after the first run, it does nothing on files that never had the phrase, and it runs after the section-add, which already uses the new wording.

### Resolution of the second-pass findings (author)

1. **Team phones refused:** fixed. `GET /mobile/needs` is named in `TEAM_ROUTE_TIERS` at guest; a unit test pins the rule's tier and bucket, the team-open route count test is updated with its reason (34), and `tests/integration/team-access-routes.test.ts` sends a member phone and an msp phone through the real middleware. §1 above is corrected (the board rule is guest).
2. **Complete with a silent machine:** fixed. A non-empty `pool.failed` on the attention or accounts read marks that source failed and names the machines ("the attention queue on Mac Mini"), using the console's own `machineLabel`; a promises read with no other machine represented is "promises on other machines". Unit-tested.
3. **503 "starting" read as off:** fixed on the server read: a 503 whose error says starting / not ready / not initialized is "still starting" (failed), not "off". Unit-tested with `work-board-starting`. The console's own Home rule is unchanged.
4. **Canary false misses:** fixed. The canary's own read waits `3 x 20 s + 10 s`, longer than a whole build, and never runs alongside another build.
5. **Overlapping builds:** fixed. One build at a time; its answer is shared for 10 s after it finishes.
6. **Canary timers on server close:** accepted, not changed. Both timers are `unref`'d, the first fires after 2 minutes, and a stray tick against a closed or reused port only records a miss (a notice needs two in a row on the same process). Test servers live for seconds; production servers close with the process.
7. **Recursion:** guarded by a unit test: no source reads a path starting with `/needs`.
8. **Secret fragment:** fixed. Whitespace is folded before the cut, so a secret split by a long run of spaces is whole when scrubbed.
- **Minor:** an unknown `#/section/page` opens that section again (tested); a phone-mode load with no hash opens Home again.

**Re-check after fixes: concern** (independent reviewer subagent, Opus 5.5). Findings 1, 3, 4, 5, 7 and 8 and both redirect points are fixed as described, and the reason for accepting 6 holds. One problem is new, caused by the fix for 2:

- **A fresh agent's list is now never complete, and its strip never hides (`needsRoutes.ts`, the `gaps` block ~316).** `missingMachines` counts every row in `pool.failed`. `subscriptionPoolScopeView` (`routes.ts` ~39477) also adds a row for this machine itself, `{ machineId: self, error: 'peer-pool-unconfigured' }`, whenever the subscription pool has no store file yet. That state is "unconfigured", which `subscriptionPoolReadable()` itself treats as readable. So on any agent that has never added an account, accounts is always marked failed. I reproduced it through `createNeedsComposer` with that body and got `complete:false, couldNotCheck:["accounts and sign-ins on a machine with no name on file"]`. The strip then shows "0+?" with that line forever. The same applies to `peer-pool-invalid` and `peer-pool-unavailable` on self: those are real failures, but they are about this machine, not a missing peer, so the label is wrong. Fix: skip `peer-pool-unconfigured`, and label rows for this machine as this machine's own failure rather than "on <machine>". Add a unit test for the unconfigured body.
- **Minor, no change needed (this one).** A canary build is not stored as `inFlight`, so an owner request whose cache has expired can still start a build alongside it (`needsRoutes.ts` ~458). This is at most two builds, once an hour.

**Final: concur** (independent reviewer subagent, Opus 5.5). The re-check finding is fixed. `missingMachines` (`needsRoutes.ts` ~310–320) skips rows marked `peer-pool-unconfigured` and labels this machine's own failed read "this machine". The new unit test covers both cases, and `tests/unit/needs-read.test.ts` passes (26). A peer can never produce `peer-pool-unconfigured` (peer rows are only `unauthorized` or `error`), so the filter cannot hide a missing peer. One cosmetic point, not blocking: on an agent with no mesh id, `meshSelfId` is null and the pool view writes this machine as `'self'` (`routes.ts` ~39478). That no longer matches `deps.machineId()`, so an own `peer-pool-unavailable` or `peer-pool-invalid` row still reads "on a machine with no name on file" instead of "this machine". It is still correctly marked incomplete. Treating `machineId === 'self'` as this machine would close it.

**Author, after the re-check:** fixed the new finding. Rows with `peer-pool-unconfigured` are skipped (a store never set up is a complete nothing), and this machine's own failed pooled read is named "on this machine". Unit test `an account store never set up is complete...` covers both. The canary/owner double build (at most two builds, once an hour) is accepted as noted.

**Author, live run on a throwaway agent (after merge-ready):** the "still starting" rule misread `BlockerLedger not initialized (monitoring.blockerLedger.enabled is false)` as starting, so a fresh agent read "could not check plans" forever. A 503 that says the feature is disabled (`enabled is false`, `disabled`, `off`) is now off whatever else it says; unit-tested with that exact message, `work-board-disabled` and `work-board-starting`. Re-run on the throwaway: `complete: true`, one real need, nothing unchecked.

## Evidence pointers

- Integration: `tests/integration/team-access-routes.test.ts` (member and msp phones through the real middleware).
- Unit: `tests/unit/needs-read.test.ts` (25), `tests/unit/console-front-doors.test.ts` (17), `tests/unit/console-lifecycle.test.ts` (14), `tests/unit/console-needs-first-screen.test.ts` (136), `tests/unit/console-warning-paths.test.ts` (92), awareness and work-board wiring (64), layout budget (35).
- E2E: `tests/e2e/needs-read-alive.test.ts` (production AgentServer, console bearer and a paired owner phone).
- Live: throwaway agent on port 4791 built from this branch: `/needs` answered, a Secret Drop request appeared as a row without its token, console doors and redirects verified at both screen sizes.
- Apps: iPhone 47 unit tests and a simulator build; Android 5 new protocol tests and `compileDebugKotlin` on the M5 Pro.
