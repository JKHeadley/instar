# Side-Effects Review — Dashboard New Session: choose the machine

**Version / slug:** `dashboard-new-session-machine-choice`
**Date:** `2026-10-19`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (multi-machine ownership + mesh delivery paths touched)`

## Summary of the change

The dashboard New Session box gains a Machine select (Automatic by default). `POST /sessions/create` accepts an optional `machine` (nickname or id). Picking THIS machine runs the existing create saga and also pins the topic here. Picking ANOTHER machine:
- probes that machine over the signed mesh (one read-class `session-status`, the plane the start rides) and runs a door/model pre-flight on it (`POST /topic-profile/validate-choice`);
- creates the Telegram topic;
- places ownership on the target and sends ONE checked signed `deliverMessage` carrying the door/model (`startTopicOnMachine`, built next to the router in `server.ts`; a THROWN attempt is retried with the same messageId, at most twice, the router's own discipline);
- settles ownership by the delivery outcome (a tri-state, from one acknowledgement table): accepted → claim, pin; unknown → claim, pin, KEEP (the target may be running it); rejected → claim then release, NO pin (a refusing target is never pinned, so the topic is free for ordinary placement);
- posts one fixed line into the topic after an accepted or unknown start ("This topic is assigned to <nickname> …"), never after a refusal.

On the target, a new first branch in the owner-side `deliverMessage` `onAccepted` runs `createDashboardCreateStartRunner`: seed the profile (re-validated), then spawn silently under the spawning guard. Messages that arrive mid-start wait for that start instead of spawning a second session.

Also added:
- `GET /topic-profile/options?machine=` proxies a peer's door list;
- `GET /pool` gains `selfMachineId`;
- the heartbeat advertises `seamlessnessFlags.dashboardCreateReceive`;
- one CLAUDE.md template line plus its migration.

Files touched: `src/core/dashboardMachineChoice.ts` (new), `src/server/routes.ts`, `src/commands/server.ts`, `src/core/types.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, `dashboard/index.html`, the tests, and the spec.

## Decision-point inventory

