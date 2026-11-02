# Side-Effects Review — remote-desktop peer calls try every rope

**Version / slug:** `desktop-peer-rope-fallback`
**Date:** `2026-11-02`
**Author:** `Echo`
**Tier:** 1 (declared). Size: 7 files, about 350 lines added (most of it the new helper and its tests). Effort: one build pass, no spec rounds.

## Summary of the change

The Remote Desktop guided setup (`GET /desktop/setup`) said "Can't reach Mama PC" while Mama PC answered over Tailscale. `resolvePeerUrls()` hands every fan-out site ONE rope per machine: the best one the ordinary credential guard admits. That guard refuses plain-http Tailscale, so for Mama PC it handed over the `lan` rope `172.22.96.135` — the WSL-internal NAT address, unreachable from other machines. The desktop calls (`desktopSetupPeerCall`, `desktopProbePeer` in `src/server/AgentServer.ts`, and `DesktopMeshBroker.post` for begin/control/locked/keepalive) dialled only that rope and gave up.

New `src/server/desktopPeerRopeFetch.ts`: the desktop calls now walk every rope the peer advertises in resolver order (`resolveMeshPeerCandidates`, wired into `resolvePeerUrls()` as a new optional `ropes` field; without it, the refused ropes are placed ahead of the selection), skip ones `desktopPeerUrlAllowed` refuses, and move to the next rope ONLY when the request provably never reached a server: a short TCP connect check failed before sending, or the fetch failed with a connect-class code (refused, no route, DNS, connect timeout). Any HTTP reply is returned as the answer; an ambiguous failure (abort after connect, reset) is rethrown. The connect check runs only when another admissible rope remains, so single-rope peers behave exactly as before. Budgets are unchanged (8 s setup, 3 s probe and broker) and cover the whole walk. The request is signed once. `poolPeerFetch` gains an optional `fetchImpl` so rope health is still recorded through it. The broker relays the stream to the rope that actually answered.

## Decision-point inventory

- Rope selection for remote-desktop peer calls — modify (from "first rope only" to "first rope that carries traffic").
- No block/allow decision added or changed. Admission is still `desktopPeerUrlAllowed`, unchanged.

## 1. Over-block

No new rejection. A peer that used to be reachable on its first rope is still reached on it.

## 2. Under-block

Not a gate. Remaining miss: a rope that accepts TCP but then hangs (a half-dead path) uses the whole budget and is not retried, by design, because the request may have reached the target. The WSL NAT address is still advertised as a `lan` rope; this change routes around it but does not stop it being advertised. That is filed as feedback (see Evidence) because telling WSL NAT mode from mirrored mode needs a separate, careful change in the endpoint advertiser.

## 3. Level-of-abstraction fit

The rope walk belongs with the desktop calls because only they use a wider admission rule (proven Tailscale plain-http) than the shared selection. Changing the shared selection would widen credential sending for every pool read, which the desktop gate deliberately does not do. The shared resolver gains only a read helper (`resolveMeshPeerCandidates`) that `resolveMeshPeerSelection` now also uses, with identical behaviour.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It chooses a transport path. Credential admission stays with `desktopPeerUrlAllowed`, applied per rope.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Did the request reach a server?" is an enumerable fact (connect-class error codes or a failed TCP connect), and the rule errs toward NOT retrying when unsure, because these are signed requests that may act on the target.

## 5. Interactions

- Rope health: failed connect checks are recorded as rope failures through the same `recordRopeResult`, so the shared resolver demotes a dead rope faster — the same signal pool reads already produce. Successful dials are recorded by `poolPeerFetch` as before.
- Replay protection: the request is signed once; a rope is only abandoned when the request never left, so the target never sees the same signed request twice from this path.
- Other `resolvePeerUrls()` consumers ignore the new optional `ropes` field.

## 6. External surfaces

Visible effect: setup and remote-desktop sessions now reach machines whose first rope is dead. One extra TCP handshake per desktop call when a peer has more than one admissible rope. No new endpoints, config, or messages.

## 6b. Operator-surface quality

The guided setup stops showing a false "Can't reach" for a machine that is reachable. No new operator surface.

## 7. Multi-machine posture

Inherently cross-machine: this is the front dialling a target. Machine-local by design (each front walks its own view of the peer's ropes); no state, no replication.

## 8. Rollback cost

Revert the commit. No state, migration, or config to repair.

## Conclusion

Narrow transport fix; no authority change. Safe to ship.

## Second-pass review (if required)

Not required: no block/allow, session lifecycle, gate, sentinel or watchdog surface. The broker change touches remote-desktop request routing only; grants and Stop stay with the target.

## Evidence pointers

- `tests/unit/desktop-peer-rope-fetch.test.ts` (13 tests): first rope dead → second used; connect-class failure → next rope; HTTP 409 on first rope → no retry; ambiguous timeout → no retry; all dead / none admissible → unreachable; gate-refused ropes skipped; single rope → no connect check; budget kept; real TCP check; broker relays to the answering rope.
- Existing suites passing: desktop-mesh-broker, desktop-peer-url-gate, resolve-mesh-peer-url, pool-rope-health-feedback, peer-presence-wiring, mesh-url-advertisement-wiring (unit); desktop-routes, desktop-setup-routes, resolve-mesh-peer-url (integration).
- WSL NAT `lan` advertisement filed via `POST /feedback`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
