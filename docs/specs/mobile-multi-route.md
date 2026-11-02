---
title: "The iPhone app reaches an agent by every route it has (Tailscale and Cloudflare), and Remote Desktop goes straight to the target"
slug: "mobile-multi-route"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-multi-route.eli16.md"
status: "draft"
review-convergence: "2026-11-01T07:24:41.581Z"
review-iterations: 6
review-completed-at: "2026-11-01T07:24:41.581Z"
review-report: "docs/specs/reports/mobile-multi-route-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: false
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched)"
---

## 1. Problem

Operator question, 2026-11-01 00:08 PDT (topic 134088): "can Remote Desktop work without cloudflare? In other words, can it support multiple connections for robustness such as Tailscale?"

Today a paired phone knows one address per agent, the Cloudflare tunnel hostname it paired with, and its device signature is bound to that exact hostname (docs/specs/mobile-device-keys.md §2.3: the signed canonical string includes the paired host, and the server verifies with the stored host). If Cloudflare is down, the phone cannot reach the agent at all, although the operator's iPhone is on the operator's Tailscale network and every machine is too. Remote Desktop also routes every frame and every tap phone → Cloudflare → the designated front (the Studio) → the target machine over the mesh, which the operator reports as laggy (2026-10-31 23:23).

## 2. Goals

1. **Several routes per agent.** The app knows every route to the machine it paired with (its Cloudflare hostname and its Tailscale HTTPS hostname) and uses the first that answers, preferring Tailscale when the phone's Tailscale is connected.
2. **One phone credential, all of its machine's own names.** A paired phone's signed request is accepted on any hostname that is provably the same machine, never on another machine's name.
3. **Remote Desktop straight to the target.** The video stream and input go phone ↔ target machine over Tailscale when both are on it, cutting out Cloudflare and the front's relay hop. Authorization still comes from the front (the operator's PIN unlock there), unchanged in strength.

## 3. What exists (checked against the code, 2026-11-01)

- **Device signatures** (src/core/MobileDeviceKeys.ts): the canonical string includes a host, and verification always rebuilds it with the device's stored paired host (`MobileDeviceKeys.ts:151`); the request's `Host` header is never consulted. Device records are machine-local; ±60 s window; replay guard keyed on the canonical string.
- **Pairing already proves a name serves this process**: `verifySoleServer` pings `MOBILE_PING_PATH` on the hostname with a nonce and checks `pingAnswer` (a hash of a per-process secret and the nonce), and checks the sibling registry so no other machine claims the name (`MobilePairing.ts:66`, `mobilePairingRoutes.ts:250-279`, `:252-260`). Unauthenticated `/health` does not carry a machine id.
- **Local TLS arrival**: `arrivedOverLocalTls` (src/core/desktopTransport.ts:64-69) recognises a TLS front on the same machine, including Windows `tailscale serve` forwarding into WSL. Desktop admission does not use it today: `admit()` accepts only a TLS socket, loopback, or a mesh relay (`DirectDesktopAccess.ts:439-445`), and the front's WebSocket check is similar (`WebSocketManager.ts:152-155`).
- **Tailscale**: the Studio's tailnet name is in `CertDomains`; `tailscale serve status --json` reports serve settings (`tailscale status --json` does not). Mama PC runs Tailscale on Windows and its agent in WSL. Existing exec and parse code: `DesktopPeerUrlGate.ts:15`, `tailscaleStatusParser.ts`.
- **Remote Desktop today** (native-remote-desktop-echo-mesh.md and the code):
  - the front redeems the operator assertion at `begin` and gets `{requestId, targetSessionToken}` (`DesktopMeshBroker.ts:70-79`, `AgentServer.ts:1601-1636`);
  - the phone reads `status` for the grant's `connectionNonce` and target key, then proves possession of its browser key in `ticket` (`DirectDesktopAccess.ts:404-431`), forwarded to the target's ticket case (`AgentServer.ts:1653-1656`);
  - a ticket currently works on either transport (`:455-461`);
  - the stream key is AES-GCM with strict per-direction sequence numbers (`DesktopAead.ts:32-44`), so a transport switch that keeps the key would break sequencing or reuse a nonce; interruption destroys the key (`DirectDesktopAccess.ts:630-655`); `resume` builds a fresh key from a new browser ECDH key and keeps the deadline, at most three times (`:325-390`), and `approveRow` rotates `connectionNonce`;
  - the front sends `operator-keepalive` every 5 s independent of the stream (`DesktopMeshBroker.ts:87,157-189`), delegated sessions die 20 s after the last keepalive (`DesktopDelegatedSessionStore.ts:30,38,58`), and the target checks grant validity before every frame and input (`DirectDesktopAccess.ts:141-148,514-537,577-578`), so a stream already dies within about 20 s of the front going away whatever its path; the front's 25 s restart quarantine (`DesktopMeshBroker.ts:47`) outlasts that;
  - the operator assertion version is matched exactly (`DesktopOperatorAssertion.ts:87`); the viewer's `connect-src` allows only its own host and is fixed at page load (`middleware.ts:809-815`); audit rows are written by the target (`DirectDesktopAccess.ts:475,622`); the relay's WebSocket handshake allows 5 s (`DesktopMeshStreamRelay.ts:31`) and the Windows companion call alone may take up to 5 s.

