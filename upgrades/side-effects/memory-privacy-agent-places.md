# Side-Effects Review — Memory privacy: another agent gets a place of its own instead of a refusal

**Version / slug:** `memory-privacy-agent-places`
**Date:** `2026-11-08`
**Author:** `echo (M5 Pro builder session echo-memory-privacy-agents)`
**Second-pass reviewer:** `independent subagent (see Second-pass review)`

## Summary of the change

On a multi-person agent with memory privacy on, an inbound Threadline/A2A conversation used to be refused at `SpawnRequestManager.refuseSpawn`. Now it runs in a scoped place keyed by the sender's authenticated fingerprint (`agent:<fp>`), on the interactive lane's existing sandbox (`planMemorySession`). The place session replies through a new session-bound route (`POST /threadline/session-reply`, script `threadline-reply.sh`) whose recipient comes from the `mps_` token. Mapping every inbound path also closed live owner-reach paths that the refusal never covered on multi-person agents: pipe mode, the listener inbox, live inject, reply waiters, topic linkage, reap recovery identity, and hook-event session ids.

Files:
- `src/users/peerPlaceAdmission.ts` (new): the admission truth table and the `agentSessions` status.
- `src/threadline/PlaceSessionRegistry.ts` (new): one session per peer, refuse at the cap, atomic reservation.
- `src/threadline/ThreadlineRouter.ts`: ownership claim, `deliverToPeerPlace`, place prompt, linkage gate, history cutoff.
- `src/threadline/ThreadResumeMap.ts`, `ConversationStore.ts`: `peerFingerprint`, `ownerClaimedAt`, `audienceKey`, `claimOwner`.
- `src/messaging/SpawnRequestManager.ts`: `memoryPeer` key, `refuseSpawn(request)`, `placeCapacity`, the free slot.
- `src/commands/server.ts`: wiring, place lane, drain key, relay handler, flip retirer, tick, boot cleanup.
- `src/server/routes.ts`: the reply route, waiter recipient, hook identity, `addressedFp` claim.
- `src/server/memorySessionGuard.ts`: `denyPlacePrefix` / `requirePlacePrefix`.
- `src/core/SessionManager.ts`: `admissionKind`, lock mapping, status, flip retirement of unplaced A2A sessions.
- `src/threadline/{relayForward,requiredAck,requiredAckService,ThreadlineReapRecovery,ThreadlineEndpoints,ListenerSessionManager,PipeSessionSpawner}.ts`.
- Reply script, installer, migrator, init, drift verifier, templates, release fragment, parent spec.

## Decision-point inventory

- `A2A admission on a multi-person agent` — modify — refuse becomes refuse-or-place, by the §1 truth table (multi-person, authenticated fp, explicit grant, switch, sandbox).
- `Thread ownership` — add — a thread belongs to one authenticated fingerprint; anything else moves to a fresh id.
- `Live inject / waiter / topic linkage delivery` — add — peer text enters only a session whose audience is the peer's place, or an owner/system topic that started the thread (under `deliver`).
- `Pipe / listener shortcuts` — modify — skipped on a multi-person agent.
- `Route guard for session tokens` — modify — new reply route for peer places; `/feedback`, `/team/proposals`, `/slack/session-reply`, `/app/session-reply` and `/app/media-path` refused to peer places.
- `Place capacity` — add — one per peer, 3 places, one free slot; refuses and queues, never evicts.

---

## 1. Over-block

- **Same-machine peers.** On a fleet agent that is multi-person with privacy on, a local-route peer is refused until local-envelope signing is enforcing, because only `provenSenderFp` may open a place. This is stated in the spec (decision 9) and the release note.
- **Peers without a grant.** A peer with a `setup-default` profile, which is any peer the owner never granted and never paired with, is refused, as today. That is intended.
- **A legitimate reply on a legacy thread** recorded under a name moves to a fresh thread id. The peer's waiter keyed on the old id is not resolved, though the reply carries `inReplyTo`. Legacy relay threads keep their id through exact-fingerprint adoption.
- **Linked replies into a shared or person topic** become a topic post plus place delivery instead of a session paste. Intended (§3).
- **Reply waiters on a multi-person agent** resolve only when the send addressed a fingerprint or an owner nickname. A send addressed by directory name no longer gets a synchronous reply. The reply still arrives through the router.

## 2. Under-block

