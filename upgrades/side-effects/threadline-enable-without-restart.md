# Side-Effects Review — switching pairing on with no restart asked of the person

**Version / slug:** `threadline-enable-without-restart`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `independent reviewer subagent` — required: the change requests a server restart (session-lifecycle surface)

## Summary of the change

After #2233 an agent asked to "connect with Echo" knows the invite flow, but when its relay (`threadline.relayEnabled`) or pairing (`threadline.verifiedPairing.enabled`) was off it had to switch them on in config and then ask its person to send `/lifeline restart`, because a session cannot restart its own server (`SessionServerGuard`). Justin (topic 61599, 2026-10-20) asked that a brand-new agent like PP have no confusion or difficulty, and `agent-connect-knowledge.md` named this restart as the one remaining friction. This change removes it. A new Bearer route, `POST /threadline/pairing/enable`, sets the two keys in `.instar/config.json` and, when a restart is needed, safe and allowed, requests the server's EXISTING supervised restart (the `state/restart-requested.json` flag the auto-updater and the money-layer enable surface already write; the lifeline supervisor or the ForegroundRestartWatcher acts on it). A server restart does not end the agent's tmux sessions, so the conversation that asked waits and carries on: it tells its person one plain sentence the route returns, polls `GET /threadline/pairing` until it answers 200, and makes the invite. Files: `src/threadline/connectEnable.ts` (new: the pure decision, the config write, the restart request, the deferred retry), `src/server/routes.ts` (the route), `src/core/AutoUpdater.ts` (`getRestartBlockers`, a pure read of the update restart gate), `src/lifeline/ServerSupervisor.ts` (restart-loop counting only for update restarts), `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (step 1 of "Connecting to another agent", new agents and existing ones), `src/knowledge/TreeGenerator.ts` (the node's budget), `src/threadline/ThreadlineMCPServer.ts` (the relay-enable note), tests.

### Why a sanctioned restart and not a hot start (option b over option a)

Investigated first. `threadline.relayEnabled` is read once, at boot, in `bootstrapThreadline` (`ThreadlineBootstrap.ts` §5) and in `server.ts`, which build from it: the `AgentTrustManager`, the `ThreadlineClient` and its pinned-key and encrypt-to resolvers, the `PairingInviteFlow`/store/events engine, the `ListenerSessionManager`, the `PipeSessionSpawner`, the inbound gate and the relay-ownership timers. Those objects are handed to `AgentServer` and the routes as fixed references (`ctx.pairingInvites`, `ctx.threadlineRelayClient`, `ctx.unifiedTrust`). The verified-pairing gate is read through `ctx.config`, which is the boot object; `LiveConfig` re-reads the file but does not update it. The existing `threadline_relay action:"enable"` MCP action only writes `relayEnabled` to disk and says "Restart the server to connect". The bootstrap's "reload lever" (§1.2) only re-reads identity for a relay that is already on.

A hot start (option a) would therefore need a second, live construction path for about a dozen components plus late-binding of every route reference, which is a large new surface on the A2A trust path and would have to stay in lockstep with boot forever. A sanctioned restart (option b) reuses the one restart path the server already trusts, adds a small, pure decision function, and the restored process is built by exactly the code every other boot uses. Option b is smaller and safer, so it is the one built.

## Decision-point inventory

- `POST /threadline/pairing/enable` — **add** — decides whether to restart: `ready` (no-op), `unavailable-here` (restart would not help: quiet standby, or relay and pairing already on with no invite engine here), `restarting` (requested now, or already on its way), `deferred` (another session is actively working; retried by the server for five minutes), `not-ready-after-restart` (refuses to loop), `restart-unavailable` (no running lifeline to bring the server back, or the request could not be written).
- `AutoUpdater.getRestartBlockers` — **add** — pure read of the update restart gate (`UpdateGate.getBlockingSessions`), asker excluded; never starts the update deferral clock.
- `ServerSupervisor.checkRestartRequest` restart-loop detection — **modify** — counts only restarts that name a `targetVersion`.
- `PostUpdateMigrator.migrateClaudeMd` — **modify** — replaces the old step 1 in place.