- `/sessions/create` machine resolution — **add** — auto / self / remote / refusal, an invariant name lookup (spec §Decision points).
- Remote-target refusals (offline, clock-removed, not-updated, unknown, pool dark, pin replication dark, start seam not yet bound, no answer to the signed mesh probe, peer refuses this machine's token on the pre-flight) — **add** — deterministic refusals before anything is created.
- Start-outcome settlement (accepted / rejected / unknown, plus superseded when the claim lost to another placement generation) — **add** — an invariant mapping of a transport reply onto the ownership FSM, fenced by the placement epoch (a late rejection can never release a newer placement, even onto the same machine).
- Owner-side `onAccepted` dashboard-create branch — **add** — fires only for an object payload under a matching `dashboard-create:<topic>:` messageId.
- Forwarded-message spawn while a dashboard start is in flight — **modify** — waits (bounded, at most 32 waiting on the machine) instead of spawning a second session; falls through to the ordinary spawn when the start ended without binding; past the cap it takes the inbound error path at once.

---

## 1. Over-block

A machine that is genuinely reachable but whose heartbeat has not yet advertised `dashboardCreateReceive` (just upgraded, before its next beat) is refused with `machine-needs-update` for up to one heartbeat interval. The operator can retry or use Automatic.

A machine whose `clockSkewStatus` is `suspect-clock-removed` is refused; a `divergence-detected-once` machine is still pickable. This is the same threshold placement uses (pool spec L2).

A peer holding a different API token answers the pre-flight 401/403 and is refused by name (`peer-auth`). That is the honest answer on a pool whose machines do not share a token: every pool-scope view already fails to that peer the same way, and a start on an unchecked door is the failure this feature exists to prevent.

---

## 2. Under-block

- A target that goes dark after the start was accepted is handled by the existing owner-dark and stale-owner machinery, not by this feature.
- A real message that reaches the holder in the milliseconds between `place(target)` and `claim(target)` takes the router's existing `placing` branch. Every remote first-message placement has the same window.
- An unknown outcome where the target never received the start leaves ownership active on the target with no session. The next real message is forwarded and spawns there, but on the target's default door: the start command, and the profile it carried, was never received.
- The response says so ("may or may not have started"), and the topic line says "assigned … Requested:". It does not claim the profile was applied.
- A target that crashes after accepting the start but before the seed: ownership and pin rest on the target, no profile was written, the next message starts on the target's default door. Reported by the durable inbound queue when that queue is live on the target; otherwise unreported. Named in the spec as the known gap and tracked as evolution action ACT-127 (due 2026-11-02): replay the start after a receiver crash, or retire the note with evidence.
- A refused start leaves the topic unpinned and released; the operator's machine choice is not retained. The 502 says so and names the re-pick. The alternative (pin anyway) strands the topic on a machine that may refuse every later forwarded message the same way.

---

## 3. Level-of-abstraction fit

- **Ownership:** the remote start uses the ownership registry, nonce stream and journal emit beside the router, the same primitives as `casClaimOwnership` / `confirmClaim`. It does NOT go through `SessionRouter.route()`. The router's inbound queue stringifies payloads, and `spawnOnMachine` discards the delivery reply. Both would make a failed start look like success, or replay the command as typed text.
- **Transport and pins:** the transport is the existing signed `deliverMessage` verb, and the pin write is the existing ONE-HLC funnel.
- **Validation and spawn:** door validation reuses the parent's `validateDashboardProfileChoice` on the target. The spawn reuses the parent's `createSpawnForTopic`.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over agent messages or content.

The refusals are deterministic validation of an explicit operator request (a name lookup, a capability flag, an online flag). There is no brittle detector holding authority over judgement.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The operator's explicit pick is the decision. The settlement maps a transport reply onto the FSM, and the conservative arm (unknown → keep ownership) is the one that cannot strand a live session.

---

## 5. Interactions

- **Ownership FSM:** the remote path never holds `placing@self`. A refusal settles to `released` with no pin; an unknown outcome keeps `active@target`; a claim lost to ANOTHER owner (a lease move or reconciler during the deliver round trip) is reported as superseded with no pin and nothing released — the newer placement stands and no `active@target` is asserted over a higher epoch. The pin is written by a callback the seam calls after the claim, so an accepted or unknown start never leaves the topic owned-but-unpinned.
- **Owner-side `onAccepted`:** the new branch runs before the working-set and profile-carrier pulls, and returns. A brand-new topic has nothing to pull.
- **Forwarded spawn path:** it now consults `_dashboardStartsInFlight` plus the spawning guard before spawning. Previously, a forwarded message for a topic already being spawned locally could start a duplicate.
- **Profile transfer carrier:** not used for the remote create. The profile travels in the start command, so it has no journal-replication race.
- **Origin egress:** the creator posts the line with the existing deterministic producer `topic-profile-creation-seed`. The target's corrections use the same producer, and if held, surface through the existing held-send record.

---

## 6. External surfaces

**API:**
- `POST /sessions/create` gains `machine` and new codes: `machine-invalid`, `machine-needs-telegram`, `machine-choice-unavailable` (reasons `pool-dark`, `pin-replication-dark`, `start-not-wired`), `unknown-machine`, `machine-offline`, `machine-clock-suspect`, `machine-needs-update`, `machine-unreachable` (reasons `mesh`, `peer-auth`, or the HTTP error), `start-remote-failed`, 202 `started: 'unknown'`, 202 `ownership: 'not-confirmed'`, and 202 `ownership: 'superseded'`.
- New `POST /topic-profile/validate-choice`.
- `GET /topic-profile/options?machine=`.
- `GET /pool` gains `selfMachineId`.

**Other surfaces:**
- **Heartbeat:** gains `seamlessnessFlags.dashboardCreateReceive`.
- **Dashboard:** the Machine select; the create response is read by `ownership` first (superseded / not-confirmed ⇒ a warning with the server's sentence), then `started`.
- **Telegram:** one line per remote create, plus correction lines on failure.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The Machine select sits in the New Session box beside Door and Model, defaulting to Automatic. Nothing is collapsed.
2. **Zero raw internals as primary content?** Yes. Options are machine nicknames with plain suffixes ("(this machine)", "(offline)", "(clock out of step)", "(at usage limit)"). A machineId appears only when a machine has no nickname.
3. **Destructive actions de-emphasized?** No destructive action is added.
4. **Plain language + phone width?** The select reuses the modal's existing `modal-field` layout and select styling, which already render at phone width. Errors are the server's plain sentences, shown verbatim with `textContent`.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated**:
- **Pin:** ONE-HLC funnel, with pin replication required for any machine pick; written on accepted/unknown starts and on a self pick, never on a refused start.
- **Ownership:** coherence-journal placement entries.
- **Profile:** carried in the start command and written by the owner; afterwards it follows the topic via TOPIC-PROFILE-SPEC §5.3.

**proxied-on-read**:
- **Machine list:** `GET /pool`.
- **Remote door list:** `GET /topic-profile/options?machine=`.

**Notices:** one voice at each point. The creator posts the "assigned to" line (the Ownership-Gated Side Effects signal the gate raises; justified in the spec: it describes the placement the router made, and the target's own deterministic sends can sit held by origin egress); the owner posts corrections (door refused, model dropped, spawn failed, session started but unbound).

**Durable state:** none new. **URLs:** none generated.

---

## 8. Rollback cost

**Code:** revert and ship a patch. The dashboard sends nothing on Automatic, and peers ignore the extra heartbeat flag.

**State left behind:**
- Pins written by this feature are ordinary pins (`POST /pool/unpin`).
- The CLAUDE.md line stays on migrated agents and is harmless; a revert leaves one stale capability line until a cleanup migration.

**User visibility:** a reverted dashboard simply loses the select.

---

## Conclusion

The spec ran through nine review rounds (internal reviewers, a Codex cross-family pass, a clean-door Claude pass, and the Standards-Conformance Gate each round). Those rounds changed the design materially:
- the session starts immediately on the target (it no longer waits for the first message);
- the door/model is validated and carried by the target;
- a checked delivery replaced the router's fire-and-forget path, with ONE acknowledgement table (408 and 5xx are unknown, other 4xx rejected);
- an unknown delivery outcome now keeps ownership instead of releasing it;
- the pin is written after the claim through a callback, and NOT after a refusal;
- the placement line moved after the hand-over and says "assigned", not "runs on";
- the owner marks the durable receipt injected only after the start ran;
- a guard covers seed plus spawn, and a forwarded message waits (capped) for an in-flight start;
- a claim lost to another owner is reported as superseded, never asserted over;
- the pre-flight's Bearer plane is stated honestly, with a named refusal when a peer holds a different token, and a signed mesh probe covers the plane the start rides;
- settlement is fenced by the placement epoch, so a late rejection never releases a newer placement.

Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (round-6/7 spec+code review)
**Independent read of the artifact: concur** — see the convergence report's final rounds; every DESIGN-class finding was resolved in code and spec before this artifact.

---

## Evidence pointers

- `tests/unit/dashboardMachineChoice.test.ts` (resolver, start sequence tri-state, payload parser, label, reply classifier).
- `tests/unit/dashboard-machine-choice-server-wiring.test.ts` (composition-root wiring).
- `tests/integration/dashboard-machine-choice-routes.test.ts` (two real route stacks over HTTP: target pre-flight, refusals, self/auto, unknown/refused starts, helper routes).
- `tests/e2e/dashboard-machine-choice-lifecycle.test.ts` (two real AgentServers: Studio-created topic runs on the Laptop with the Laptop-validated door, read from the Laptop's `GET /sessions`).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. It adds no self-triggered controller. The owner-side start fires once per operator create, and the bounded wait is a single 60-step loop per forwarded message.

## Follow-up after rebase onto main (2026-10-20)

- Four catch blocks this change adds (the mesh probe in `src/commands/server.ts`, the probe and the pin write in `src/server/routes.ts`, the pin call in `src/core/dashboardMachineChoice.ts`) gain `@silent-fallback-ok`. None was silent: each turns into a 502 `machine-unreachable` reply or the `machine-pin-not-written` notice. Behaviour unchanged.
- `DELETE /threadline/pairing/restart-notices/:id` reached main with no write-domain classification, so the write-domain ratchet failed on main itself. It is classified `cluster-shared`, the same as its sibling invite routes. This only changes how the write-admission layer (dry-run on dev, dark on the fleet) labels the route.
- Evidence: full local suite before the fix, 52,165 passed and only these two ratchets failed; both pass after it.