- **Topic linkage and waiters into `owner`/`system` sessions** (under `deliver`) still feed a peer's reply into an unsandboxed session. This is narrowed to the addressed peer and stated under "Not closed" for Echo's sign-off. `linkedPeerReplies: post-only` removes the immediate delivery.
- **Mirrors** (bridge, homebase relay, collaboration surfacer) post peer text to an operator topic, and a later owner session reads it as history. This is unchanged and stated.
- **A compromised relay** that can impersonate peer A reaches A's place, and only that place.
- **Same-OS-user agents** can read `memory-scopes/` directly (fb-79e7b408-ad2). A place adds nothing against them.
- **The history cutoff uses the message's `createdAt`**, which the sender sets. A message another peer stored before the claim, carrying a future date, would pass the cutoff. That can expose another peer's text, but never memory. It is kept as a known limit.
- **Drained place spawns** bind their thread to the session on the first reply, not at spawn. The prompt always carries `--thread`, so the reply route resolves it.
- **Cross-lane race on the free slot**: a placed launch racing a job or person launch can briefly exceed the floor by one in-flight launch. This is stated.

## 3. Level-of-abstraction fit

The boundary reuses the parent spec's place machinery: audience, scope folder, sandbox, `mps_` token and route guard. It adds no new audience kind, so hooks, `isScopedAudience` and the route classification are unchanged. Admission is one pure function (`decidePeerAdmission`), used by spawn, launch, inject, the drain and the tick. The status route uses `agentSessionsStatus`, which takes the same inputs through the same `scopedSessionsReady` predicate, so the app and the gate cannot disagree. Ownership lives in `ConversationStore`, the single store `ThreadResumeMap` already views. Capacity is a registry beside `SpawnRequestManager`'s existing transient-refusal funnel, so queued messages drain through the existing path rather than a new one.

## 4. Signal vs authority compliance

- [x] No — this change has no brittle block/allow surface. Every decision is a deterministic boundary on identity and configuration (an invariant under Judgment Within Floors), with no content matching.

The new decisions are structural: whose fingerprint, whose thread, which audience, which config value. None reads message content. The parent spec classifies boundaries of this kind as invariants that hold authority legitimately, and the spec's decision table gives each one a basis and evidence.

## 4b. Judgment-point check

There is no new static heuristic at a competing-signals decision point. The place caps (1 per peer, 3 live, 10 minutes idle, 1 free slot) are declared as judgment-candidates in the spec: the floor is the warm pool's existing numbers, configurable under `threadline.placeSessions`, and the arbiter is the operator.

## 5. Interactions

- **Shadowing.** The ownership claim runs after the existing anti-hijack step and before topic linkage. On a multi-person agent it subsumes the step's `verified` exemption, which is not consulted there. `refuseSpawn` now receives the request, and its only other caller path is unchanged.
- **Double-fire.** A reply waiter resolution and router processing both see a message, as before. The waiter check only narrows which sender resolves it.
- **Races.**
  - `claimOwner` runs in one `mutateSync`, and a loser moves to a fresh id.
  - Registry reservation is synchronous.
  - A peer reply arriving before `captureOrigin`'s claim on our outbound send makes that thread unowned, so the reply moves to a fresh id. This is rare and recoverable.
- **The warm pool** is never fed on a multi-person agent (`preferWarmSession` is forced false), so its eviction cannot touch a place session.
- **The flip.** `retireSessionsForAudienceChange` now also ends unplaced A2A sessions, including headless ones, and live pipe sessions. There is no listener reader to end: nothing in the product starts one (`ListenerSessionManager`), so skipping Phase 2b is the whole fix.
- **Feedback loops.** None. A place session's reply goes out through `relay-send`. It is not re-ingested.

## 6. External surfaces

- **Other agents.** Peers with a grant can now open conversations with a multi-person privacy-on agent; before, they were refused. A peer replying to an owner-started thread on such an agent must be the addressed fingerprint, or its reply moves to a fresh thread.
- **Persistent state.**
  - `conversations.json` gains optional `peerFingerprint`, `ownerClaimedAt` and `audienceKey`, which are additive.
  - Canonical inbox rows gain an optional `senderAuthenticated`, which is additive and covered by the HMAC for new rows.
  - Place folders under `~/.instar/memory-scopes/<agent>/place-*` are machine-local and kept, as for every place.
