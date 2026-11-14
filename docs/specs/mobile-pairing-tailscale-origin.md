---
title: "Phone pairing works over the agent's own Tailscale name, and pairing links last 30 minutes"
slug: "mobile-pairing-tailscale-origin"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-pairing-tailscale-origin.eli16.md"
status: "draft"
review-convergence: "2026-11-03T04:27:10.876Z"
review-iterations: 3
review-completed-at: "2026-11-03T04:27:10.876Z"
review-report: "docs/specs/reports/mobile-pairing-tailscale-origin-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched)"
---

## 1. Problem

On 2026-11-02 the operator paired the Instar iPhone app with the first Linux cloud agent (Cirrus, Hetzner, Ubuntu 24.04, topic 136110). Two server-side facts made it painful:

1. **A Tailscale-only agent cannot pair.** Cirrus had a verified Tailscale own name (`instar-vm-test.tail064b16.ts.net`, listed in `/health` → `mobileRoutes.ownNames`). The phone was on the same tailnet. `POST /mobile/pairing-codes` still answered `409 stable-address-required` ("a named tunnel with a hostname, currently running on this machine"), and `POST /mobile/redeem` likewise requires `namedTunnelActive()`. The only way through was creating a Cloudflare named tunnel and DNS record for a test machine.
2. **The links expired before the operator got to them.** The pairing link lasts 10 minutes (`codeTtlMs` default) and the waiting device 15 minutes (`PENDING_TTL_MS`). The operator opened the first link at 18:02 for a 17:49 mint and got "That link has expired". Then he lost the second pending device at 18:18 while finding the dashboard code, and needed a third link.

Operator decision (18:16 PST, topic 136110): pairing keeps one safety step, but "it just can't be this crazy circular process". This spec is the server half. The app half (screens, wording driven by the existing `approval` field) is owned by topic 134088 (shared ledger `.instar/vm-test/app-coordination.md`).

## 2. What exists (checked against the code at 3c675c4fb; line numbers are from that commit)

