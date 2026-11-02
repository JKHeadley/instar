# Side-Effects Review — media in app conversations, increment 1 (copies between machines)

**Version / slug:** `mobile-native-chat-media-cross-machine`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `independent review 2026-11-02: CONCERN, six findings, each fixed below (confirming pass not run; brief: --second-pass false)`

## Summary of the change

Builds the rest of increment 1 of `docs/specs/mobile-native-chat-media.md` (converged, approved), the cross-machine half that PR #2573 left out (its side-effects file, `mobile-native-chat-media-inc1.md`, listed it). New: `AppMediaReplicator` (`src/core/AppMediaReplicator.ts`) with the serve side of a new mesh verb `app-media-pull` (≤ 1 MiB slices of a blob an unpurged local event references, async positional reads through an `O_NOFOLLOW` + inode-checked descriptor, at most 2 served at once; the held-hash inventory, paged or as a diff against a version the asker holds; a nudge), the eager background pull (5 s tick, ≤ 8 slices per tick, disk-floor pause, bounded load pause, per-blob backoff 30 s → 1 h and a 7-day give-up, per-peer breaker 5 failures → 15 min, 3 opens/day → closed until tomorrow), hourly peer inventories, `singleCopyBlobs` and the §4.12 alarm ladder (re-queue on peers by nudge after an hour, then one notice; offline peer > 24 h; unmeasurable > 2 h), `unrecoverableBlobs` with its notice. `AppMediaStore` gains `pulls/`, three tables (`pulls`, `pull_peers`, `pending_deliveries`), `publishPulled` and `heldHashes`. `AppConversationService` builds the replicator, marks it dirty on replicated media/purge events, and implements the owner-side delivery (`sessionLinesFor`: pull for ≤ 60 s, else `[file still copying: <name>]` + a durable row; `resolvePending`: one `[file now available: <path>] (for the message "…")` line into the live session when the blob lands, de-duplicated by attachment; otherwise the line rides the next delivery's context and is removed once delivered; rows older than 7 days become a "could not be copied" line). The download route answers `202 {state: "fetching", retryAfterMs}` and starts a priority pull; `app-media-path` pulls for ≤ 30 s and says why when it cannot; `/health?scope=pool` adds `appMediaPool` through the existing pool read helper. `MeshRpc` gains the verb in the registered-peer read class; `server.ts` registers the handler and attaches the transport (the same `MeshRpcClient` + `peerUrl` every other verb uses, peers from the identity registry, online from the pool registry, load from the work-admission verdict). CLAUDE.md section line refreshed in place for existing agents; CapabilityIndex text; a self-action controller for the copier's notices and nudges. Tier 2.

**What remains of the spec after this PR:** increments 2–5 (server-side transcription, Telegram/Slack continuation, push preview, the iOS app). See "Declared limits" for the one part of §4.12 whose trigger does not exist yet.

## Decision-point inventory

- Serve a slice — add — invariant: hash format, offset range, an unpurged local reference, a held blob opened `O_NOFOLLOW` with a matching inode, ≤ 2 concurrent serves.
- Keep a pulled copy — add — invariant: slice offset/size equal the request and the reference; whole-file length and SHA-256 equal the reference; nothing else is ever kept.
- Pause pulls — add — invariant: the existing disk floor (5% / 2 GiB); the existing work-admission load verdict on its two worst values, at most an hour at a time.
- Give up on a blob / open a peer breaker — add — invariant: fixed backoff, 7-day give-up, 5-failure breaker, 3-opens-per-day latch.
- Single-copy alarm — add — invariant: counts from inventories younger than 2 h; null (never 0) when unmeasurable; fixed 1 h / 24 h / 2 h thresholds.
- Dispatch with "still copying" — add — invariant: fixed 60 s deadline; follow-up de-duplicated by attachment id.
- Download `202 fetching` vs `404 media-unavailable` — modify — `404` only for an unrecoverable blob or a machine with no mesh transport; otherwise `202`.

---

## 1. Over-block

- **A blob only one machine holds while that machine is offline** cannot be downloaded elsewhere: the app sees `202` until it gives up polling (60 s, its own rule), and after 7 days `404`. By design — the bytes are not reachable.
- **Busy serve side:** a third concurrent slice request is answered `busy`; the asker retries next tick with no backoff penalty.
- **Load pause:** background copying stops for up to an hour on a machine reporting `saturated`/`impaired`; on-demand pulls (download, app-media-path, dispatch) are not paused by load. Only the disk floor stops them.
- **A peer whose copies fail verification** is skipped even for files only it holds (15 minutes, or the rest of the day after three opens). Files it holds stay on it; the single-copy and unrecoverable counts make this visible.

## 2. Under-block

- **Admission cap is still soft across machines** (unchanged, spec §4.7). Pulls are never stopped by the cap, only by the disk floor.
- **A machine lost before its blobs were copied loses them** (spec §4.12 residual risk). Eager pull and the single-copy alarm shorten and expose the window; nothing makes it zero.
- **Inventories are in memory.** After a restart `singleCopyBlobs` reads null until the next inventory round (at most an hour) — honest, not a fabricated 0 — and the alarm episode clocks restart.