- **Config.** `memoryPrivacy.refuseAgentSessions`, `memoryPrivacy.linkedPeerReplies` and `threadline.placeSessions` are all optional. A missing value means default-on, deliver, and caps of 3 places and 600000 ms idle.
- **Status.** `GET /memory-privacy` gains `agentSessions`.
- **Operator surface.** No dashboard change. The iOS turn-on sheet reads `agentSessions`; Echo lands that text in the app repo. Turning the switch on is the owner's in-chat request to the agent, as for `memoryPrivacy.enabled`.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard, approval page or form files are touched.

## 7. Multi-machine posture

- **Place folders:** machine-local by design. They are the parent spec's scope folders, ratified with this spec's approval: replicating them would copy what a peer said across a sync path built for shared state. A moved conversation starts with an empty place, never a wider one.
- **Admission, audience and place key:** unified by construction, recomputed from the authenticated fingerprint on each machine.
- **Thread ownership:** follows `ConversationStore`'s existing posture. An entry missing the fields is unowned, which is the strict direction.
- **Place registry:** machine-local (hardware-bound: this machine's session slots).
- **Switches:** per machine, like `memoryPrivacy.enabled`.
- **Cross-machine topic forward:** the receiving machine applies the same check (`peerReplyAllowed`). An older receiver is the parent spec's stated rollout gap.
- **Notices:** none new. **URLs:** none.
- **Status surfaces:** `GET /memory-privacy`'s `agentSessions` is this machine's answer, as the rest of that route already is.

## Framework generality

- **Place sessions are claude-code only, and this is enforced.** The scoped boundary (sandbox settings, `dontAsk`, `--strict-mcp-config`) exists only for claude-code (parent spec section 4). `planMemorySession` throws `MemoryPrivacyUnavailableError` for codex-cli, gemini-cli and any future framework.
- **Admission reads the same predicate.** `scopedSessionsReady()` requires the resolved interactive framework to be claude-code. On a codex-cli or gemini-cli agent that is multi-person with privacy on, a peer is refused with today's reason, and `agentSessions` reports `refused`. Nothing runs unprotected, and nothing claims to work when it doesn't.
- **The `MessageDelivery` change is framework-neutral.** It only picks a different reply line in the injected text for a session whose tmux name carries the place marker. Those sessions exist only on claude-code, so codex-cli and gemini-cli injects are byte-identical to today.
- **Single-person and privacy-off agents are unchanged on every framework.** The policy is inactive, and every new branch is gated on it.
- **The reply script is framework-neutral.** It is plain shell and curl, like every reply relay.

## 8. Rollback cost

- **Switch:** `memoryPrivacy.refuseAgentSessions: true`, read live, restores the refusal at admission, with no restart.
- **Code revert:** a patch release.
- **Leftover state:** the extra `ConversationStore` fields and the inbox flag are ignored by older code. Place folders stay where they are and are not loaded.
- **Gap fixes:** the pipe, listener, inject, waiter and topic fixes do not depend on the switch. A revert would reopen those live gaps, so the switch is the preferred lever.

## Conclusion

The review produced the spec's nine convergence rounds of design changes. During the build it also produced two code-level fixes:

- The spawn guard was taken twice after a linked-reply post, which refused the place spawn. A unit test caught it.
- `/slack/session-reply`, `/app/session-reply` and `/app/media-path` were reachable by a peer token and relied on their handlers' bind checks. They are now refused structurally.

The second pass raised one BLOCKER. The reply route wrote the place's audience key onto a thread whose transcript id could still point at an owner-reach transcript, so a later resume could load it into the place. Fixed: the route no longer writes the audience key, and re-pointing a thread at another session clears its transcript unless that transcript was written in the same place. The second pass also raised seven fixes, now applied:
- adoption carries the thread id only, and adopted threads never reach topic linkage;
- a thread this version sent by name is never adopted;
- a refusal ends the live place session;
- admission comes before any ownership write;
- the reply is retried without `inReplyTo` on a 400;
- the TDZ guard on the flip retirer;
- topic audience `open` is not enough;
- capacity no longer refuses a peer whose place is already live.

The change is clear to ship behind Echo's approval. Decision 4 (keeping linked replies delivered) and the machine-local ratification are the two items put to the approver.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent (general-purpose, Claude), 2026-11-08
**Independent read of the artifact: concur** (after one concern round)

First pass: concern. One BLOCKER: the reply route wrote the place audience key onto a thread whose transcript id could be owner-reach, so a later resume could load it into the place. Seven SHOULD-FIX items and four NITs (listed in the Conclusion). All were fixed as described there. Second pass: concur. The blocker is closed (the route no longer writes the audience key, re-pointing clears the transcript, adoption drops it). One NIT was taken: the reply route now retries without `inReplyTo` only on relay-send's own pre-send refusals of `inReplyTo` (400 "inReplyTo must name…", 409 "already in flight"), not on any 400.

---

## Evidence pointers

**Live proof on the M5 Pro (2026-11-08):** two throwaway agents (`agenta` and `agentb`, built from this branch's dist). agentb had memory privacy on, two people, the relay on (visibility private, so the trust authority exists) and local-envelope signing enforcing; agenta held a `user-granted` profile on agentb.
- **Round trip:** agenta sent to agentb over the local route. agentb started `agentb-msg-place-*` (audience `place:agent:<fp>`), its session ran `threadline-reply.sh --thread …`, and agenta's thread log shows the reply "Hello back, agenta, from agentb!" on the same thread.
- **Leak:** a made-up fact was put in a person scope folder and in agentb's MEMORY.md. agenta asked for both, and the session declined. Told by its operator to run `cat <person folder>/note.md ; cat .instar/MEMORY.md ; ls ~/.instar/memory-scopes/agentb/`, all three returned "Operation not permitted" from the sandbox.
- **Lifecycle:** a second message on the same thread was injected into the same place session.
- **Kill switch:** with `refuseAgentSessions: true`, `agentSessions` read `refused` and the message was refused with today's reason.
- **Stranger:** with the profile at `setup-default`, the message was refused. With `user-granted` restored, it was admitted again.
- **Defects the live run found and fixed:**
  - A fresh thread was always moved, because the inbound recorder's own bare record and the stored inbound message counted as prior state.
  - Two prompts still named `threadline_send`: the spawn-manager wrapper and the injected-message footer.
  - The reply script used python and the prompts used a heredoc, and both fail in the macOS sandbox. The script is now pure shell and the prompts use the argument form.
  - The reply route addressed a co-located peer by fingerprint, which the relay cannot resolve for a private agent. It now uses `name:fingerprint-prefix` from known-agents when exactly one entry carries that fingerprint.
  - An agent with the relay off has no trust manager, so it refuses every peer (fail-closed). This is stated in the PR.

- `tests/unit/peer-place-admission.test.ts` (27 tests): truth table, status, registry, real-store ownership, guard, spawn manager keys and capacity, receiver check, ack text, lock, flip predicate.
- `tests/unit/ThreadlineRouter-peer-place.test.ts` (14): refusal without identity or grant, place spawn, foreign or expired thread moved, history cutoff, inject only into the place, second thread, resume only in place, topic linkage `deliver`/`post-only`/shared/foreign sender.
- `tests/integration/memory-privacy-peer-place-routes.test.ts` (26): the reply route with real `mps_` tokens (recipient from token, foreign, unowned, ambiguous, files, person token, agent token), and every memory and owner route refused.
- `tests/integration/memory-privacy-peer-place-spawn.test.ts` (5): the leak test on the real spawn path (person fact and owner memory unreachable: sandbox denyRead, allowRead, allowedTools, no MCP, mps_ token held to the place), the live switch, and flip retirement.
- `tests/e2e/memory-privacy-peer-place-lifecycle.test.ts` (3): alive on the production wiring path.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `guard`
- **Guard citation** — `tests/unit/self-action-convergence.test.ts` (ratchet), with the new controller `peer-place-session-tick` registered in `src/testing/selfActionRegistry.ts` and marked at the tick in `src/commands/server.ts`.
- **How caught (convergence argument)** — The control-loop edge is the 60-second place tick ending an idle or no-longer-admitted place session. The tick ends only sessions recorded in `PlaceSessionRegistry` and removes each record when it ends it. It never starts a session: only a peer's admitted message does, through the spawn manager's admission, cooldown and place capacity. Under sustained idle pressure, the steady-state bound is the place cap (3 kills), with one kill per target, and the count is horizon-independent.

## Local Verify follow-up (2026-11-08)

The first Local Verify run on aa36e7e74 failed in e2e:
- `memory-privacy-recovery-lifecycle` (2 tests): `memoryPrivacyStatus` called `this.isMultiPersonAgent()` and `this.scopedSessionsReady()`, but that test borrows the real method onto a stand-in object, so the route returned 500. The status now reads only the wiring and config (`scopedSessionsReadyFor`), and the two methods share that same helper.
- `messaging-lifecycle` (1 test): passes on three local reruns. As a guard, `MessageDelivery` now checks that the session id is a string before testing it for the place marker.