---

## Authority: the first whole-server restart a plain Bearer token can trigger

Said plainly: this is the first route through which the agent's ordinary Bearer token can restart the whole server. The money-layer enable restart needs the dashboard PIN; `POST /updates/apply` installs an update rather than restarting for a setting. Anything holding the agent's token (every session of this agent) can call it.

Why that is bounded rather than a new restart lever:
- **It fires once, then never again.** A restart happens only when pairing is NOT working on this machine (relay and/or the pairing gate off at boot). The route writes both keys before the restart, so the server that comes back has pairing on, and from then on every call answers `ready` and restarts nothing — for as long as the config stays on. Turning pairing back off takes a config edit, which the token holder could already make, followed by a restart it could not.
- **The 10-minute cooldown** (a persisted record of time + pid) means even a caller hammering the route in the window between two states gets at most one restart per ten minutes; a second restart is refused as `not-ready-after-restart` if the first did not make pairing work. The convergence ratchet holds this rate floor.
- **It never restarts a server nothing would bring back** (a live process that really is an Instar lifeline must hold the lock), never while a restart is already pending, and never past active sessions or restart holds except by waiting.
- A restart does not end agent tmux sessions (the supervisor kills only the server's own session), so the worst case of an unwanted call is one ~1-minute server blip, the same blip an update restart causes.

---

## 1. Over-block

No block/allow surface on messages, sessions or trust. The route can decline to restart:
- `deferred` while another session is healthy and active. A person who asked to connect while a long job is running waits for that job, as an update restart would; the agent tells them so in one sentence and the server restarts by itself when it settles. Agents with `updates.restartImmediately` are never deferred, as for updates.
- `not-ready-after-restart` for ten minutes after a restart for this that did not make pairing work. That is the right answer: a second restart would not help, and the reason is returned.
- A caller that omits `sessionId` is not excluded, so its own healthy session counts as a blocker and the request defers. The knowledge always passes `$INSTAR_SESSION_ID`; the deferred response lists the blocking sessions, so the omission is visible.

---

## 2. Under-block

- The route cannot know that the person asked. The knowledge allows it only on the person's request; the action is the same opt-in the person could make by editing config, scoped to this one agent, and the agent could already write those keys and run `threadline_relay enable`. What is new is that it takes effect without the person. The bounds: no restart when nothing would change, one restart in flight at a time, one restart per ten minutes for this, and deferral behind active work.
- With no lifeline running (a manual `instar server start` with no supervisor), the server's own ForegroundRestartWatcher would consume the flag and shut the server down with nothing to bring it back (found in second-pass review). The route therefore requires that `lifeline.lock` names a pid whose start time equals the `procStart` the lifeline recorded in the lock (`processStartMs`, the same identity proof `lifelineLock.ts` uses) AND whose command line (`ps -p <pid> -o command=`) is an Instar lifeline (`… instar … lifeline start`). The start-time match refuses a pid reused by ANOTHER agent's lifeline, whose command line would also match. A dead pid, a reused pid, a lock without `procStart`, or an unreadable start time or command line fail closed to `restart-unavailable` (config written, no flag), and the agent tells its person it could not switch it on by itself. A lifeline that is alive but wedged would still be trusted; that is the same exposure every update restart has.
- On a multi-machine agent following the lease (`relayFollowsLease`), a non-lease machine with the relay off restarts, then releases the relay; the invites route answers its existing 503 and step 2's existing "another machine holds the relay" path takes over. The cooldown keeps it from restarting again.

---

## 3. Level-of-abstraction fit

Right layer. The restart is the server's existing supervised path (no new restart machinery, same flag and shape as the money-layer surface, `plannedRestart: true` so the supervisor treats it as maintenance). The deferral is the update gate's own classification, read through `AutoUpdater` rather than re-implemented. The decision is one pure function with every input passed in. The session guard is untouched: a session still cannot run `instar server restart`; it asks its own server, which owns the restart.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The route opts this agent in and requests a restart; it gates no message, session or trust decision. Its refusals (`deferred`, `unavailable-here`, `not-ready-after-restart`) only withhold a restart, are explained in the response, and leave everything else as it was.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is another session actively working" reuses the update gate's existing classification (no new heuristic). The other conditions are invariants: pairing already works, a restart cannot help, a restart is already pending, a restart already happened in the last ten minutes. The ten-minute cooldown is a safety floor on an action that restarts the whole server, deterministic by design.

---

## 5. Interactions

- **Shadowing:** the route is registered before `/threadline/pairing/:peerFp` routes; `enable` is not a 32-hex fingerprint and the only same-shape route is `GET /threadline/pairing/:peerFp`, a different method.
- **Double-fire:** if an update restart is already pending, the route writes no second flag and reports `restarting`; the update restart applies the config too. Two quick calls write one flag (the second sees it pending, or sees its own pid in the record).
- **#2242 restart holds (a pairing invite awaiting the operator's approval, held in memory only):** the enable restart OBEYS them, bounded by its own 5-minute give-up. Reasoning: a hold exists precisely because a restart would destroy in-flight pairing work the same person is in the middle of (the invite's secret is never on disk), and the connect-enable restart exists to help that person pair; bypassing the hold would trade one pairing for another and silently lose the one already under way. Holds come only from the invite engine, which exists only when the relay is already on (so a hold can coincide with an enable request only in the relay-on, pairing-gate-off case). The enable restart's own config change creates no hold, so it cannot wait on itself; and it cannot wait forever on someone else's hold either: after 5 minutes it records `gave-up` (config written, restart still pending) and the next restart, including the update restart that runs once the hold ends, applies the change. `AutoUpdater.getRestartBlockers` lists active holds as `hold:<name>` (even under `updates.restartImmediately`, matching how updates treat holds) and still never touches the update deferral clock or `maxDeferralHours`. Tested with a real AutoUpdater and a pairing-invite-shaped hold provider.
- **Concurrent config writers:** there is no shared config writer or lock to join (PATCH /config, PATCH /updates/config, the Threadline MCP server and the CLI all do a plain read-modify-write). Within the server process nothing can interleave (every write path, this one included, is synchronous within one event-loop turn). Across processes (the MCP server, the CLI, a session editing the file), `writeConnectConfig` is a compare-and-swap: it re-reads the file just before the rename and starts over from the new content if it changed, up to 5 times, else refuses to write. A concurrent edit is never overwritten with stale content; the remaining gap is between that re-read and the rename. Tested by changing the file between read and commit.
- **Races:** the supervisor consumes the flag and then restarts; in that window the old process still answers. The record carries the writer's pid, so the old process answers `restarting`, never `not-ready-after-restart`. Config is written by read-modify-write with a temp file and rename; a concurrent writer of another key could lose a write in the same millisecond, the same exposure as `PATCH /updates/config`.
- **Feedback loops:** the deferred retry re-runs the same decision every 30s and stops as soon as the answer is anything but `deferred`, or after five minutes, when it logs `[connect-enable] gave-up: …` and records `state: "gave-up"` (config written, restart still pending, the reason naming what held it) in `state/threadline-connect-enable-status.json`, readable through `GET /threadline/pairing/enable`; a fresh request supersedes it. Five minutes is how long the agent waits before telling its person it could not switch pairing on (so the server never restarts after the person was told it would not). It can request at most one restart, and after that restart the record stops it from requesting another for ten minutes.
- **Supervisor restart-loop counter (found while tracing the path):** `checkRestartRequest` counted restarts per `targetVersion` and skipped the third with the same one. Restart requests with no version (money-layer enable, the fix-command restart, this route) all shared one "undefined" count that never reset, so every third one was silently dropped, flag deleted. The supervisor now counts only update restarts. Lifelines already running keep the old code until they restart, so the route also removes a count file that has no `targetVersion` before writing its flag (an update loop count, which always has one, is left alone). Not adding `targetVersion` is deliberate: the supervisor treats a version as an update and restarts the lifeline after.
- **Session guard:** unchanged. `SessionServerGuard` still refuses lifecycle commands from inside a session.

---

## 6. External surfaces

- **Other agents / install base:** every agent gains the route and, on update, the new step 1 text. Behaviour changes only when an agent whose pairing is off is asked by its person to connect.
- **External systems:** after the restart the agent joins the Threadline relay with its configured visibility (default `public`), as `threadline_relay enable` already allowed.
- **Telegram during the restart:** the lifeline holds incoming messages while the server is down and replays them; `plannedRestart` suppresses the "server down" alert. The person sees one sentence from the agent, then the invite.
- **Persistent state:** `.instar/config.json` (two keys; the file keeps its mode, 0600 at init, since it holds the auth token), `.instar/state/restart-requested.json` (consumed by the supervisor), `.instar/state/threadline-connect-enable.json` (the last request's time and pid, for the cooldown), and possibly the removal of a version-less `restart-version-count.json`.
- **Operator surface (Mobile-Complete):** no new operator action. The operator does nothing; that is the point. Approve and Finish remain Telegram buttons.

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The relay connection, the config file and the restart flag are per machine, and only the machine that holds the relay can make invites. The route answers `unavailable-here` on a quiet standby (`multiMachine.telegramPolling: false`) and when relay and pairing are already on but this machine holds no invite engine, and the knowledge sends the agent to step 2's existing path (`GET /pool/placement`, `POST /pool/transfer`) to do it on the holder. No user-facing notices are emitted by the server (the agent speaks), no durable state strands on a topic transfer (the record is a cooldown on this machine only), and no URLs are generated.

---

## 8. Rollback cost

Pure code. Revert and ship a patch. Agents that already received the new step 1 would point at a route that no longer exists (404); a follow-up migration would restore the old line. Config keys an agent switched on stay on, which is the state its person asked for. The supervisor change is independent and safe to keep.

---

## Conclusion

Built option b, a sanctioned restart through the existing supervised path, because a hot start would mean a second construction path for the whole Threadline stack. Tracing that path found a real defect: the supervisor silently skipped every third restart request that named no version, which would have left the agent polling a server that never restarted. Fixed at the source, and worked around for lifelines still running old code. The tree node's budget was raised (900 to 1400 tokens) because the longer step 1 pushed the Finish step past the cut, which the existing test caught. The second-pass review raised four concerns, all resolved below. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only audit of this artifact against the code)
**Independent read of the artifact: concern raised, then CONCUR after the fixes below (re-read by the same reviewer)**

- *The cooldown record was written after the flag, so a failed record write reported `restart-unavailable` for a restart that was already queued.* Resolved: the record write is now non-fatal and logged once the flag is in place (`writeConnectRestartRequest`); test "a cooldown record that cannot be written does not turn a queued restart into unavailable".
- *§2 claimed an unsupervised launch never consumes the flag; in fact the server's own ForegroundRestartWatcher consumes it and shuts down with nothing to bring it back.* Resolved in code, not just text: the route restarts only when a lifeline holds `lifeline.lock` with a live pid (`lifelineRunning`), else `restart-unavailable` with the reason; unit + route tests.
- *The deferred retry could restart hours after the agent told its person it could not.* Resolved: the retry gives up after five minutes (`CONNECT_ENABLE_DEFER_MAX_MS`, the agent's own wait), and the deferred sentence no longer promises an open-ended finish; test with a clock past the window.
- *The config rewrite dropped `config.json`'s 0600 mode and could leave a temp file.* Resolved: the mode is kept and the temp file removed on failure; test checks 0600 and no leftover temp.

The reviewer's non-blocking leftover (`lifelineRunning` checked only that the lock's pid was alive, so a reused pid could pass) is closed in this PR: the pid's start time must equal the lock's recorded `procStart` and its command line must be an Instar lifeline, else fail closed; unit-tested with a real unrelated process at the lock's pid and with a real lifeline-shaped process whose start time does not match the lock (another agent's lifeline on a reused pid).

Confirmed sound by the reviewer: the Bearer check runs before any side effect; the supervisor change keeps update-loop detection and leaves `pendingUpdateVersion` null for a version-less restart (no lifeline self-restart); `performGracefulRestart` kills only the server's own tmux session, so agent sessions survive (Threadline pipe sessions end, as on any update restart); the migration stays inside the section and is idempotent.

---

## Evidence pointers

- `tests/unit/threadline-connect-enable.test.ts` (see the PR for the final count): every decision branch; the config write keeps other keys and is idempotent; the flag has no `targetVersion` and is planned; a version-less count file is cleared and an update count kept; the controller restarts, defers with the asker excluded, retries on its own timer and restarts when the way clears, gives up after five minutes, refuses without a lifeline, reports `restart-unavailable` when the flag cannot be written and stays `restarting` when only the cooldown record cannot be; `lifelineRunning` is true only for a live lock pid; `config.json` keeps its 0600 mode; `getRestartBlockers` drops the asker, returns none under `restartImmediately` and does not start the deferral clock; the supervisor performs three version-less restarts in a row (including from a writer that does not clear the count) and still skips the third restart for one update version; new agents' step 1 uses the route and never mentions `/lifeline restart`; an existing agent's old step 1 is replaced in place once, a rewritten one and one outside the section are left alone; the tree node serves the whole section to its last line.
- `tests/integration/threadline-pairing-enable-route.test.ts` (5 tests): on a real AgentServer, the route maps the asking session's `INSTAR_SESSION_ID` to its name so it never holds its own restart; another active session defers (config written, no flag, blocker named); a missing session id makes the asker count against itself and the response names it; no running lifeline → 503 `restart-unavailable`, no flag; a quiet standby → 409, config untouched.
- `tests/e2e/threadline/pairing-enable-without-restart.test.ts`: a fleet agent (not a development agent) with relay off boots on a real relay; invites answer 503; the agent's one call returns `restarting` with a sentence that asks nothing of the person; config and flag are on disk; the real ForegroundRestartWatcher picks up the flag and the server boots again from disk; invites now answer 200 with a `tlinv1:` message; the route answers `ready`.
- `tests/unit/agent-connect-knowledge.test.ts` (19, unchanged) passes with the new text.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed by this change (the knowledge text changes because the mechanism changed, not because the text was wrong) — not applicable for that branch.

The deferred retry is a self-triggered controller that can request a restart, so its convergence argument is stated here: **control-loop edge** — the retry re-runs `decideConnectEnable` and writes the flag only when it returns `restarting` with `requestRestart`; **steady-state bound** — under sustained pressure (another session active forever) it writes nothing and never restarts; once the gate clears it writes exactly one flag and disarms; **settling brake** — the retry stops after five minutes even if the pressure never clears; the request record (time + pid) makes every later call answer `restarting` (same process) or `not-ready-after-restart` (new process) for ten minutes; and the timer is in-memory, so the restart it requests also ends it. At most one restart per ten minutes per agent machine, and none without a running lifeline.

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `guard`
- **`guardEvidence`:** `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (controller threadline-connect-enable-restart in src/testing/selfActionRegistry.ts, driving the real decideConnectEnable), howCaught: under the route called every minute for 48 h with pairing never ready and the flag consumed without a restart, emits stay at least 10 minutes apart within a process and across reconstruction; with the cooldown removed the ratchet fails its rate-floor, 2x-horizon and reconstruction checks (verified)}`