## 4. Design

### 4.1 This machine's own names

- **Candidates**, read only from local sources: the configured Cloudflare tunnel hostname, and the Tailscale HTTPS name from `tailscale status --json` (`Self.DNSName`, only if in `CertDomains`) when `tailscale serve status --json` shows HTTPS 443 serving this agent's port (under WSL both commands run through `tailscale.exe`). Nothing a request carries can add a candidate.
- **Proof.** A candidate becomes an own name only when the existing pairing ping, extended, proves it: the server calls `https://<name>/<MOBILE_PING_PATH>` with a fresh nonce and requires (a) the `pingAnswer` of this process, (b) the `Host` the server saw echoed back exactly (so the front in between passes `Host` through unchanged), (c) an arrival class `arrivedOverLocalTls` accepts, and (d) the sibling-registry check of `verifySoleServer` (no other machine claims the name). The ping answers whenever multi-route is on, not only when pairing is enabled. Nothing is sent to the name but the nonce; no credential travels.
- **Identity and health are separate.** A proven name is saved in the persistent own-names list with `firstVerifiedAt`. It stays listed through probe failures, because a failed probe may only mean the outside path is down; it leaves the list **at once** when its candidate source no longer names it (tunnel hostname changed, serve removed, Tailscale gone) or when a probe is answered by a different process (another machine now serves it). Health (`lastProbeOk`, `lastProbeAt`, last failure reason) is reported beside it.
- **Probe brakes**: one probe per name in flight, 3-second timeout, every 60 s while healthy; after a failure the interval doubles up to 15 minutes and resets on success; after 8 consecutive failures the probe for that name stops, reports one `MobileRoutes.probe` degradation, and resumes when that name's source changes, at the next server start, or once every 24 hours.
- **Upgrade seed**: on first boot with this feature, the configured tunnel hostname is seeded as an own name if an active device record carries it as its paired host, because pairing already proved it with the same ping; existing phones are therefore never refused after the upgrade.
- **`tailscale serve` setup is code**: an idempotent step, run at boot when multi-route is on, configures HTTPS 443 → the agent port (on Windows through `tailscale.exe` for a WSL agent) only when 443 has no serve config; an existing different config is reported in `/health`, never overwritten.
- Candidates that have never passed, with their last failure reason, are listed in the Bearer-authenticated `/health` under `mobileRoutes`, so a missing Tailscale route is visible to the agent and the dashboard. This is deliberately not shown to device principals, which keep the basic health of mobile-device-keys.md; the app sees its own route state from `GET /mobile/routes`.

### 4.2 Device signatures on any own name

