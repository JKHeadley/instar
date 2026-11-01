# Side-Effects Review — the iPhone app's phone credential works on every own name of its machine (increment 1)

**Version / slug:** `mobile-multi-route-inc1`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (fresh context), see below`

## Summary of the change

Increment 1 of docs/specs/mobile-multi-route.md (approved, converged). Tier 2 (device authentication). New `src/core/MobileOwnNames.ts`: this machine's own names for the iPhone app. Candidates come only from local sources (the configured Cloudflare tunnel hostname; `tailscale status --json` Self.DNSName when it is in CertDomains AND `tailscale serve status --json` maps HTTPS 443 to this agent's port, through `tailscale.exe` under WSL). A candidate becomes an own name only when the extended pairing ping proves it (this process's answer, the Host echoed back exactly, arrival through this machine's own local TLS front, no sibling machine claiming it). Own names persist in `.instar/state/mobile-own-names.json` with `firstVerifiedAt` and a `version` that moves only up (max(prev+1, now ms), written atomically with the set). A name leaves at once when its local source drops it or a different process answers. Probes are braked (one in flight per name, 3 s timeout, 60 s healthy, doubling to 15 min, breaker after 8 failures with one `MobileRoutes.probe` degradation, resume on source change / next start / 24 h). On first boot the tunnel host is seeded when an active device was paired on it. A boot step configures `tailscale serve` HTTPS 443 → agent port only when 443 has no serve config, and reports a different config without overwriting it. Files: `src/core/MobileOwnNames.ts` (new), `src/core/MobileDeviceKeys.ts` (optional `host` in the signed parts), `src/server/mobilePairingRoutes.ts` (extended ping, multi-host verification, `GET /mobile/routes`, mint-time proof, gate helper), `src/server/AgentServer.ts` (wiring, test-safe exec), `src/server/routes.ts` (Bearer `/health` → `mobileRoutes`), `src/core/types.ts`, `src/core/devGatedFeatures.ts`, `src/core/PostUpdateMigrator.ts` + `src/scaffold/templates.ts` (agent awareness), tests in all three tiers. Effort: spec converged earlier (6 rounds); this build took one implementation pass; commit attempts recorded in the PR.

## Decision-point inventory

- `deviceAuthenticator` host binding (mobilePairingRoutes.ts) — modify — with `mobilePairing.multiRoute.enabled` on, the canonical string is rebuilt with the request Host only when it is a listed own name still named by local config AND the request arrived through `arrivedOverLocalTls`; otherwise 401 `device-unauthorized`. Flag off: unchanged (stored paired host).
- Own-name listing (MobileOwnNames.probe/applyCandidates) — add — invariant classification per the spec's Decision points table: local sources + per-process ping proof.
- Ping route gate — modify — answers when multi-route is on even if pairing is off; answer extended with `host` and `arrival`.
- `tailscale serve` boot step — add — configures only when 443 is empty; never overwrites.

---

## 1. Over-block

- With multi-route on, a phone whose paired host is no longer the configured tunnel hostname (operator changed `tunnel.hostname`) is refused on that old host; it is accepted on the machine's Tailscale name if that is an own name. This is the spec's intended rule (a pairing belongs to the machine, and a name moved away must stop being accepted here).
- A request that reaches this server not through a local TLS front (e.g. a peer machine relaying, or plain http on a LAN address) is refused for device auth with multi-route on. Today such a request with the paired host would verify. The app only ever calls through Cloudflare or Tailscale serve, both local fronts, so no app path is lost.
- Right after an upgrade with multi-route on, a phone paired on the tunnel host keeps working via the upgrade seed even if no probe ever passes (unit-tested). A phone paired AFTER the upgrade is accepted once the mint-time proof (`proveNow`) listed the tunnel name; if that proof fails (e.g. the Host is rewritten by an unusual front), the phone is refused until a later probe passes. Reported in `/health` `mobileRoutes.candidates[].lastFailure`.

## 2. Under-block

- `accepts()` for a Tailscale name checks the last candidate snapshot (refreshed every 60 s), not a fresh `tailscale` exec per request. If the operator removes the serve config, a Tailscale-name request can still be accepted for up to ~60 s. The tailnet no longer delivers it here, but `arrivedOverLocalTls` accepts any loopback peer, so a process on this machine could send plain http to 127.0.0.1 with that Host in that window. That is harmless: it still needs a valid device signature over that exact host, and the replay guard still applies. The Cloudflare name is checked against live config on every request.
- A failed or unreadable `tailscale` command is treated as "unknown", not as "no longer named": the previous Tailscale candidate is kept, so a slow CLI never removes a proven name (spec 4.2: acceptance never depends on outbound reachability). This holds at boot too: with no previous candidate yet, the persisted Tailscale own names stand in. Only positive evidence removes it: the tailscale binary missing, Tailscale not running, its name changed or not in CertDomains, or serve pointing at nothing or something else.
- Replay across names is impossible by signature (the host is in the signed string); replay within a name is caught by the existing ReplayGuard. No new gap identified.

## 3. Level-of-abstraction fit

The host decision lives in the existing device authenticator (the one place device signatures are verified), fed by a new own-names manager that owns candidate reading, proof, persistence and health. Proof reuses the existing pairing ping and sibling-registry check (refactored into `siblingClaiming` / `issueSelfNonce`, shared by `verifySoleServer`). Tailscale JSON parsing is local to the module because the existing `tailscaleStatusParser` deliberately scrubs DNS names, which this feature needs.

## 4. Signal vs authority compliance

- [x] No — this change has no brittle blocking authority. The device-auth decision is an invariant (a cryptographic signature over a host that must be a locally configured, process-proven own name reached through a local front), not a heuristic. Probe health is a signal only: it never decides acceptance, only what `/health` and `/mobile/routes` report.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The host-acceptance rule and listing rule are invariants named in the spec's `## Decision points touched` table; the probe brakes are fixed safety bounds on outbound traffic.

