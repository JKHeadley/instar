---
title: "Mobile pairing link — add an agent to the Instar iPhone app with one tap"
slug: "mobile-pairing-link"
author: "echo"
parent-principle: "Mobile-Complete Operator Actions"
eli16-overview: "mobile-pairing-link.eli16.md"
status: "draft"
review-convergence: "2026-10-31T23:48:22.100Z"
review-iterations: 6
review-completed-at: "2026-10-31T23:48:22.100Z"
review-report: "docs/specs/reports/mobile-pairing-link-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true
approved-by: "Echo under the operator standing rule that only constitution changes need Justin (2026-10-22, JKHeadley/instar); 24h autonomous app session approved by Justin 2026-10-31, topic 134088"
---

## 1. Problem

The Instar iPhone app (TestFlight, operator topic 134088) adds an agent by asking for its dashboard address and its 6-digit dashboard PIN. On a phone that means copying an address from somewhere and typing a PIN for every agent and every phone. The approved app plan replaces this with pairing: the agent hands the operator a one-time link and the app redeems it.

The operator uses Instar almost entirely from one iPhone, so the primary path is a **link** the agent sends in Telegram: tap → the app opens → confirm → paired. When the link is opened on a laptop instead, the page shows a **QR code** of the same link for the phone's camera.

## 2. Design

### 2.1 What a pairing code buys, and what it never buys

A pairing code is a single-use, short-lived stand-in for typing the dashboard PIN **for one purpose only**: obtaining the agent's API token, the credential the app already uses after a PIN entry today.