With `mobilePairing.multiRoute.enabled` on, verification rebuilds the canonical string with the request's `Host` (lowercased, a default `:443` stripped) **only if that host is a listed own name that is still named by this machine's local configuration and the request itself arrived through this machine's own local TLS front** (`arrivedOverLocalTls`: this machine's `tailscale serve` or its own tunnel connector). That arrival is fresh proof, at the moment of the request, that the name routes to this machine, so acceptance never depends on the server reaching itself from outside: a failed outbound probe affects only the reported health, never acceptance. Any host that is not an own name, or a request that did not arrive through a local TLS front, is refused with `device-unauthorized`. With the flag off, verification ignores `Host` and uses the stored paired host exactly as today. A signature names the exact host it was sent to, so a captured request cannot be replayed to another name, and because acceptance needs the request to arrive through this machine's own front for a name still in its own configuration, a name that has moved to another machine stops being accepted here as soon as requests for it stop arriving here, with no window in which both machines accept it. The replay guard keys on the canonical string as before.

### 4.3 The app learns and tries routes

- `GET /mobile/routes` (device-signed, on the allowlist) returns `{ machineId, version, routes: [{ kind: "tailscale" | "cloudflare", origin, firstVerifiedAt, lastProbeOk, lastProbeAt }] }`: every listed own name in preference order, whatever its health. It is trusted as the phone trusts every other answer from that machine: over HTTPS on a route it reached. Route discovery therefore inherits the trust the app already places in that route's front (for Cloudflare, Cloudflare): a front that forged a snapshot could point the phone at another origin, and the phone would send it signed requests that a real agent machine would refuse (the host is not its own name) but that the attacker could read. The same front can already read every request on that route today, so this adds no new exposure; the paired host is never removed (below), so a forged snapshot cannot cut the phone off. `version` is saved in the same atomic write as the name set and moves only up: at each change it becomes the larger of (previous + 1) and the current time in milliseconds.
- The app keeps the latest snapshot per agent. It replaces the route set only from a snapshot with a higher `version` and the same `machineId`, and takes health from any snapshot at an equal or higher version. A route whose `/mobile/routes` answers with a different `machineId` is dropped at once.
- For each request the app tries Tailscale first when that origin answers within 1.5 s, then Cloudflare; a failed route is skipped for 60 s. A `401` on one route means "this route does not know me"; the app tries the others, always including the host it paired with, which it keeps permanently as the last-resort route even if a snapshot omits it, and shows "needs pairing again" only when every route answers `401`. So if multi-route is switched off (the server then accepts only the paired host), a phone that was on Tailscale gets one `401`, falls back to the paired host, and keeps working. A pairing belongs to the machine: if the Cloudflare hostname moves to another machine, the original machine still accepts the phone on its Tailscale name.

### 4.4 Remote Desktop straight to the target

Authorization is unchanged: the front alone admits operators and redeems the assertion with the target over the mesh, and the target alone owns the grant, keys, deadline and Stop. Only the stream's network path changes. Both the native app and the browser viewer can use it.