## 5. Interactions

- **Shadowing:** the multi-route host check runs after the allowlist check (403 `device-not-allowed` still wins) and before signature verification. Bearer auth is untouched (no device headers ⇒ `'none'`).
- **Double-fire:** the pairing mint's `verifySoleServer` and the own-names proof both ping; each uses a self-issued nonce that bypasses the public ping budget and is consumed once.
- **Races:** one probe per name in flight (`inFlight` flag); concurrent `refreshCandidates` calls share one promise. Name-set writes are atomic tmp+rename.
- **Feedback loops:** none. Probes do not change the configuration they read. The serve step writes `tailscale serve` only when 443 is empty, and its result is read back by the next candidate refresh; it does not re-run on a timer (boot only).
- **Existing tests:** the existing mobile pairing integration/e2e tests ran on a development agent and so would now run with multi-route on; they now set `mobilePairing.multiRoute.enabled: false` explicitly to keep covering the flag-off path. The new tests cover flag-on.

## 6. External surfaces

- **Tailscale on the operator's machines:** multi-route is on only while phone pairing (`mobilePairing.enabled`) is on at boot, and probing pauses while pairing is switched off. At boot with multi-route on, the server runs `tailscale status --json`, `tailscale serve status --json`, and (only when 443 has no serve config) `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (`localhost` under WSL). This exposes the agent's port on the operator's private tailnet over HTTPS, the same exposure the operator already chose for Mama PC. All routes keep their existing auth. A different 443 config is never overwritten; it is reported in `/health` `mobileRoutes.tailscaleServe`. Under a test run (`VITEST`), the real CLI is never used and the probe loop is not started unless a test injects its own exec/fetch.
- **Outbound probes:** every 60 s per own name to `https://<name>/mobile/pairing-codes/ping`, nonce only, no credential.
- **Public ping answer:** with multi-route on, it also includes `host` (the Host the client itself sent) and `arrival` (`local-tls`/`other`). Neither is a secret. With multi-route off it is exactly `{ h }` as before (integration-tested).
- **Persistent state:** new `.instar/state/mobile-own-names.json` (machine-local).
- **New device route:** `GET /mobile/routes` (device-signed, active). Bearer gets 403.
- **Operator surface:** no operator action is added; the agent sets up serve itself and reports state in `/health`.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN (physical-credential-locality): own names are read from this machine's own Tailscale daemon and tunnel config and proven against this machine's process; a TLS certificate and tunnel credential live on one machine. The sibling-registry check prevents two machines both listing a name. No user-facing notices are emitted (one degradation report per paused name). No durable state strands on topic transfer. `GET /mobile/routes` returns this machine's routes with its `machineId`; the app keeps one snapshot per machine (increment 2).

