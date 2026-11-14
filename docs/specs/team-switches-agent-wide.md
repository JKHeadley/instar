---
title: "Team settings turn on for the whole agent, with one line and one tap each"
slug: "team-switches-agent-wide"
author: "echo"
parent-principle: "Cross-Machine Coherence"
parent-spec: "docs/specs/team-roles-and-access.md"
eli16-overview: "team-switches-agent-wide.eli16.md"
status: "draft"
review-convergence: "2026-11-09T19:05:00.000Z"
review-iterations: 1
review-completed-at: "2026-11-09T19:05:00.000Z"
review-notes: "One independent reviewer subagent (general-purpose, Opus) read the spec and diff cold. It raised: machines with no address could vanish from the summary; restarting machines missing from requested; peer 500s mislabelled unreachable; gone machines not filtered from the fan-out; the owner device not passed to peers; the peer-route trust overstated. All six were fixed in code or spec before approval (TeamSwitches requested()/summary/PeerSwitchFailed, knownMachines gone filter, requestedBy, spec 2.3 rewording). Tier 2, one round, under the 80/20 convergence bar."
approved: true
approved-by: "Echo (agent), standing spec-approval grant, 2026-11-09, after one independent review"
lessons-engaged: "decentralized-by-default; every-warning-needs-a-path-to-act; user-setup-must-be-trivial; updates-never-restrict-existing-agents; Signal vs Authority; Know Your Principal"
---

## 1. Problem

Operator (Justin, 2026-11-09 18:10, topic 134088), about the app's People page: "This looks overwhelming and ridiculous. If there's something that needs approved or enabled here, it should be one single thing for the whole agent. We keep slipping through fundamental Instar violations like this that make things machine specific when they shouldn't be."

The page showed one row per machine: "Mac Mini has memory privacy turned off, so nobody new can be added", "Laptop has memory privacy turned off...", "Mama PC has app conversations turned off...", "Mac M5 Pro has app conversations turned off...", each with "Ask the agent about this" and "<machine> is gone: mark it gone", though every machine was alive.

Causes in the code:

- `TeamAccessPuller.belowFloor()` (src/core/TeamAccessSync.ts) reports each peer whose standing has `native` (config `mobilePairing.native.enabled`) or `privacy` (config `memoryPrivacy.enabled` plus a working sandbox) off. `GET /mobile/team/context` returns that list as `machinesBelowFloor`, and the app draws one row per entry.
- `POST /mobile/team/memory-privacy` (owner, Face ID) only sets `memoryPrivacy.enabled` on the machine that served the request and restarts it. team-roles-and-access §3.6 planned an owner-signed `privacy-required` log event that every machine would apply; it was never built, so peers stayed off with no way to turn them on from the phone.
- The refusal text for an invite said "Update them or mark them as gone first", which points the owner at retiring machines that are fine.

## 2. Design

### 2.1 One summary per setting

`GET /mobile/team/context` gains `teamSwitches`: a list with one entry per setting that is off on at least one machine:

```
{ setting: 'memory-privacy' | 'app-conversations' | 'build', on: false, offOn: [machineId...], action: 'turn-on-everywhere' | 'update', requested: [machineId...] }
```

- The machines counted are this machine (its own boot-time standing, read the same way it reports itself to peers) plus each peer's last reported standing (`TeamAccessPuller.standings()`, a new accessor over the existing per-peer standing map; machines the owner marked gone are left out).
- A machine on an older build (`enforcement < TEAM_ENFORCEMENT_VERSION`) is listed only under `build`, action `update`: what it says about the other settings cannot be trusted and it has no route to receive them.
- `requested` lists machines already asked and not yet seen on: those waiting to be retried, and those that answered they are restarting (kept for up to an hour, until their standing says on), so the app can say "turning on" instead of offering the tap again.
- A machine owed a request but with no standing heard yet (it has no address right now) is still listed in `offOn`, so it never vanishes from the line while it is off.
- `machinesBelowFloor` stays unchanged for older apps.

### 2.2 One tap for the whole agent

`POST /mobile/team/switches/turn-on`, body `{ setting }`. Same authorization as the other owner team actions: the permissions write gate with `teamControl` (owner phone, device signature, local TLS, presence key) plus a Face ID presence signature over the challenge. The action is `team-switch-on` and its target is the setting, so the signed line is `team-switch-on <setting>`: a signature for one setting cannot turn on the other. Only `memory-privacy` and `app-conversations` are accepted; anything else is `400 bad-setting` before a challenge is issued. The existing `POST /mobile/team/memory-privacy` now uses the same path, so an older app's button also reaches every machine.

The machine that takes the tap runs `TeamSwitchApplier.turnOn(setting)` (src/core/TeamSwitches.ts):