- It **never** issues the operator-session proof (`operatorSessionToken`) that `/dashboard/unlock` also returns. That proof exists because an agent can read the API token and therefore must not be able to prove a human unlocked the dashboard. Codes are minted with the API token, so a code-derived operator proof would let an agent session mint a code, redeem it, and act as the operator. The app keeps asking for the PIN for operator-gated actions (mandates, money, desktop control).
- 128 bits from `crypto.randomBytes(16)`, base64url (22 characters).
- Lifetime 10 minutes (`mobilePairing.codeTtlMinutes`, clamped to 1–60).
- Single use, enforced by a synchronous take-and-delete of the code's entry before any asynchronous work, so two concurrent redeems of one code cannot both succeed.
- Held in process memory only, as a SHA-256 hash. The plaintext appears in the mint response, the link, and the redeem request body; neither the mint nor the redeem payload is written to request logs.
- At most 10 live codes, and at most 10 mints per hour. At either limit, minting answers `429` (never a silent eviction of the operator's live link).
- A server restart drops all live codes (the safe direction: one new link).
- Each code is bound to the API token in force when it was minted (the entry stores a SHA-256 of that token). A redeem after the token has rotated is refused like an invalid code, so a code minted before a rotation can never obtain the replacement token.

### 2.2 A stable address is required

The phone stores the agent's address. A Cloudflare quick tunnel (`*.trycloudflare.com`) changes on every restart, which would silently break the app the next day. A named tunnel configured without `tunnel.hostname` (token mode, where the hostname lives only in the Cloudflare dashboard) answers `409 stable-address-required` with the detail "the named tunnel has no configured hostname", and the agent offers to fill the hostname in. Minting therefore requires a stable public HTTPS origin, taken from configuration and never from the live tunnel URL (the tunnel manager can fall back to a quick tunnel or an operator-approved relay at runtime): `https://<tunnel.hostname>` of a configured **named** tunnel (the only supported deployment for phone pairing; there is no separate public-origin override). It also requires that this machine is the one answering on that address. The lifecycle check alone is not enough: every machine of an agent can run the same named tunnel, and Cloudflare then splits requests between the connectors. So before minting, the server makes two checks. First, a deterministic one: the machine registry records each machine's `lastKnownUrl`; if any other active machine of this agent lists the same hostname, minting is refused. Second, as a backup for a sibling whose registry entry is stale, it probes its own stable origin eight times at `GET /mobile/pairing-codes/ping?n=<nonce>` (route 3 below); minting proceeds only when all eight answers match its own computation. This is a **best-effort diagnostic, not a guarantee**: with two connectors and even routing, all eight probes land on the minting process 1 time in 256, and routing affinity can hide a second connector longer. The guarantee instead comes from the deployment shape the feature supports: one machine per named-tunnel hostname (the normal Instar setup, where each machine has its own hostname). If a second connector does go unnoticed, the worst outcome is a redeem that lands on the other process and fails as "expired or already used", after which the operator asks for a new link; no credential is mis-issued. Otherwise `POST /mobile/pairing-codes` answers `409 { error: "stable-address-required", detail }` (or `409 { error: "not-the-tunnel-machine" }` when the registry or a probe shows another process answering, or `409 { error: "address-unverified" }` when a probe failed or timed out, with its own plain-words reason; the agent says in plain words that another of its machines is answering on that address and that pairing needs that address served by one machine), and the agent tells the operator in plain words that the phone app needs a permanent address and offers to set up a named tunnel itself.

### 2.3 The link: a universal link on instar.sh

Link format, version 1 (a published interface, frozen here):

```
https://instar.sh/pair#v=1&o=<urlencoded origin>&c=<code>
```

- **Universal link, not a custom scheme.** Any iOS app can register `instar://`, so a custom-scheme link carrying a bearer-equivalent code could be caught by another app. instar.sh serves `/.well-known/apple-app-site-association` naming only `AG9AE2H87X.io.sagemindai.instar` for `/pair`, so iOS opens the link only in the Instar app. Telegram on iOS is expected to hand universal links to the installed app; that is verified on a real iPhone at the operator's first use (section 7), and the fallback page covers the case where it does not.
- **Everything is in the fragment.** Browsers never send the fragment in an HTTP request, so the code and origin do not reach instar.sh's server, its CDN logs, or a Referer header. The link itself is still held by Telegram (which carries the message) and by the operator's devices; that is why it is single-use and short-lived.
- **The page (fallback).** If the app is not installed, Telegram opens the page instead of the app, or the link is opened on a laptop, `instar.sh/pair` (a static page in this repo's `site/`) reads the fragment client-side and shows: the agent's host, a **Copy link** button, a QR code of the same link (rendered client-side by the `qrcode` npm package bundled at build), a TestFlight install hint, and nothing else. **Same-phone recovery:** the app's add menu has **Paste pairing link**, which reads the copied link from the clipboard (iOS shows its paste permission prompt) and continues to the normal confirmation. It validates `v=1`, an `https` origin, and a code matching `^[A-Za-z0-9_-]{22}$`; anything else shows "This link is not valid." It never inserts fragment text as HTML. Its CSP is `default-src 'self'; connect-src 'none'; img-src 'self' data:`.
- **The app.** It accepts only this format (`v=1`, `https` origin), shows a confirmation with the origin's host in large type ("Only add agents you run"), and redeems only after the operator taps **Add**. The display name comes from the redeem response, never from the link.

### 2.4 Routes on the agent

1. `POST /mobile/pairing-codes` (ordinary Bearer auth). Body `{ "label"?: string }` (≤ 60 printable characters, control characters stripped; held in memory with the code's hash entry, written to the device log at redeem, dropped if the code expires). Returns `{ code, expiresAt, link }` where `link` is the 2.3 URL. `409 stable-address-required` per 2.2; `429` at the limits.
2. `POST /mobile/pairing-codes/redeem` (exempt from the bearer gate by an exact path+method entry, like `/dashboard/unlock`; no prefix exemption). Body `{ code, deviceName? }`.
   - **Transport:** accepted only when `arrivedOverLocalTls(...)` is true (a TLS socket, a loopback caller (which is how the HTTPS tunnel arrives), or the WSL Windows-host forward carrying `x-forwarded-proto: https`) **and** the tunnel lifecycle on this machine is `active` on the named provider at the moment of the redeem **and** the request's `Host` header equals the configured stable host. The lifecycle check is the ingress-provenance rule: a fallback quick tunnel or third-party relay only runs while the named tunnel is not active, so while either is up every redeem is refused (the Host header alone proves nothing about which forwarder delivered the request; it only stops a request addressed to some other name). This is unconditional and therefore **stricter than today's PIN route**, which only enforces TLS when remote desktop is on. Plain HTTP from a LAN or Tailscale address is refused `403`.
   - **Rate limit:** the code is looked up first, so a valid code **always** redeems; the limiter only throttles failures (after 30 failed redeems in 10 minutes, further *invalid* attempts get a distinct `429 { error: "too-many-attempts" }`, which the app does not show as "expired"). Exhausting it therefore cannot block a legitimate link, and it does not make guessing feasible (a 128-bit code). It is separate from the PIN route. It never reads, writes or resets the PIN's counters or `pinAttemptStore`, so bad codes cannot lock the operator out of PIN unlock or desktop admission, and a redeem success cannot clear PIN failures.
   - **Success:** `{ token, agentName }`, never an operator session. Any bad, used or expired code: `403 { error: "That link has expired or was already used." }` (no distinction). No API token configured: `503`.
   - The Host check assumes cloudflared forwards the original Host (its default). An ingress rule that rewrites it (`httpHostHeader`) would make every redeem 403; the live proof below redeems through the real named tunnel to catch that.
   - After the code is taken, the device record (2.5) is appended. If that write fails, the token is still returned, a degradation is reported, and the code stays consumed.
3. `GET /mobile/pairing-codes/ping?n=<nonce>` (exempt from the bearer gate by its own exact GET entry). Nonce must match `^[A-Za-z0-9_-]{16,64}$`, else `400`. Answers `{ h: sha256(processSecret + nonce) }`, where `processSecret` is random per server process and never leaves it, so the answer identifies "this process or not" without revealing any machine or agent identity. `Cache-Control: no-store`. Its own limiter: 60 requests per minute overall, then `429`, applied only to nonces this process did not issue itself. The minting process records each self-probe nonce for 60 seconds, and those requests bypass the public budget, so strangers exhausting it cannot prevent minting. Follows the feature gate (503 when off).
4. `GET /mobile/devices` (Bearer): `{ devices: [{ id, deviceName, pairedAt, label, machine }] }`, newest first. `?scope=pool` merges every online machine through the existing pool fan-out; an unreachable machine is a `failed` entry, never a silent omission.

### 2.5 Device record (visibility, not authority)

Each successful redeem appends `{ id, deviceName, pairedAt, label }` to `.instar/state/mobile-devices.json` (`deviceName` ≤ 60 printable characters, control characters and newlines stripped; written synchronously with an atomic rename in the single server process, so concurrent redeems cannot lose entries; capped at 200). It gates nothing. Rows are untrusted text; the CLAUDE.md entry says so.

### 2.6 Foundation risk and revocation

Today the PIN hands the full API token to a browser tab. This feature lets that token live in a phone's Keychain without the PIN being typed there. That widens an existing over-grant; it does not create a new one. The only token rotation today is automatic: the tunnel manager rotates the API token after each backup-relay episode. It cannot target one device, and it signs out **every** paired phone at once. There is no operator lever to cut off one lost phone. Therefore:

- The app treats `401` from an agent as "needs pairing again" (a distinct state with a **Pair again** action), never as "unreachable".
- When that rotation happens and the device list is non-empty, the existing rotation notice to the operator gains one sentence: the paired phones need a new link, and the agent can send one.
- A phone is bound to the token of the machine fronting the stable tunnel. If the tunnel front moves to a machine with a different local token, the phone gets `401` and needs pairing again.

- The feature ships behind the development-agent gate (2.8) and stays off for the fleet until per-device, individually revocable tokens exist (CMT-1179), which is a blocking prerequisite for the fleet flip, not a parallel item.
- The device list makes every pairing visible meanwhile.

### 2.7 Agent awareness

The CLAUDE.md template gains a section: when the operator asks to add an agent to the Instar app or pair a phone, mint a code and send the `link` **only into a topic whose verified operator (`GET /topic-operator/:topicId`) is the person asking**; never send the code alone, never the API token; on `409 stable-address-required`, say so in plain words and offer to set up a named tunnel. `GET /mobile/devices` answers "which phones are paired?"; its rows are untrusted text. PostUpdateMigrator adds the section to existing agents, guarded by the marker string `Mobile pairing link`. No config migration is needed: `mobilePairing.*` absent means the gate default and the default TTL.

### 2.8 Configuration

`mobilePairing.enabled` omitted ⇒ the standard development-agent gate (live on a development agent, dark on the fleet); explicit `true` ⇒ on (an operator's deliberate opt-in on any agent; the "fleet flip" blocked on CMT-1179 means changing the omitted-value default, not refusing an operator's explicit choice); `false` ⇒ all four routes `503` (read live; links already sent then fail, the safe direction). The feature appears as a row on `GET /guards`.

## 3. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Redeem: accept or refuse a code | `invariant` | Lookup by SHA-256 of the presented 128-bit code, expiry, single use. No competing signals. |
| Redeem: transport | `invariant` | `arrivedOverLocalTls`, unconditional, plus named tunnel `active` and a matching Host. |
| Redeem: rate limit | `invariant` | Fixed limiter, separate from the PIN's. |
| Redeem: operator session | `invariant` | Never issued. |
| Mint: who may mint, and the 10-live / 10-per-hour limits | `invariant` | Bearer auth; fixed caps answering 429. |
| Mint: stable address and single answering machine | `invariant` | Configured named tunnel with a hostname, lifecycle `active`, no other active machine listing the same hostname in the registry, eight self-probes answered by this process (backup detection, see 2.2); else 409. |
| Where the agent sends the link | `judgment-candidate` | Floor: only a topic whose verified operator is the requester (Know Your Principal); default when unsure: do not send, tell the operator. Arbiter: the agent, bounded by that floor. |

## 3a. Signal vs authority

The redeem decisions are exact, deterministic authentication and rate checks on the agent's own credential. The mint-side deployment checks (registry hostname match, self-probes) are deployment-health checks enforcing the supported deployment shape; they can refuse a mint that would have worked (a false refusal costs one retry) or miss a second connector (2.2 states the consequence), and they only ever refuse, never grant. None of the routes grants anything beyond what the PIN route already grants (minus the operator session).

## 4. Multi-machine posture

- **Pairing codes:** ephemeral process memory, not a state surface. A machine mints only after eight probes of the stable address are all answered by its own process (409 `not-the-tunnel-machine` otherwise), so a fresh link normally lands on the machine holding its code. Two machines connected to one named tunnel are usually detected (best-effort, 2.2); pairing then waits until one machine serves the address (multi-connector serving stays unsupported; see docs/specs/mobile-device-keys.md). If the tunnel front moves inside the ten-minute window, the link fails and the operator asks for a new one.
- **Device record:** proxied-on-read (`GET /mobile/devices?scope=pool`); each machine keeps the rows for pairings it issued.
- **What the phone holds:** one origin and that machine's API token. On a multi-machine agent that is the machine behind the stable tunnel. If that machine is dark, the app shows the agent as unreachable (the Fleet view's existing state) until it returns. Learning sibling machines is out of scope (docs/specs/mobile-device-keys.md keeps it unsupported).

## 5. Frontloaded Decisions

- **Redeem returns the API token and never an operator session.** Per-device tokens are the next spec (CMT-1179) and gate the fleet flip.
- **Universal link on instar.sh, link format v1 frozen** (2.3). Not a custom scheme.
- **Stable address required** (2.2); quick tunnels refused with 409.
- **Redeem transport stricter than the PIN route** (2.4); separate rate limiter.
- **Mint limits answer 429**; no silent eviction.
- **QR rendered client-side on instar.sh by the `qrcode` npm package** (library choice cheap to change; the payload is the frozen v1 link).
- **Development-agent gate**; fleet flip blocked on CMT-1179 (per-device revocable credentials, delivered by docs/specs/mobile-device-keys.md; serving one hostname from several machines and surviving tunnel moves stay unsupported and are not part of the prerequisite).
- **Named tunnel only; origin from its configured hostname; redeem requires the named tunnel active plus a matching Host**; minting only on the tunnel-serving machine.
- **Same-phone recovery is Copy link on the page + Paste pairing link in the app.**
- **401 means pair again** in the app; the rotation notice names paired phones.

### Accepted limitation

If a sibling machine starts serving the same hostname *after* a phone paired (and with a different local token), the phone sees intermittent `401`s, and pairing again does not fix it. The deterministic mint check prevents the common case; the remaining case is a misconfiguration that stays unsupported (docs/specs/mobile-device-keys.md binds each device to one machine's hostname), and the app's "needs pairing again" state at least makes it visible.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** the integration and E2E tests run a real server boot with a named-tunnel config, mint a code and redeem it once over loopback.
- **dev-agent-live:** live on the development agent (Echo) from the release that carries it, used through the Instar iPhone app on TestFlight; the live-user-channel proof in section 7 is run there before the operator is asked to try it.
- **fleet:** dark (gate default off) until per-device revocable tokens ship (CMT-1179); the flip changes the omitted-value default.
- **graduation criterion:** on the development agent, at least one real pairing through a Telegram-delivered link that adds the agent to the app with a live Fleet card, zero redeems refused for reasons other than used/expired/rotated, and CMT-1179 delivered.
- **dark-window:** the fleet stays dark until CMT-1179 is delivered; if that has not happened within 30 days of this release, the reason and a new date are recorded on CMT-1179.

## 6. Rollback

`mobilePairing.enabled: false` (read live) makes the routes 503. Removing the feature removes the routes and the instar.sh page; the device log is an inert JSON file. Live codes die on restart.

## 7. Tests

- Unit: code store (mint, take-and-delete single use, expiry, 10-live and 10-per-hour 429, hash-only storage); device log (append, cap, sanitize, concurrent appends both land); link builder (v1 grammar, fragment encoding).
- Integration (HTTP): mint requires Bearer; only redeem and ping are reachable without Bearer, each by an exact path+method entry (devices and mint return 401; no `/mobile` prefix is exempt); ping rejects a malformed nonce and never returns anything but the hash; redeem refused over plain HTTP from a non-loopback address with desktop off; good code → token once, second use → 403; mint → rotate the token → redeem → 403; expired → 403; response never contains `operatorSessionToken`; redeem failures never touch PIN counters (a PIN failure after 30 bad redeems still has its full budget); quick tunnel or a relay-active lifecycle → 409 at mint; a redeem whose Host is not the configured stable host → 403; a redeem with a valid code while the tunnel lifecycle is `relay-active` or on the quick fallback → 403 even when Host matches; a valid code still redeems after the failure limiter is exhausted; mint when another active registry machine lists the same hostname → 409 `not-the-tunnel-machine`; mint when any self-probe is answered by another process → 409 `not-the-tunnel-machine`; named tunnel without a hostname → 409 `stable-address-required`; ping returns 503 when the feature is off; minting still works while the public ping budget is exhausted; a failed probe answers `address-unverified`, not `not-the-tunnel-machine`; the ping route is public, returns only the hash, and is rate-limited; after a credential rotation with paired devices the rotation notice mentions them; disabled → 503.
- E2E: the production boot path answers `POST /mobile/pairing-codes` (feature alive on a development agent with a named tunnel).
- Live-user-channel proof before done (driven by the agent, before the operator is asked to try it): on the development agent, mint a link and deliver it through the real Telegram relay to a test topic; in the iOS simulator with the Release-signed app installed, open that exact link as a universal link (`simctl openurl`), confirm, and see the agent's Fleet card with live data; open it again and see the "expired or already used" refusal; open the fallback page in a desktop browser and confirm the QR renders and the request log shows no code. Screenshots go in the PR. The operator's first real tap inside Telegram on the iPhone is then his normal first use, reported back if it differs.