1. **Advertised support.** A target that can accept direct streams (multi-route on, a Tailscale own name, `remoteDesktop.directStream.enabled`) says so in `/desktop/availability`, with its Tailscale origin. The front only offers direct mode, and only sends the new assertion field, to targets that advertise it; older targets keep today's assertion and relay, so a rolling update never breaks starting a session.
2. **Bound origin.** For a direct-capable target the assertion carries one new field, the front origin the operator unlocked on, taken from the begin request's `Host` only if that host is one of the front's own names. The assertion version is bumped for those targets only (1). The target stores the bound origin on the request record, because `admit()` never sees the assertion.
3. **Direct ticket from the existing ticket step.** `POST /desktop/requests/:id/ticket` gains `transport: "direct" | "relayed"`, with the same browser-key possession proof over the grant's `connectionNonce` as today. The front forwards it to the target's ticket case. For `direct`, the target marks the ticket `direct` and the front returns it with the target's Tailscale origin and does not record it in its relay ticket table.
4. **Each ticket works on its own path only.** At `admit()`, a `direct` ticket is accepted only on a connection that did not come through the mesh relay, and a relay ticket only on one that did. A direct connection must also arrive by a local-TLS path (`arrivedOverLocalTls`, which accepts Windows `tailscale serve` into WSL) and carry exactly the bound origin as `Origin`. The front's WebSocket check uses `arrivedOverLocalTls` the same way.
5. **Switching path.** Two cases, both using existing operations so the AES-GCM sequencing is never broken:
   - Each grant carries a `switchGeneration`, starting at 0 and returned with every ticket. The phone always starts a switch by asking `ticket` again with the other `transport` and the `switchGeneration` it holds. **The target decides atomically**, under its per-grant lock: a request carrying an older `switchGeneration` is refused as stale and changes nothing (so of two replacement requests arriving out of order, the older one can never invalidate the newer ticket); otherwise if no stream was ever admitted on this grant it increments `switchGeneration`, invalidates the unused ticket and issues the new one (the stream key is untouched); if a stream was ever admitted, including one admitted a moment before the phone gave up waiting, it answers `409 resume-required` and issues nothing. A client timeout therefore never decides which case applies.
   - After `resume-required`, the switch goes through the existing `resume` operation with an added `transport` field: a fresh ECDH key and AEAD, the same deadline, counted against the three resumes. `connectionNonce`, which `approveRow` rotates, guards ordering: a request carrying an old nonce is refused as stale, so a delayed direct request can never undo a later fallback.
   - **Lost responses.** Every `ticket` and `resume` call carries an `attemptId`; the target keeps each attempt's result, bound to the authenticated request and the `connectionNonce` it was made with, for the grant's life. A retry with the same `attemptId` and the same original nonce gets the stored result even though the nonce has since rotated; a different request under an old nonce is refused as stale.
   - The target admits at most one stream per grant; admitting a new one closes the previous one first.
6. **Timing.** The app first checks the target's Tailscale origin answers at all (2 s); if it does, the direct WebSocket handshake gets the same 5 s as the relay. If either fails it asks to switch as in (5), and the target says whether that is a new ticket or a resume. Resume after an unexpected loss tries the path in use first, then the other.
7. **Liveness needs nothing new.** The front's existing `operator-keepalive` every 5 s, the 20 s delegated-session expiry and the target's validity check before every frame and input already end a direct stream within about 20 s of the front going away, exactly as for a relayed one. The front's existing 25 s restart quarantine is unchanged; it counts requests in flight, whatever their path.
8. **Browser viewer policy.** When the front serves `desktop.html` / `desktop.js`, its `connect-src` lists the verified Tailscale `wss://` origins of every pool machine that currently advertises direct support. A target not in the page's list is reached by relay for that page load.
9. **Audit.** The target's audit rows record `route: "direct" | "relayed"` and the transport kind, so lag reports can be split.
10. **Origin is a browser control.** It stops other web pages from opening the stream. For the native app the ticket, bound to the phone's browser key, is the control that matters.

### 4.5 What the operator sees and the agent knows

- The app's agent screen says which route is in use ("via Tailscale" / "via Cloudflare"), and Remote Desktop says "direct" or "relayed". If every route fails, the error says which were tried.
- `generateClaudeMd()` and a content-sniffed `migrateClaudeMd()` section tell the agent about `GET /mobile/routes`, the own-names health in `/health`, and the direct/relayed audit field, for answering "why is Remote Desktop slow?" and "why can't the app reach you?".

## Multi-machine posture

- Own names: machine-local by design, read from that machine's own Tailscale daemon and tunnel config and proven against that machine's process. machine-local-justification: physical-credential-locality (a TLS certificate and tunnel credential live on one machine).
- Device records: unchanged (machine-local, mobile-device-keys.md).
- Route snapshots: served per machine; the app keeps one per paired agent machine.
- Direct streams: grant state stays on the target, accounting on the front, as today.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Whether a host is one of this machine's own names | invariant | Candidates come only from local configuration; proof is the per-process ping with an echoed `Host`, a local-TLS arrival and the sibling-registry check. |
| Which route the app uses | invariant | Fixed order with a reachability check and a 60 s skip after failure; every route reaches the same authority. |
| Direct versus relayed Remote Desktop | invariant | Offered only to targets that advertise support; the target admits one stream per grant on the path its ticket names; authorization is identical on both. |

## Frontloaded Decisions