- `stableOrigin(tunnel)` (`src/core/MobilePairing.ts:56`) returns `https://<hostname>` only for `tunnel.type === 'named'`.
- `MobilePairingService.namedTunnelActive()` (`src/server/mobilePairingRoutes.ts:362`) requires the tunnel lifecycle `activeProvider === 'cloudflare-named'`.
- Mint (`:543-567`): refuses unless `origin && namedTunnelActive()`, then `verifySoleServer(origin)` (sibling-registry check + 8 sequential nonce pings, 4 s each, answered with this process's `pingAnswer`), then `ownNames.proveNow(host)`, then mints with `codeTtlMs(...)`.
- Redeem (`:460-468`): requires `arrivedOverLocalTls`, `Host === new URL(origin).host`, and `namedTunnelActive()`. It answers `approval: 'dashboard' | 'telegram'` (`:510`, `:535`). That field already tells the app where the code is; no new field is needed.
- `MobileOwnNames` (mobile-multi-route.md §4.1) keeps a persistent list of names PROVEN to serve this process, kinds `cloudflare` and `tailscale`. Each name carries health (`lastProbeOk`, `lastProbeAt`) and is dropped at once when its local source stops naming it. `accepts(host)` gates device-signed requests on any own name that arrived over local TLS.
- `codeTtlMs` defaults to 10 minutes, clamped to 1–60 (`mobilePairing.codeTtlMinutes`). `PENDING_TTL_MS = 15 * 60_000` (`src/core/MobileDeviceKeys.ts:176`), not configurable. The confirmation code's lifetime follows the pending device's `expiresAt` (`confirm.issue(device.id, device.expiresAt)`).
- The mint route refuses a named tunnel configured without a hostname (`409 stable-address-required`) before any other check.
- The serving lease: on the Telegram approval path, redeem needs `holdsLease()` and so does confirm. Mint does not check it.
- The default install runs a Cloudflare quick tunnel as its normal route (`tunnel: { enabled: true, type: 'quick' }` from init, backfilled at boot); the lifecycle then sits in `active` with `activeProvider: 'cloudflare-quick'` indefinitely. A third-party relay (localtunnel today) is carried in the lifecycle states `relay-active` and, while switching back, `self-healing`.
- Multi-route (`svc.ownNames`) is on only where `mobilePairing.multiRoute.enabled` resolves on (dev-agent gate; read at boot).
- Own-name acceptance deliberately ignores probe health: `MobileOwnNames.accepts(host)` is "listed, and still named by local configuration"; `lastProbeOk` is an in-memory health signal, `null` after a restart until the first probe.
- Pairing codes and pending devices are in memory / expired at start: a server restart drops every live code and expires every pending device.

## 3. Design

### 3.1 Mint chooses one origin and binds the code to it

`MobilePairingService.pairingOrigin(): { origin: string; host: string; kind: 'cloudflare' | 'tailscale' } | null`, from local configuration and the own-names list only (nothing a request carries can choose it):

1. **Cloudflare, when running.** If `stableOrigin(tunnel)` is set AND `namedTunnelActive()`: that origin, kind `cloudflare` (today's behavior, unchanged and preferred).
2. **Otherwise a Tailscale own name.** If multi-route is on (`svc.ownNames` exists): a name of kind `tailscale` for which `ownNames.accepts(host)` is true (listed, and still named by this machine's own `tailscale status` + `tailscale serve`). Probe health is a preference, not a gate: among several, prefer `lastProbeOk === true`, then the most recent `lastProbeAt`, then the earliest `firstVerifiedAt` (normally there is exactly one). A `null` or `false` last probe does not disqualify the name; the mint-time self-check below decides.
3. **Otherwise null.** Mint answers `409 stable-address-required` with the detail "The phone app needs a permanent address on this machine: a running Cloudflare named tunnel, or this machine's Tailscale HTTPS name served by `tailscale serve`." The existing "named tunnel has no configured hostname" refusal is kept as the detail of this 409 only; it no longer runs before step 2, so a hostname-less named tunnel does not block the Tailscale fallback.

Mint then, in order:

- **Approval reachable here.** If `approvalPath()` is null, or is `telegram` while this machine does not hold the serving lease, mint answers `409 approval-unavailable` ("this machine cannot send the confirmation code; ask from the machine serving Telegram"). Before this change only the named-tunnel machine could mint, so a standby never minted; with a Tailscale fallback any machine could, and a standby's link would only fail at redeem after the operator had opened it.
- **Relay check (Tailscale only).** If kind is `tailscale` and the tunnel lifecycle's `lastState` is `relay-active` or `self-healing` (a consent-gated third-party relay is, or may still be, carrying traffic), mint answers `409 address-unverified` ("a backup relay is carrying this agent's traffic; pairing over Tailscale waits until it ends"). No tunnel manager, an `idle`/`exhausted`/`awaiting-consent` lifecycle, or an active Cloudflare quick or named tunnel counts as no relay. (Accepted gap: during the few seconds `grantConsent()` probes a just-started relay, the state still reads `awaiting-consent`.) See §4.
- **Self-check, unchanged.** `verifySoleServer(origin)` (sibling registry + 8 nonce pings that only this process can answer) and `ownNames.proveNow(host)`, the mint budget and rate limits. Each answer is verified deterministically; detecting a second server behind the same name is best-effort, as mobile-pairing-link §2.2 states (a redeem that lands on another process just fails as expired). A Cloudflare origin that fails its self-check is refused as today (`not-the-tunnel-machine` / `address-unverified`); mint does NOT fall back to Tailscale then, because a hostname another machine also answers is a fault the operator should hear about.
- **Mint.** The code entry stores the chosen `{ host, kind }` beside its existing fields. The link format is unchanged (`o=` carries the chosen origin). The response adds `originKind: 'cloudflare' | 'tailscale'` so the agent can tell the operator, in plain words, that a Tailscale link only opens on a phone with Tailscale on and signed in to the same tailnet.

### 3.2 Redeem honors the host the link was minted for

Redeem no longer recomputes the preferred origin. In order:

1. **Before taking the code** (so a stray request cannot burn a real link), in this order: the existing approval-path/serving-lease check (unchanged, still before the take); the request arrived over local TLS; and its normalized `Host` is currently eligible: either the configured named-tunnel host while `namedTunnelActive()`, or an own name **of kind `tailscale`** with `ownNames.accepts(host)` (`accepts()` ignores kind, so the build checks the listed name's kind itself, e.g. from `routes()`) while no relay is active (the §3.1 relay check). A still-configured Cloudflare name whose tunnel is down is NOT eligible through the own-names branch (`accepts()` also lists Cloudflare names by configuration alone). Otherwise 403, as today.
2. **Take the code** (synchronous take-and-delete, unchanged). `redeem()` now also returns the bound `{ host, kind }`.
3. **The request's Host and kind must equal the bound host and kind.** An honest phone always sends to the link's `o=`, so a mismatch means the link was altered; the code is already consumed and the answer is 403 "expired or already used" (the safe direction).
4. The pending device is recorded with `host` = the bound host, as today.

So a Tailscale link keeps working if the Cloudflare tunnel comes back during its 30 minutes, a Cloudflare link keeps working while Cloudflare stays up, and a single failed background probe never refuses a phone that has just reached the server over that very name. Outbound probe health never gates redeem, matching `accepts()` in mobile-multi-route §4.2.

### 3.3 Longer lifetimes

- `codeTtlMs` default 10 → 30 minutes. Clamp 1–60 and the `codeTtlMinutes` override are unchanged.
- `PENDING_TTL_MS` 15 → 30 minutes, so the confirmation code also lives 30 minutes. `MAX_PENDING`, the three-wrong-codes-per-device rule and the 10-per-24-hours wrong-code budget are unchanged; the attempt budget is per device and per day, not per minute, so a longer wait does not widen guessing.
- Limits stay the same numbers: `MAX_MINTS_PER_HOUR = 10` remains the binding ceiling (at most 10 links live at once); each link creates at most one pending device.
- Honest limit: these are lifetimes **unless the server restarts**. A restart (for example an auto-update) still drops live codes and expires pending devices, and the operator then needs one new link.

### 3.4 What the agent is told (Agent Awareness, Migration Parity)

The mobile-pairing section in `generateClaudeMd()` and the installed copy (`PostUpdateMigrator`, content-sniffed, idempotent, rewriting only the old lines) change to say: links last 30 minutes by default (quote the response's `expiresAt`); `409 stable-address-required` means this machine has neither a running named tunnel nor a Tailscale name served by `tailscale serve` (Tailscale counts only where multi-route is on; offer to set either up, Tailscale first: Instar sets up `tailscale serve` itself at boot when port 443 is free); `409 approval-unavailable` at mint means mint from the machine serving Telegram; when the response says `originKind: "tailscale"`, tell the operator the link opens only on a phone with Tailscale on. mobile-pairing-link.md §2.2/§2.3 and its template paragraph are updated to the same facts.

### 3.5 Rollout

The Tailscale fallback exists only where multi-route is on (dev-agent gate, `mobilePairing.multiRoute.enabled`, read at boot); elsewhere `svc.ownNames` is absent and behavior is today's. The lifetime change applies wherever mobile pairing is on. No new flag: both changes are small, and reverting the commit restores the old mint and lifetime behavior (phones already paired over a Tailscale origin keep that origin; see §9).

## 4. Security

- **Reachability grants nothing.** Whether a name is reachable on the tailnet or publicly (Tailscale Funnel, or Cloudflare), a pairing still needs the one-time link secret (single use, budgeted, bound to the current API token) AND the confirmation code delivered through the owner's Telegram DM or the PIN-gated dashboard. Neither gate changes.
- **The Tailscale name must be this process.** It is used only if `accepts()` holds (listed after the extended ping proof, and still named by this machine's own Tailscale configuration), and mint runs `verifySoleServer` against it (sibling registry + 8 pings only this process can answer).
- **No new inputs choose anything.** The origin is chosen from local configuration and proven names; the redeem host must equal the host recorded at mint.
- **Forwarders.** The Host header is not provenance: anything that forwards to the server over loopback passes `arrivedOverLocalTls` with whatever Host it sends. Cloudflare's edge (quick or named) routes by hostname, so a request through a Cloudflare tunnel arrives with that tunnel's own Host, never a `ts.net` one; a consent-gated third-party relay is the remote forwarder that could carry an arbitrary Host (a local process can too, but it already holds the API token). So Tailscale-bound mint and redeem are refused while a relay is (or may still be) carrying traffic, and are allowed alongside a running quick tunnel, which is the default install's normal route. The remaining gap is deliberate: device-signed requests after pairing are admitted on any accepted own name without this check (mobile-multi-route), and the pairing secrets, not the transport, are the authority.
- **Longer windows.** A leaked link is usable for 30 minutes instead of 10. It is still single-use, and its redemption still needs the confirmation code that only the operator sees, so a leaked link alone pairs nothing.

## 5. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Mint origin choice (Cloudflare when active, else an accepted Tailscale own name) | invariant | An enumerable preference between two origins each proven by local configuration plus the deterministic ping proof; no competing signals to weigh. |
| Tailscale name preference among several (healthy probe first, then most recent probe, then oldest) | invariant | A tiebreak over equally proven names; normally one name exists; it never admits or refuses. |
| Mint approval-reachability check (approval path + serving lease) | invariant | Mirrors the existing redeem and confirm predicates exactly; refuses earlier, never admits more. |
| Relay check on Tailscale-bound mint and redeem | invariant | A deterministic lifecycle-state test (`relay-active`/`self-healing` → refuse); narrowed to the one forwarder that can carry an arbitrary Host. |
| Redeem admission (local TLS + Host currently eligible by kind + Host and kind equal the code's binding) | invariant | Credential-gate predicate; deterministic by design, no judgment possible about a Host header. |
| Pairing link and pending-device lifetimes (30 min) | invariant | Fixed constants chosen as an explicit usability/security trade-off (a leaked link stays usable longer, §4); the guessing budget is per device and per day, so it is unaffected. |

## 6. Multi-machine posture

- Pairing codes (with their bound host), pending devices and own names are machine-local by design. machine-local-justification: physical-credential-locality (the Tailscale name's TLS certificate and node identity, and the named tunnel's credential, live on one machine; a code is only redeemable at the process whose name it was minted for).
- Standbys: a machine that cannot deliver the confirmation code (Telegram approval path without the serving lease) refuses at mint (§3.1). A lease move during the 30 minutes still voids a Telegram-path pending device, as today ("This pairing moved machines. Ask for a new link.").
- `verifySoleServer` already refuses a name another machine of this agent claims.

## 7. Frontloaded Decisions

- **Redeem binds to the mint host** (not "the preferred origin now"): chosen so a route change or one failed probe cannot strand a link the operator already opened.
- **No fallback to Tailscale when a Cloudflare self-check fails:** a hostname split across machines is reported, not routed around.
- **Probe health is a preference, not a gate**, at mint and redeem; the 8-ping self-check at mint and the request arriving at redeem are the evidence.
- **Relay rule extended to Tailscale links, narrowed to the relay**: refusing during any non-named provider would block Tailscale pairing forever on every default install (quick tunnel is permanent there); refusing only during a relay costs a wait while a relay is up.
- **Standby refuses at mint** rather than failing at redeem.
- **The `o=` link field may now carry a `*.ts.net` origin.** This is a published interface the app (topic 134088) stores as the paired host; the app must accept any https origin in `o=`; whether the shipped app does is a dependency checked by the simulator app test (§8) and coordinated with 134088 before the operator is asked. A phone off the tailnet cannot reach the origin and the app shows its ordinary connection error; the agent prevents this by telling the operator up front when `originKind` is `tailscale`. App wording is owned by 134088 and not part of this change.
- **Lifetimes are constants, not new config** (the existing `codeTtlMinutes` override remains).

## 8. Tests

- Unit: `pairingOrigin()`: named+active → cloudflare; named-but-inactive with an accepted Tailscale name → tailscale; Tailscale name with `lastProbeOk` null or false still chosen; a listed name no longer named by configuration → not chosen; multi-route off → null; named tunnel without a hostname plus a Tailscale name → tailscale.
- Unit: `PairingCodeStore` stores and returns the bound `{host, kind}`; `codeTtlMs` default 30, clamp unchanged; a pending device and its confirmation code expire at 30 minutes.
- Integration: a still-configured named host with its tunnel down, sent to redeem → 403 (own-names branch is Tailscale-only); quick tunnel active + accepted Tailscale name → mint 200 and redeem accepted; relay-active or self-healing → Tailscale mint and redeem refused.
- Integration: Tailscale-only + stubbed ping → mint 200, `o=` the Tailscale origin, `originKind: "tailscale"`; redeem with that Host over local TLS → accepted; an ineligible Host → 403 and the code survives; an eligible but unbound Host (both routes up) → 403 and the code is consumed; mint on Tailscale, then the named tunnel becomes active, then redeem on the Tailscale host → accepted; a failed background probe between mint and redeem → still accepted; a Telegram-path standby → mint 409 `approval-unavailable`; a dashboard-path machine without the lease → mint 200.
- Migration: the CLAUDE.md template and the PostUpdateMigrator rewrite (idempotent, second run a no-op).
- Live, user-role first (Live-User-Channel Proof): on Cirrus with no named tunnel, from another machine on the tailnet, a script acting as the app mints, opens the link's origin, redeems with a software P-256 device key over the `ts.net` name, reads the confirmation code from `GET /mobile/pairing-approvals` with a dashboard operator session, confirms, and makes one signed read. That is server coverage. Then the actual app, driven in the iOS simulator on a Mac on the same tailnet (the app's existing simulator/XCUITest workflow, coordinated with topic 134088), opens a Tailscale-origin link and completes pairing, which checks the app accepts and stores a `*.ts.net` origin. Only after both pass is the operator asked to pair his iPhone (topic 136110 completion condition).

## 9. Rollback

A revert restores the named-tunnel requirement and the 10/15-minute lifetimes. A phone already paired over a Tailscale origin keeps working: while multi-route is on, its host is an accepted own name; with multi-route off, device requests are checked against the stored paired host. In the multi-route-off case `/mobile/routes` labels that host `kind: "cloudflare"` (cosmetic, see Left behind in the report). Because the fallback only exists where multi-route is on (development agents today), fleet agents are unaffected either way.

## Maturation plan

- **test-agent-live:** the unit, integration and migration tests in §8 on a real server boot, plus the user-role script pairing over a `ts.net` name and the simulator app pairing (§8).
- **dev-agent-live:** the operator's iPhone pairs with Cirrus over its Tailscale name with no named tunnel (topic 136110 completion condition).
- **fleet:** the Tailscale fallback rides `mobilePairing.multiRoute.enabled` (§3.5) and reaches the fleet when multi-route graduates; the 30-minute lifetimes ship wherever mobile pairing is on.
- **graduation criterion:** multi-route's own criterion (mobile-multi-route.md), plus no Tailscale-bound pairing refused at redeem on a development agent for one week.
- **dark-window:** follows multi-route's: if not graduated within 30 days of release, the reason and a new date are recorded on CMT-1192.

## Open questions

*(none)*