1. Each dialable peer (the team exchange's `resolvePeerUrls`) gets `POST /api/team-access/switch-on { setting, requestedBy }` (`requestedBy` names the owner device, for the peer's log), signed with this machine's identity key exactly like `/api/team-access/rows`, and verified by the peer's `machineAuthMiddleware`.
2. Every other machine in the agent's registry that has no address right now is listed `unreachable` and owed the request, unless it already reports the setting on. Machines the owner marked gone are left out.
3. This machine applies the setting last, so its own restart cannot cut the requests short.

The answer is `200 { ok: true, setting, restarting, machines: [{ machineId, self, outcome, result, restarting, willRetry }] }`. `outcome` (also given as `result`, the name the app reads) is one of `applied`, `already-on`, `unreachable`, `needs-update` (peer answered 404: older build), `refused` (peer answered 400), `failed` (this machine, or a peer answering 500, could not set it or could not request its restart; a failed peer is retried). Only this machine failing makes the answer a failure (`503 restart-unavailable`, with the same machine list); a quiet peer is not a failure because it is retried.

### 2.3 What a peer does

`POST /api/team-access/switch-on` (machine-to-machine auth) calls `applyTeamSwitchHere(setting)`:

- `memory-privacy`: sets `memoryPrivacy.enabled: true` in the live config if it is not already true.
- `app-conversations`: sets `mobilePairing.enabled: true` and `mobilePairing.native.enabled: true` where each does not already resolve on (the same `resolveDevAgentGate` reading the gates use).
- If the running process does not yet have the setting on, or the config changed, it writes the supervised-restart flag (`requestSupervisedRestart`, a planned restart the supervisor performs). If both were already on, it does nothing and answers `already-on`.

It never turns anything off and never touches another key. This is a deliberate trust in the agent's own paired machines, which already exchange and sign every team access row: the peer checks the sender is one of them, not that the owner asked (the owner's Face ID is checked on the machine that took the tap, and the owner device is named in the request and logged). For `memory-privacy` that trust costs nothing, since the change can only make a machine more private. For `app-conversations` it can turn on phone pairing on a machine where it was off, which opens the app's surface there (still only to phones the owner pairs) and restarts that machine; that is exactly what the owner's tap asks for, and a sibling machine could already restart a peer through other routes.

Limits stated plainly: `LiveConfig.set` logs rather than throws on a failed write, and the restart flag is honoured only where a supervisor runs, so a machine can answer `applied` and stay off. The People line reads each machine's own standing, so such a machine stays listed. On a machine with no memory-privacy wiring, "running" reads false and each tap restarts it.

### 2.4 Retry, honestly listed

Requests that ended `unreachable` or `needs-update` are kept in `state/team-access/switch-requests.json` (0600) and retried on the team exchange's minute tick with doubling waits (1 min up to 30 min). A request is dropped when the peer answers, when the peer's standing reports the setting on, or after 7 days. Through all of it the People line keeps showing the machine under `offOn` until its standing says on, so nothing is hidden by a pending request.

### 2.5 Gone means stopped answering

The invite and grant refusal (`409 machine-below-floor`) now carries `teamSwitches` and says "Turn it on for the whole agent from People first" (or "Update the agent first" for an older build). It no longer suggests marking a machine gone. Marking gone stays available, and only for machines in `waitingOn`, which is unchanged: the server never marks a machine gone.

## 3. Multi-machine posture

Replicated by direct fan-out: the setting is applied on every machine through the signed machine route, with durable retry. The summary is a merged read: this machine's standing plus each peer's standing from the team exchange. Single-machine agents see only their own machine and the fan-out has no peers.

## 4. Signal vs authority

No new gate. The new route performs an owner-authorized action under the existing owner gate; the summary is a read. The peer route accepts only machine-authenticated requests for two fixed settings in the safe direction.

## 5. Not in this change

- The iOS People screen rendering `teamSwitches` is on the app branch `echo/notice-buttons` (a24ffc6), which already calls this route.
- The `update` action for `build` uses the app's existing agent update flow; this server change adds no new update route.
- A machine whose sandbox is broken still reports privacy off after the setting is on; the line keeps listing it, because turning a config key on cannot fix a sandbox.

## 6. Tests

- Unit `tests/unit/team-switches.test.ts`: summary shape, older build under `build`, fan-out order (peers then self), per-peer results, unreachable peer kept on file and retried with backoff across a restart, undialable known machine listed, older build retried and refusal not, self failure reported, request dropped when the peer reports on or after the window.
- Integration `tests/integration/team-access-routes.test.ts`: context `teamSwitches` counts this machine and keeps `machinesBelowFloor`; owner Face ID turn-on and the legacy memory-privacy route both fan out; member, bearer, unsigned, unknown setting and a signature for a different setting all refused; self failure is 503 with machines; invite refusal names the whole-agent fix and not "gone".
- E2E `tests/e2e/team-switches-two-machines.test.ts`: two real AgentServers on the production boot path; the owner's tap on one turns memory privacy on in the other's config over the real signed machine route and asks for its restart; a third registered machine with no address is listed unreachable and kept for retry.