### Declared limits (no code change)

- **"The owner pulls before dispatch" has no cross-machine trigger yet.** The parent spec (mobile-native-conversations.md §4.8) forwards a send accepted on a non-owner to the owner; that forward is not built (a non-owner still answers `503 owner-unavailable` after persisting — `AppConversationService` header). So today the dispatching machine is always the accepting machine, which already holds the blobs it just published. The pull-before-dispatch code (`sessionLinesFor`) is in place on the dispatch path and is exercised by the integration test directly on a machine that lacks the blob; it activates for real when the forward ships. It also covers the case where the dispatching machine's own blob went missing.
- **The follow-up line is typed into a live session only.** It never spawns a session; with no live session it waits for the next delivery's context. A conversation that never receives another message never sees it (the file is still listed in history and opens with app-media-path).
- **Nudges are best effort.** A nudge whose send fails is reported as a degradation, not retried in that episode; the notice an hour later is the backstop.

## 3. Level-of-abstraction fit

Byte copying sits in one class beside the media store and below the routes; it rides the existing signed MeshRpc transport (`MeshRpcClient`, the `/mesh/rpc` dispatcher, `peerUrl`) rather than a new channel, and its own verb rather than `working-set-pull` (whose serve side reads and hashes whole files synchronously, spec §3). Hashing runs in the existing media worker. The load signal is the existing work-admission verdict; the pool health read uses the existing `readReaperPoolPeers` helper with its rate limiter, roster accounting and bounded body. The pending "still copying" rows live in the media index beside upload state, so they are recovered with it.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No judgment-based block/allow surface: every refusal or pause is a fixed invariant (hash equality, sizes, offsets, references, counts, timers, the existing disk floor and load verdict). The verb adds reach, never authority: a peer can only cause this machine to fetch bytes an event it already holds refers to, and only bytes that hash to that reference are kept.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point; every decision above is an invariant declared in the spec's `## Decision points touched` table (pull give-up, breaker, disk-floor and load pauses, the 60 s dispatch deadline).

---

## 5. Interactions

- **Purge and orphans:** a purged attachment is not `allRefs`, so it is never served, wanted or counted; a pull row and partial file for a hash that stops being wanted are removed on the next wanted refresh. The orphan sweep now also skips a hash named by a pending-delivery row. Pulled blobs referenced only by deleted conversations land in `deleted/`.
- **Quarantine:** `publishPulled` uses the same `publish` path, so a verified pulled copy also retires a quarantined copy of that hash (renamed aside, never deleted), as a fresh upload does.
- **Disk floor:** a part already complete when the floor is hit is kept (verified, not published) and published on a later tick without another request.
- **Dispatch timing:** the send route now awaits `sessionLinesFor`; when the blob is local (always, today) there is no wait. When a pull is needed the phone's request can take up to 60 s before it answers.
- **Concurrency:** the pull tick is single-flight; `want()` triggers a tick, which returns immediately if one is running. `resolvePending` claims a row (`waiting → ready`) before typing the line, so two landings never type twice.

## 6. External surfaces

- **Other machines of the agent:** a new mesh verb. An older peer answers `no-handler` (501); the puller treats it as a failed attempt for that blob (backoff), never a verification failure. An older peer asking this machine gets a normal answer.
- **Phones:** `GET /mobile/media/:sha256` can now answer `202 {state: "fetching", retryAfterMs: 2000}`; `404 media-unavailable` now means unrecoverable or no mesh.
- **Sessions:** new lines `[file still copying: <name>]`, `[app:…] [file now available: <path>] (for the message "…")`, and a "Files from earlier messages" block in the context file. app-media-path's failure line now names why.
- **Operator:** up to three new attention items per machine (`app-media:single-copy:<machine>`, `app-media:unrecoverable:<machine>`, `app-media:peer-breaker:<peer>`), each raised once per episode and cleared when the condition ends.
- **Persistent state:** `<stateDir>/app-media/pulls/`, three tables in `app-media/uploads/index.sqlite`.

## 6b. Operator-surface quality

No operator surface added (no dashboard or approval page) — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- Blobs: **unified by full replication** — this PR is that replication (every machine pulls every unpurged blob an event it holds references, verified).
- `singleCopyBlobs`: **measured from peers' inventories** (pulled hourly over the mesh); null when any registered peer's inventory is missing or older than 2 hours.
- Pull state, breakers, pending deliveries: **machine-local by design** — each describes what this machine holds and is copying; the pending rows belong to the machine whose session was told "still copying".
- `/health` `appMedia`: **proxied on read** with `?scope=pool` (`appMediaPool`), unreachable machines in `failed`.
- Notices: one per condition per machine; the condition keys carry the machine id, so two machines never raise the same item for each other.