- Tailscale is preferred over Cloudflare when reachable.
- The front remains the only place a Remote Desktop session is authorized; direct mode changes only the stream's path.
- Path switching reuses `ticket` (before any stream) and `resume` (after one), never a new key-preserving operation.
- `tailscale serve` is configured by code, idempotently, and never overwrites an existing 443 config.

## Configuration, rollout and rollback

- `mobilePairing.multiRoute.enabled` and `remoteDesktop.directStream.enabled`: omitted means live on a development agent, off on the fleet; read at boot. Off: verification ignores `Host` as today, `/mobile/routes` lists only the paired host, and Remote Desktop always relays.
- Increments: (1) own names with proof, brakes and upgrade seed, multi-host verification, `GET /mobile/routes`, the `tailscale serve` step; (2) the app's route snapshot and fallback; (3) direct Remote Desktop: advertised support, bound origin, path-marked tickets, `arrivedOverLocalTls` at admission, the ticket/resume transport field, viewer `connect-src`, audit field; app and browser.
- Rollback: switch either flag off; nothing stored needs migration back. A phone on Tailscale when multi-route is switched off falls back to its paired host after one `401` (4.3).

## Tests

- Unit: a request on an own name that arrived through the local front is accepted while every outbound probe fails; a request for an own name that did not arrive through a local front is refused; two unused-ticket replacements arriving in reverse order leave the newer ticket valid; candidate reading (not in `CertDomains`; serve not on 443 for this port; WSL through `tailscale.exe`); proof requires the process answer, the echoed `Host`, a local-TLS arrival and no sibling claim; a name leaves at once when its source drops it or another process answers; probe backoff and breaker; upgrade seed; `Host` normalisation (`:443`); flag off ignores `Host`; snapshot version moves forward after a restart; the app replaces routes only from a higher version with the same machine id and never drops the paired host; the first proof of a name still uses the outbound ping (it decides listing, not per-request acceptance).
- Integration: a device-signed request on the Tailscale name and on the Cloudflare name both succeed against one device record; a request on a foreign host is refused; the same captured request is not accepted on a second name; `GET /mobile/routes`.
- Integration (desktop): a direct ticket from `ticket` with `transport: "direct"` admitted once on a non-relay local-TLS connection and refused through the relay, and a relay ticket refused on a direct connection; a WSL-forwarded arrival admitted; a wrong `Origin` refused; switching before admission keeps the key, switching after admission goes through `resume` with a fresh key and counts toward the limit; a stale `connectionNonce` refused; a switch requested just before and just after a late direct admission gets a new ticket and `resume-required` respectively; a `resume` retried after a lost response returns the stored result; a late direct acceptance closed when the relay stream is admitted; Stop during a switch revokes the grant; a direct stream ends within about 20 s of the front stopping its keepalive; an old target that does not advertise support gets the old assertion and relay; audit rows carry the route.
- E2E: with multi-route switched off and a phone holding a two-route snapshot, the phone falls back to its paired host after one `401`; a server booted with two own names accepts a device on both; a target accepts a direct stream for a valid front-redeemed grant; a moved hostname yields `401` there while the original machine still accepts the phone on its Tailscale name.
- Browser path: a headless browser loads the viewer from the front, its `connect-src` contains a direct-capable target's `wss://` origin, a direct stream opens, and a target added after page load uses the relay.
- **Live, through the real app before the operator:** an XCUITest run of the iOS app against a throwaway agent with two own names: pair, block the Cloudflare route, keep working "via Tailscale", open Remote Desktop to a test target and see "direct"; recorded as the live-test artifact before the operator tries it.

## Maturation plan

- **test-agent-live:** the integration, E2E and browser tests above on a real server boot, plus the XCUITest live run through the real app.
- **dev-agent-live:** the operator's phone reaches the Studio over Tailscale with Cloudflare blocked, and a Remote Desktop session to Mama PC reports "direct".
- **fleet:** follows the two flags, dark until the graduation criterion holds.
- **graduation criterion:** one week on the development agent with no device-auth refusal on an own name, and direct Remote Desktop in use with lower measured input-to-picture time than relayed.
- **dark-window:** if not graduated within 30 days of release, the reason and a new date are recorded on CMT-1192.

## Open questions

*(none)*
