# Side-Effects Review — Listen early during boot, and attributed restarts

**Version / slug:** `listen-early-boot-readiness`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end of this file)`

## Summary of the change

On 2026-11-16 the M5 Pro's server was unreachable for 2m43s after a restart logged only as "requested by undefined" (a session hand-wrote `state/restart-requested.json` after editing `monitoring.localVerify.operatorGhLogin`, which Local Verify read only at boot). This change:
(1) graduates the boot beacon (`src/server/BootHealthBeacon.ts`) from the dev gate to every agent, binds it on the same host as the real server (`resolveMeshBindHost`), and makes it answer every route, `/health` included, with a typed 503 "starting" (`Retry-After`, `x-instar-boot-state: starting`, `bootReadiness` body);
(2) adds `src/server/BootReadiness.ts`, the process-wide boot state behind the beacon and a new `bootReadiness` field on `/health` (`state: starting|ready`, subsystems, retry estimate from the previous boot, early-listen host, and for an authed caller the restart that ended the previous process);
(3) teaches `ServerSupervisor` that a typed "starting" probe is alive-not-up (no failure, no serverUp) up to its existing 3× grace ceiling;
(4) names every restart requester (`src/core/restartRequestAttribution.ts`), records consumed requests to `.instar/logs/restart-requests.jsonl`, and adds `POST /server/restart {requestedBy, reason}`;
(5) reads `operatorGhLogin` live in LocalVerifyService and StatusReconciler;
(6) has the conversation graph treat a booting peer's typed 503 as unavailable, not unverified;
(7) adds one awareness entry, prints "Starting" in `instar status`, and moves the ladder entry to finished.
Tier 1: a revert, or `monitoring.bootHealthBeacon.enabled: false`, undoes it. Size: about 15 source/test files, ~700 lines including tests. Effort: one design revision during build (the beacon's `/health` changed from 200 to a typed 503 once the fleet callers that read 200 as "serving" were found), no spec review rounds.

## Decision-point inventory

- `ServerSupervisor` health tick — modify — a typed "starting" 503 past the startup grace is neither a failure nor "up"; bounded by the existing ceiling (startupGraceMs × 3).
- Boot beacon gate (`monitoring.bootHealthBeacon.enabled`) — modify — dev-gated → on unless `false`.
- `POST /server/restart` — add — authenticated request to the existing supervised restart; refuses an unnamed or reasonless request (400).
- Restart-flag consumers (supervisor, ForegroundRestartWatcher) — pass-through — same decision, now named and recorded.
- Local Verify eligibility (`checkEligibility`) — pass-through — same rule, operator login read live.
- Conversation graph peer call — modify — a 503 carrying `x-instar-boot-state: starting` no longer sets `refusal = 'response-unverified'`; the peer counts as unavailable, as a refused connection did before.

---

## 1. Over-block

`POST /server/restart` refuses a request with no `requestedBy` or `reason`, a multi-line value, or one over 100/300 characters. Legitimate callers have a name and a reason; the 400 says exactly what is missing. A hand-written flag still restarts (it is labelled, not refused), so no existing path loses its restart.

The supervisor's "starting" branch could hold off a restart of a server that is truly wedged while its beacon still answers. The beacon is closed at the handoff before `server.start()`, so it answers only during boot. The hold is bounded from the episode's first spawn (the existing `firstSpawnedAt` ceiling: startupGraceMs × 3 = 30 min), or from the first "starting" probe for a server the supervisor adopted. It is cleared only by a healthy answer, never by a "down" probe in between. A "starting" probe neither counts nor clears failures, so a boot that alternates starting and down still reaches the failure threshold. (The first draft anchored the bound after the grace and reset it on a down probe; the second-pass review caught it.)

---

## 2. Under-block

- A writer can still hand-write the flag, and it restarts. That is deliberate (see 1); it is now visible in the log line, the JSONL record and `bootReadiness.previousRestart`.
- Other settings read only at boot still need a restart. This change makes the one that caused the incident live and gives every other one an attributed path; it does not audit every boot-read setting.
- During the sub-second handoff gap (beacon closed, real server not yet bound), a caller can still see ECONNREFUSED. Unchanged from the dev-agent behaviour since topic 21816.
- Work before the beacon binds (config load, the single-instance lock) is not covered. It takes a few seconds, against minutes for the boot after it.

---

## 3. Level-of-abstraction fit

The beacon is the right layer: it already owned "answer during boot", so this extends it rather than adding a second listener. Readiness lives in one module that the beacon, the boot sequence and `/health` all read; it is not threaded through constructors. Attribution sits beside the flag's two consumers, not in each writer, so it catches writers outside instar (the incident's case). The live-login change reuses LiveConfig, which already watches `monitoring`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new brittle block/allow authority over agent behaviour or messages.

The supervisor decision is liveness classification on a typed header that instar itself emits, not a heuristic on content. It only defers a restart for a bounded time, and the bound is the existing ceiling. The route's 400 is input validation on an API, not a judgment gate. Attribution and readiness are signals: they name and report, and decide nothing.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Booting" is an invariant state the server declares about itself (the beacon only exists between boot start and the handoff). The 30-minute bound is the supervisor's existing safety ceiling on an irreversible action (a restart), reused, not a new threshold.

---

## 5. Interactions

- **Supervisor grace:** inside the startup grace nothing changes (failures were already ignored there). Past it, a "starting" probe returns early after `checkRestartRequest()`, without counting or clearing failures, and skips the debug-restart and sleep checks for that tick while booting. `bootingSince` is cleared on a fresh spawn and on a healthy answer.
- **Peers that read any 503 as "off":** before this change a booting fleet peer refused the connection. Two callers turned a 503 into a definite answer. Unread catch-up marked the peer `done` ("nothing to retry"); it now treats a booting peer as a failure to retry (`isPeerBooting`). Stand-down classified the peer `absent`; it is now unknown (`null`). Display-only readers (machine-maintenance pool `not-enabled`, mobile routes `off`) show a booting peer as off for the seconds it boots; they decide nothing, and the machine-maintenance file belongs to that session.
- **Recovery service:** a refused connection on `/whoami` allowed repair (`main-http-unreachable`). The beacon's typed 503 now reports `main-starting` with repair still allowed, so a boot hung behind the beacon can still be repaired as before (checked inline, so the recovery slot pulls in no server module).
- **Fleet watchdog script (`instar-watchdog.sh`):** it reads any non-200 as a bind failure. On the fleet that matches the refused connection it saw before. On a dev agent it ends the beacon's old 200, so a dev boot now looks like a fleet boot did. Not changed.
- **`POST /server/restart` and a pending update:** the route leaves a pending, unexpired update flag (one with `targetVersion`) in place and answers 202 with `alreadyPending`, so the update and its restart-loop detection are kept. Control characters are refused in both fields.
- **Old lifeline + new server:** a lifeline not yet restarted onto this code sees a 503 during boot and falls back to its grace window. That is the fleet's behaviour before the beacon existed (ECONNREFUSED); a dev agent loses the beacon's old 200 until its lifeline updates, and the 10-minute grace still covers a normal boot.
- **Lifeline forwarding:** the old beacon's 200 made a dev agent's supervisor emit `serverUp` mid-boot, so the Telegram lifeline forwarded queued messages into the beacon's 503. With a 503 on `/health` the lifeline keeps queueing until the real server answers. A latent fix.
- **install / test-as-self / hooks / Slack lifeline:** they read a 200 (or `status: ok`) as serving. The beacon never answers 200, so they behave as before.
- **Conversation graph:** a booting peer reads `graph-peer-call-peer-starting` and counts as unavailable, as a refused connection did, so custody does not stop at `reachable-unverified` for a boot.
- **Machine self-maintenance:** it reads `bootReadiness.state` for its PostRestartProof server row. None of its blocks in `src/commands/server.ts` were edited.
- **Port conflicts:** if the old process still holds the port, the beacon's bind fails, which is non-fatal and recorded as feature evidence, and boot continues as before.

---

## 6. External surfaces

- Other agents and machines: peers reach a booting multi-machine agent on its mesh host and get a typed 503 instead of ECONNREFUSED. The body holds only code-defined names, timings and the bind host. `previousRestart` (a session name and reason) is shown only to an authenticated caller.
- Exposure: the beacon binds exactly the host the real server binds a moment later. A single-machine agent stays on 127.0.0.1.
- New files: `state/boot-readiness.json` (boot length) and `.instar/logs/restart-requests.jsonl` (bounded 256 KB).
- New route: `POST /server/restart` (Bearer).
- Timing: Retry-After depends on the previous boot's length, bounded 2 to 30 s.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. Boot state, the boot-length record and the restart record describe one process on one machine. A peer reads them over HTTP from that machine's own `/health` (the beacon answers on the mesh host for exactly this). No notices are sent, so one-voice gating does not apply. Nothing strands on topic transfer.

---

## 8. Rollback cost

`monitoring.bootHealthBeacon.enabled: false` turns the early listener off on one agent, with no release needed. A code revert removes the rest; the two new state files are inert and safe to leave. No migration and no data repair. The supervisor change falls back to the old behaviour whenever no typed header is present.

---

## Second-pass review

**Reviewer:** independent general-purpose subagent, read-only, 2026-11-16.

**First pass: Concern raised.** Findings:
1. The supervisor bound started after the grace (about 40 min total), ignored the `firstSpawnedAt` ceiling, and was reset by any "down" probe, so a boot that alternated starting and down was never restarted.
2. Peer callers read any 503 as "off": unread catch-up was marked done, and stand-down classed the peer absent.
3. The recovery service could no longer repair a boot hung behind the beacon.
4. The watchdog script reads a dev boot as a bind failure (low).
5. The route could overwrite a pending update flag and let tabs and escape characters through (low).
6. No defect in the port handoff. The handoff gap runs longer than sub-second; harmless.

**Resolution:** 1, 2, 3 and 5 are fixed as described in sections 1 and 5, with tests: supervisor alternating-probe and first-spawn-anchor cases, an integration test for unread catch-up against a booting peer, `isPeerBooting` unit cases, and route cases for a pending update and control characters. 4 is accepted and documented: it makes a dev boot look like a fleet boot did. The display-only readers are documented in section 5.

**Second pass, after the fixes: Concur with the review.** The reviewer read all four fixes in the code (supervisor bound, booting peers, recovery service, restart route) and found no remaining defect. One note: a "starting" probe no longer resets the failure count, so two stalled probes after the grace, even far apart, restart a slow boot. That is still gentler than the fleet's earlier behaviour.

## Follow-up commit (Local Verify, 2026-11-17 03:08Z)

Local Verify on `3220dce69` failed three registry tests from this change: the `/server` prefix was unclassified (`capabilities-discoverability`), the new POST had no write-domain declaration (the write-domain ratchet), and the `/health` additions pushed `ProcessIntegrity` out of the window `stale-version-prevention` scans. The fixes:
- `server` is added to `INTERNAL_PREFIXES`; agents learn the route from the awareness entry.
- The route is annotated `@write-domain:none`, because it writes only this machine's own restart flag.
- The `bootReadiness` lines move to the end of the `/health` handler, before the pool branch. Behaviour is unchanged.

**unbounded-self-action:** closure `n/a`. `POST /server/restart` writes one restart request per authenticated call from a session or operator. That is a one-shot, caller-driven action, not a self-triggered loop. How the request is consumed is unchanged, so the supervisor's restart-loop detection still applies.