## 8. Rollback cost

Revert the PR: the verb disappears (peers on this version see `no-handler` and back off), copying stops, files stay where they are; `pulls/` and the three tables are left unused. Or turn `mobilePairing.native.enabled` off (the media flag gates phone routes only; copying of already stored files continues while native conversations are on, so switching media off never strands a copy). Dark on the fleet.

---

## Conclusion

The remaining increment-1 surface ships with every pull verified before storing and every loop braked (per-tick slice cap, backoff, give-up, breaker, latch, single-flight, serve concurrency cap). Found while building: a part file already complete (left by the disk floor) would have triggered a zero-length slice request and been counted as a verification failure; it is now verified and published without a request. The pull-before-dispatch path has no cross-machine trigger until the parent spec's owner forward ships (declared above). A second-pass review is normally required for dispatch changes; the build brief for this PR set `--second-pass false`, so none was run, and the reviewer of the PR should treat this as the first independent read.

---

## Fix after the first Local Verify

The full Local Verify failed 9 integration tests in `tests/integration/health-stale-job-failures.test.ts` and `tests/integration/lease-medium-health.test.ts`. Cause: the `appMediaPool` branch read `req.query.scope` unguarded, and those tests (like any caller that drives `router.handle` without Express's query parser) send a request with no `query`, so every `/health` call threw `Cannot read properties of undefined (reading 'scope')`. Fixed with `req.query?.scope`; both files pass again, with the media tests and `health-auth-gating`. No test was changed.

## Fixes after the independent review (CONCERN)

1. **Purge during the hash** (medium, confirmed): `finishPart` awaited the worker hash and then published without re-checking the reference, so a purge landing mid-hash let purged bytes reach `blobs/` until the next sweep. Now the reference is re-checked after the hash (the partial copy, pull row and waiters are dropped), and `AppMediaStore.publishPulled` itself discards a file whose hash has no unpurged reference. Test: a purge applied while the last slice is in flight.
2. **`202 fetching` only when a copy can start** (confirmed): the route now asks `canFetch` and answers `404 media-unavailable` with the reason when there is no mesh, the blob was given up on, the machine is below the disk floor, or no online peer with a closed breaker could hold it (a fresh inventory lacking the hash rules a peer out). `whyNotHere` names the disk floor and the background load pause. **Load is not a refusal for an on-demand copy**: spec §4.12 pauses the eager background pulls under load, and the download's pull is the on-demand latency path, which is not paused, so a `202` under load is true. Tests: unit `canFetch`, integration 404 with the reason.
3. **Backoff reset on every poll or nudge** (confirmed): `want()` and the nudge set `nextAttemptAt = 0` each time, so an app polling every 2 s retried every 2 s. Now an ask or nudge skips a file's backoff at most once per backoff window (`hurry`); a nudge still re-arms a given-up file once (the peer names itself a holder, §4.12). Test: ten asks + ten nudges in a window → one extra attempt.
4. **Timed-out waiters stayed in the list** (confirmed): removed on timeout. Test.
5. **Blame for a failed hash** (confirmed): chose the simpler rule, *one peer per partial copy*. The peer that served offset 0 serves every later slice; if it stops serving (offline, breaker, refusal, no answer) the partial copy is discarded and restarts from another peer. A failed whole-file hash is then blamed on exactly that peer. The pin is in memory: after a restart a partial file with no known source restarts from 0 (cost: re-copying at most one partial file per blob). The serving side re-hashes a blob whose size or mtime changed since its last check before serving it, and quarantines a damaged one locally (`verifyBeforeServe`), so a damaged copy is not sent. Tests: restart-from-another-peer with blame on the bad peer only; serve-side quarantine.
6. **Gate wording** (confirmed): the spec (Configuration) requires pulls to keep running with the media flag off, so the handler, tick and inventory stay on `mobilePairing.native.enabled`; the upgrade note was corrected to say so.

## Second-pass review (if required)

Not run (brief: `--second-pass false`).

## Evidence pointers

- `tests/unit/app-media-replicator.test.ts` (21 tests), `tests/unit/PostUpdateMigrator-appMedia.test.ts` (copy-line refresh), `src/testing/selfActionRegistry.ts` controller `app-media-replication`
- `tests/integration/app-media-cross-machine.test.ts` (9 tests), `tests/e2e/app-media-cross-machine-alive.test.ts`

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (the copier nudges peers and raises notices on its own; it retries pulls on its own).
- **`closure`** — `guard`.
- **`guardEvidence`** — `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (controller app-media-replication, src/testing/selfActionRegistry.ts), howCaught: under a file held alone forever with every peer online, the copier nudges once per episode and raises the single-copy notice once (the raised latch keyed by condition and reason), so the action count is 2 at any horizon}`. Per-blob retries are bounded by the backoff and the 7-day give-up (`tests/unit/app-media-replicator.test.ts`, "backs off 30 s → 1 h, gives up after 7 days").