## 8. Rollback cost

Set `mobilePairing.multiRoute.enabled: false` and restart: verification returns to the stored paired host exactly, `/mobile/routes` lists only the paired host, no probes run. The own-names file is left inert. The `tailscale serve` config the boot step may have added stays (harmless; `tailscale serve reset` removes it). Code rollback is a plain revert.

---

## Conclusion

The change implements increment 1 as specified. The second-pass review raised four points, all fixed (see below). Design choices made during the build: the mint path proves the tunnel name immediately (so a phone paired after the upgrade is accepted at once, not after the first probe tick); the Tailscale CLI and the probe loop are inert under a test run unless injected, so no test touches the real machine's `tailscale serve`. Clear to ship behind the development-agent gate; the second-pass reviewer concurred after two fix rounds.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, fresh context (read the diff, the spec and this artifact; ran the unit file).

**Round 1: concern raised.**
- A failed `tailscale` command removed a proven Tailscale name, making acceptance depend on outbound reachability. **Fixed:** command errors and unreadable answers are "unknown" and keep the previous candidate; only positive evidence removes a name. Unit test added.
- The serve step and probes could run with phone pairing off. **Fixed:** `isMobileMultiRouteEnabled` requires `isMobilePairingEnabled` at boot; ticks and the boot step pause while pairing is off. Unit tests added.
- The public ping answer changed with multi-route off. **Fixed:** `host`/`arrival` are added only when multi-route is on; integration test asserts the flag-off answer is exactly `{ h }`.
- §2's "nothing delivers it here" overstated the window. **Fixed:** §2 now states the loopback path and why it is harmless.

**Round 2: concern raised.**
- After a restart the carry-over had no previous candidate, so an unknown FIRST Tailscale read at boot would delete the persisted Tailscale name. **Fixed:** with no previous candidate, the persisted Tailscale own names stand in on an unknown read. Unit test added (fresh instance over a saved file, first exec throws, name still accepted).
- Optional: a missing `tailscale` binary (ENOENT) counted as unknown. **Fixed:** ENOENT is positive absence (`tailscale-not-installed`, spec §4.1 "Tailscale gone"); same unit test covers it.

**Round 3: Concur with the review.** After a restart an unknown first Tailscale read carries the saved Tailscale names (same source key, so probe state lines up), and a missing binary counts as positive absence. Unit file 29/29.

---

## Evidence pointers

- `tests/unit/mobile-own-names.test.ts` — candidate reading, proof requirements, immediate removal, brakes/breaker, upgrade seed, host normalisation, flag-off host handling, version after a lost counter, acceptance while probes fail, refusal when not arriving through a local front, serve step.
- `tests/integration/mobile-multi-route.test.ts` — one device on both names, foreign host refused, captured request refused on a second name, `GET /mobile/routes` through production auth.
- `tests/e2e/mobile-multi-route-alive.test.ts` — AgentServer with two own names accepts one device on both; Bearer `/health` carries `mobileRoutes`; fleet off.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The probe loop is not a self-action controller in the `unbounded-self-action` sense (it issues read-only pings, no restart/swap/spawn/kill/notify); its frequency is bounded by the fixed brakes above.

---

## Follow-up: silent-fallback ratchet

Local verify flagged one catch over the `tests/unit/no-silent-fallbacks.test.ts` baseline (494). The two catches in `MobileOwnNames.start()` (the boot step and the interval tick) already report through the injected DegradationReporter (`deps.reportDegradation`, wired to `DegradationReporter` in AgentServer), but the heuristic only recognises the literal `DegradationReporter`. Both now carry `@silent-fallback-ok` naming that reporting path. Behaviour is unchanged; the baseline is unchanged (494).
