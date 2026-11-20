---
title: "A new agent's first phone pairs over the same network (identity piece 3e, amendment A4)"
slug: identity-security-piece3e-same-network-first-phone
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece3e-same-network-first-phone.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Structure > Willpower; Bounded Blast Radius; An Instar Agent Is Always a Multi-Machine Entity; Mobile-Complete Operator Actions"
parent-spec: "install-experience.md §6 'Same network' and frontloaded decisions 3 and 6 (approved by Justin 2026-11-02, never built); identity-security-levels.md (approved by Justin 2026-11-17 19:34 PST, topic 144636) decision 5; the draft amendment A4 (and the surface part of A5) in owner-identity-merged.md, reviewed three rounds, owned by the identity session (topic 144636)"
depends-on: "mobile pairing (mobile-pairing-link, mobile-native-conversations §4.4), the device-key registry and ledger"
lessons-engaged: "a-dark-guard-is-worse-than-no-guard, a-filtered-query-cannot-see-what-it-filters-out, verify-in-the-design-layer-not-just-code"
review-convergence: "2026-11-19T23:30:00Z"
review-iterations: 2
review-completed-at: "2026-11-19T23:30:00Z"
cross-model-review: "none: the Fable reviewers hit their quota (resets 2026-11-25); two Opus rounds (security + integration, then a resolution check). The round-2 fixes were tested but not re-reviewed by a third round"
review-report: "reports/identity-security-piece3e-same-network-first-phone-convergence.md"
approved: true
approved-by: "Agent approval (Echo, builder #38) under install-experience §6, which Justin approved on 2026-11-02 and which chose this same-network design, and under the approved umbrella identity-security-levels.md decision 5; Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here. The A4 amendment text this follows is a draft owned by the identity session (topic 144636): this branch is pushed for that session to review, with no pull request opened."
---

# A new agent's first phone pairs over the same network

## 1. The gap

An agent made by the Windows app (and the Linux and Mac apps when there is no tunnel and no Tailscale)
cannot pair a phone at all. `POST /mobile/pairing-codes` answers `409 stable-address-required`
(`src/server/mobilePairingRoutes.ts`, the mint route), because `pairingOrigin()` knows only a running
Cloudflare named tunnel or a Tailscale HTTPS name. Found live on 2026-11-18 (the test PC live record of that day,
lines 70 to 76). Justin wants the Windows app ready for its first run sooner (topic 144319, 2026-11-19).

`install-experience.md` §6 (approved 2 Nov) already chose the answer: a same-network address, where the
agent holds its own certificate and the phone pins it from the QR code on the computer's screen. It was
never built. Amendment A4 of the identity design refines it for a first phone and adds the Windows and
Linux parts. This piece builds the agent's half of A4 (what the build order calls 3e), plus the
"connect for conversations" admission at the computer that A4 describes for a phone without the mark.

## 2. Scope

Built here, in the agent:

1. A second HTTPS listener, the **same-network listener**, off until the owner asks at the computer (§3).
2. `arrivalOf(request)` and the build-time ratchet against new address-only local tests (§3.3).
3. The network rule: open only on a network the owner allowed, closed when in doubt (§3.4).
4. A self-contained certificate writer (§3.2) and the TLS key registered as machine key material.
5. A new address kind, `same-network`, through redeem, the device record and device signatures (§3.5).
6. The pairing link version 2, made only on the local surface (§3.6), and its landing page on instar.sh.
7. "Add your phone" at the computer: the fresh check (PIN), the waiting phone, the number the agent
   issues and the owner types at the computer, the phone's signed activation (§4).
8. The terminal surface, `instar mobile add-phone` (§4.4), and the agent-awareness entry.
9. The name announcement on macOS (`dns-sd`) and Linux (`avahi-publish`, where present) (§3.7).

Not built here, and owned elsewhere in the identity build order (owner-identity-merged §12, rows 6 and 7):

- The mark (the phone becoming able to approve) and the owner-record entry the phone signs: piece **3b**,
  which depends on 3a (PR 3453). This piece lets the first phone in as an ordinary owner phone for
  conversations, which is A4's "Connect for conversations only" outcome, and records `approvedVia: 'at-computer'`
  so 3b can find it. <!-- tracked: topic 144636 (identity build order row 6, piece 3b) -->
- The apps: the Windows/Linux/Mac app's "Add your phone" screen that shows the link as a QR code and
  takes the number (A5), the Windows pass-through with its firewall prompt, the iPhone/Android app's
  pinning and v2 scan: piece **3c**. <!-- tracked: topic 144636 (identity build order row 7, piece 3c) -->
- The A5 one-time ceremony credential for the app: piece **3b** defines it (A5 condition 1). Until it
  exists the local surface is the agent's own token from this computer plus the PIN (§4.1).
  <!-- tracked: topic 144636 (identity build order row 6, piece 3b) -->

## 3. The same-network listener

### 3.1 What it is and when it is open

`src/server/sameNetworkListener.ts`. An `https.Server` with TLS 1.3 minimum on the agent's own
certificate. It exists in every agent that has mobile pairing, and it is **closed** until the owner asks
at the computer (§4.1). Whether it is wanted, its port, its announced name and the allowed networks are
kept in `state/same-network.json`, so it survives a restart. Kill switch: `mobilePairing.sameNetwork.enabled: false`.

The request handler is `gate(req) ? app(req) : (already answered)`: the same express app as the main
listener, behind the gate of §3.3. Upgrades (WebSockets) are refused. Limits before it opens (A4 point 9):
32 connections in total, a 10-second handshake timeout, header and request timeouts; where the agent
listens directly, at most 6 open connections and 40 new ones a minute per address. Inside WSL the
per-address limit is the pass-through's job (A4, Windows part), and the listener binds to WSL's own NAT
address, not to loopback: **a change from A4's text, found live** (2026-11-19, Windows 11, WSL 3.0.1 in NAT
mode): a listener on WSL's loopback is not reachable from Windows at all (only the main port, bound to
every address, was), so the pass-through would have nothing to forward to. WSL's NAT address is reachable
from the PC and not from the LAN, which keeps A4's rule that the pass-through is the only way in from the
network. It is accepted only when provably NAT mode (the address and the router both in 172.16.0.0/12 and
in one network); otherwise (mirrored mode, unreadable) the listener stays closed. The app reads the bound
address from `GET /mobile/same-network` (`bind`) to point its pass-through at it.

Port: the stored port, or main port + 1000 on first open (an OS-chosen port if that is taken); after the
first open the port never moves, because the Windows pass-through forwards to one fixed port.

It never stays open with nothing behind it: at boot and on every 15-second tick, when no setup is open
and no phone paired on it is active or waiting, it closes itself and forgets the wish. A cancelled,
ended or failed setup closes it at once on the same rule. `stop()` sets a flag that every open checks,
so nothing opens after the server stops.

### 3.2 The certificate

`src/core/SameNetworkCert.ts`. An ECDSA P-256 key from `node:crypto` and a self-signed X.509 v3 certificate
written as DER by a small writer in the same file (no package, no service). Node's own `X509Certificate`
parses and verifies it. The phone pins the base64url SHA-256 of the certificate's SubjectPublicKeyInfo.
The key is kept in `state/same-network-tls.key` (0600) and listed in `KEY_MATERIAL_PATHS` and
`KEY_MATERIAL_FILES`: never served, backed up, committed or git-synced. A name change rewrites only the
certificate (same key, same pin). An unreadable key is replaced, which means pairing again
(install-experience §6: "a replaced certificate means pairing again").

`state/same-network.json` is listed in `KEY_MATERIAL_PATHS` too. It holds no key, but writing it is a way
to open the listener, and only the owner at the computer may open it: the file editor reachable with the
token from outside must not be a way round that.

### 3.3 The gate, and nothing on this listener is local

`sameNetworkGate` in `src/server/phoneSetupRoutes.ts` answers 404 (as if no route existed) unless the
request is one of:

- `POST /mobile/pairing-codes/redeem` or `GET /mobile/pairing-codes/ping`, unsigned;
- `GET /health`, which the gate answers itself with `{"status":"ok"}` and nothing else;
- a request signed by a device whose record has `addressKind: 'same-network'` and whose host is this
  listener's own `<name>.local:<port>`, on a route the device allow-list (`DEVICE_ALLOWLIST`) names.

It refuses, whatever the route: any `Authorization`, `Cookie`, step-up, notification-token, local-secret,
lifeline or machine-auth header, and any forwarding header (`X-Forwarded-*`, `Forwarded`, `CF-*`,
`Tailscale-*`); the dashboard and its PIN unlock; `POST /mobile/local-owner-device`; the trust
device-acceptance route that carries the local key override; any device bound to the computer
(`localBinding`), any browser device, any device paired on another address.

`src/core/requestArrival.ts`: the listener marks each socket on `secureConnection`, before the HTTP parser
hands it a request, and rewrites that socket's `remoteAddress` to `sn:<address>`, which no loopback test
accepts. `arrivalOf(req)` answers `same-network` for a marked socket and `main` otherwise, never from an
address or header. The local tests that take a request ask `mayBeLocalArrival(req)` first: the Mac app's
loopback binding (`localBindingOk`, `sameMacHost`), the loopback browser binding (`loopbackBindingOk`,
`boundSetupHost`), the app-trust local override (`arrivedLocallyUnforwarded`), the internal-route test in
the auth middleware, and the new local surface (`fromThisComputer`).

The build-time test `tests/unit/request-arrival-ratchet.test.ts` scans `src/` for address-only local tests
(`isLoopbackPeer(`, or a `remoteAddress` compared with a loopback literal) not preceded by an arrival
check, against a per-file baseline that may only shrink, and fails on a new one. It has a positive control.

One thing stays true on the listener: it is TLS, so `arrivedOverLocalTls` (the transport test that
presence-signed approvals need) passes there. A phone at home approves as usual once 3b gives it the mark.

### 3.4 Only networks the owner allowed

`src/core/SameNetworkNetwork.ts` reads, exactly: on Linux (not WSL) the lowest-metric IPv4 default route
in `/proc/net/route` and that interface's single IPv4 address and netmask from `os.networkInterfaces()`;
on macOS `route -n get default` and the same interface table. A network's identity is
`interface|router|range`. Anything not readable (no route, no address, two addresses, another platform,
a command failure) is `unknown`. Inside WSL the observation is `delegated` to the Windows app, which sees
the PC's networks and enforces the rule in its pass-through (A4, Windows part).

The listener reconciles every 15 seconds and at boot: open only when the owner wants it and the current
network is an allowed one; `unknown` or a different network closes it (`held: network-unknown` or
`network-not-allowed`). The owner allows the current network at the computer with one PIN entry
(`POST /mobile/same-network/allow-network`); every allowed network is kept, up to 16. This does not prove
a network is the owner's home (limit, §7).

### 3.5 Its own kind of address

A same-network address is `<agent>-<machine>.local:<port>`: a name with a port, never an "own name".

- `BoundOrigin.kind` gains `same-network`; a code minted for it is redeemable only on the listener, and a
  code minted for another kind is not redeemable there (the redeem's bound-kind check, §3.2 step 3 of
  mobile-pairing-tailscale-origin, unchanged, now has a third value).
- On the listener the redeem does not read the Host header: the listener itself, with TLS on the agent's
  own key, is the address. The stored host is the listener's canonical `<name>.local:<port>`.
- The device record gains `addressKind: 'same-network'` and `pinnedKeyHash`. Device signatures bind
  `host` as today, with the port. In `deviceAuthenticator`, a same-network device is accepted only on the
  listener and only at the listener's current host, and the listener accepts no other device: neither
  falls through to the own-name, loopback or stored-host branches. This works with multi-route on or off.
- The address is never probed over the network: it is valid because this process made the certificate
  and opened the listener. Minting it skips the self-probe and own-name checks of named addresses.

### 3.6 The pairing link, version 2

`https://instar.sh/pair#v=2&h=<name.local:port>&k=<spki hash>&c=<code>&a=<address hints>&n=<agent name>`.
It is returned only by the local-surface route (§4.1) and never sent through any chat. The instar.sh pair
page, opened with an ordinary camera, shows "Install or open Instar, then scan the code on your computer",
reads nothing from a v2 fragment and removes it from the address bar. The v1 link is unchanged.

### 3.7 Finding the computer again

The listener announces `<name>.local` on its bound address: macOS through `dns-sd -P`, Linux through
`avahi-publish -a -R` where it is installed; the child is killed by its PID when the listener closes. In
WSL the Windows app announces (3c). The announcement only helps the phone find an address; the pinned
hash decides. The QR's address hints (`a=`) are hints, never trusted.

## 4. "Add your phone" at the computer

### 4.1 The local surface and the fresh check

`POST /mobile/phone-setup {pin, address: 'home'|'anywhere'}` on the main listener, behind the bearer
token, and only when `fromThisComputer(req)`: the main listener, a loopback peer, no forwarding header.
So a token holder reaching the agent through a tunnel or Tailscale serve (which arrive from loopback
with forwarding headers) cannot start a setup. A session or program on the computer can (A4 limit 1).

The fresh check comes before any code is shown: the dashboard PIN, through `createMandatePinCheck` with the
dashboard's durable `PinAttemptStore` (5 tries per 5 minutes per address, surviving a restart). With no PIN set, the route refuses with `pin-required` and the
surface asks the owner to set one: the check is never skipped (round-3 security finding 6a).

Refused when: an owner phone is already active on this machine and there is no Telegram owner (only the
first phone is set up at the computer; later phones are approved from that phone); this machine does not
hold the lease (the first claim is made where the lease is, as 3a requires); pairing is paused.

For `home` it opens the listener (`openForOwner`: allows the current network, records the wish), mints a
single-use code bound to `{host, kind: 'same-network'}` for at most 30 minutes, and answers the v2 link,
the address, the key hash and the hints. For `anywhere` it uses today's `pairingOrigin()` (a v1 link),
and the approval is the same.

### 4.2 The phone waits, and the agent issues its number

The phone connects, compares the certificate's public-key hash with the one it scanned, and only then
redeems, sending `pinnedKeyHash`. On the listener a hash that is not this certificate's is refused
(`not-this-computer`) before the code is taken. A link made at the computer is spent by its first phone;
a second phone gets the generic "expired or already used", and the link-reuse notice fires.

With no Telegram owner, the redeem creates a **pending** device (no confirmation code is issued, so the
chat and dashboard paths cannot confirm it) and the agent issues a random six-digit number
(`crypto.randomInt`), held in the setup with its bindings: this setup, this device id, this key's hash and
the pinned hash (round-3 security finding 3: the agent issues the number, the phone only displays it). The
number goes back to that phone in the redeem answer, and again in the activation answer while waiting
(signed by the phone's key). No approval push goes to other owner devices: none of them can let this
phone in. The device record carries `admission: 'at-computer'`, which closes every other way in for the
phone's whole pending life, even after its setup ends: the shared approval funnel (owner-phone tap,
introducer, dashboard approve, Telegram button) answers `code-only`, `approvable()` is false, the confirm
route refuses it, and its waiting answer says `confirmWith: ['computer']`.

### 4.3 The number at the computer, and the signed activation

`GET /mobile/phone-setup/:id` names the waiting phone and shows its key fingerprint (the name is the
phone's own, and said to be). `POST /mobile/phone-setup/:id/number {number}`: the right number moves the
setup to `number-accepted`; a wrong one costs a try; three wrong end the setup and decline the phone.

The phone is still pending. It then signs `POST /mobile/device/activate-at-computer {pinnedKeyHash}`
(device-signed, so the signature covers the hash: a relay that showed its own certificate cannot carry the
setup through, A4 point 7). It must arrive within 15 minutes of the right number (round-3 security
finding 3); after that the setup ends. Just before the phone is let in the agent checks again: the pinned
hash is its own (the real protection against a relay is the phone's own check before it speaks, since
anyone on the network can read this hash from a handshake; the server check is defence in depth); this
machine still holds the lease and pairing is not paused; no Telegram owner has appeared (if one has, the setup ends and the chat route applies,
A4 "Which agents take this route"); no other owner phone became active; the signing key is the one bound
to the setup. Then the device-key ledger row is written first and the registry second, as for every
activation, with `approvedVia: 'at-computer'`. The answer says `canApprove: false`.

**What such a phone may do.** It is an owner phone for conversations that cannot approve, until 3b.
`activeOwnerPhone()` answers false for `approvedVia: 'at-computer'`, which closes presence-key enrolment,
Face ID approvals of phones, introductions, permission and trust acts, console tickets and desktop
sessions. Beyond that, the device authenticator lets it sign only what a browser device may (its own
status and removal, conversations, media) plus its push registration, its route list and its own
activation; every other owner route (org acts, grants, attention choices, admin) answers 403
`cannot-approve-yet`, and it may remove only itself. `GET /mobile/routes` gives it only its home address
and pinned hash. Its notification token and document-page signatures are refused off the listener.

A phone that never signs stays pending and lapses as pending devices do today: 30 minutes, at a restart,
or when the lease moves (round-3 integration item; no activation note is needed, because this piece writes
no owner-record entry: the device record is the commit point).

### 4.4 With a Telegram owner

The setup still starts at the computer (the hash comes from its screen), and the phone's confirmation goes
through the private chat as today: the redeem sends the owner's DM with the code, the phone confirms with
it, and the device is recorded `telegram-dm`. No number is typed at the computer. The first-phone rule does
not apply on this path, because the chat approves.

### 4.5 The terminal surface

`instar mobile add-phone [--anywhere] [--json]` asks for the PIN (hidden; or the first piped line, never an
argument, so no other program reads it from the process list), starts the setup,
prints the link for the Instar app, waits for the phone, shows its name and key, and asks for the six
digits. It talks only to this computer's agent over loopback. Ctrl+C or its own timeout cancels the
setup. A QR code is drawn by the apps (3c); the terminal prints the link.

## 5. Decision points touched

- The redeem's eligibility now has a third kind of address, decided by the listener a request arrived on
  (never by a header). Deterministic, enumerable: signal-vs-authority does not apply to an access-control
  floor of this shape (as for the existing own-name checks).
- The device authenticator gains a branch that only refuses (a same-network device off its listener, or
  another device on it).
- The gate is an allow-list floor in front of a new listener; it adds no authority anywhere else.
- `at-computer` is a new admission value. It grants an owner phone for conversations only (§4.3): no
  approval right, no owner admin route.

## 6. Tests

- Unit: the certificate writer (well-formed, verified by Node, stable pin, name change keeps the key, bad
  key replaced, key material listed); the network observer (Linux, macOS, WSL delegated, every unknown
  case); the gate both ways for every route class (redeem, ping, health, a signed allow-listed route; the
  dashboard, the PIN unlock, a token, a cookie, a step-up, a notify token, a forwarding header, the local
  enrolment route, the key-override route, a computer-bound device, a browser, a phone of another address,
  an unknown device, an unlisted route); `arrivalOf` and every patched local test, each with a positive
  control on the main listener; the transport test still passes on the listener; the setup store (the
  number, the bindings, the three-wrong limit, the 15-minute signing window both sides, the 30-minute lapse,
  one setup at a time, the v2 link); the ratchet with its positive control.
- Integration (real TLS listener, stand-in phone that pins): the end-to-end first phone; a phone that pinned
  another hash stops before sending; a wrong signed hash is refused and the code survives; a second redeem
  is refused; a waiting phone reaches nothing but its setup routes; the code path is closed for it; a wrong
  number lets nothing in; after the right number it is still pending until it signs; the fresh check comes
  first (no PIN, wrong PIN, forwarded request, no PIN set); three wrong numbers decline; a Telegram owner
  appearing ends the setup; with Telegram the chat path is used; the listener serves no dashboard, PIN,
  token or computer-bound route and a same-network code is not redeemable on the main listener; the network
  rule (closed on a second network and on unknown, reopened on an allowed one, allowed at the computer,
  survives a restart, closed by the owner).
- End to end: through `AgentServer` and `start()`: absent before "Add your phone", alive after it to an
  active phone over real TLS, back after a restart with the same address and key; a second machine that
  was not asked keeps its listener closed.
- Live: a test agent made by the Windows app on the Windows 11 test VM, paired by a stand-in phone on the
  same network (`/home/echo/winapp-work/a4/live.txt`).

## 7. Limits

1. A session or program on the agent's computer can start a setup (it holds the token and can read the
   PIN). A4 limit 1; the A5 ceremony credential narrows the app's path, not this one.
2. A network made to look like an allowed one (same interface name, router and range) reopens the
   listener. What it reaches is the gate's narrow surface.
3. Inside WSL the network rule and the per-address limit are the Windows pass-through's (3c). Without the
   app, the listener on WSL's NAT address is reachable only from the PC itself (and from other WSL systems on it).
4. WSL mirrored network mode is not supported yet: the listener stays closed there (no provable NAT address).
5. A phone paired at home reaches the agent only on that network, and needs a second pairing for an
   address that works from outside (A4 point 10).
6. The first phone let in here cannot approve until 3b.
7. After a network change the listener keeps its old address for up to 15 seconds, until the next
   reconcile. Two equal default routes read as an unknown network (closed).
8. The ratchet test reads a line and the three above it; a split address test is caught only by the
   `sn:` address rewrite.

## 8. Multi-machine posture

Machine-local by design: the listener, its certificate, its name and its allowed networks bind to one
computer's own network and key (physical locality). The phone's device record stays where it paired, as
today. A first phone is set up only on the lease holder. Another machine of the agent opens nothing unless
its owner asks at that computer (tested).

## 9. Rollout

Nothing changes by itself: the listener stays closed until the owner asks at the computer. No config is
written by the update; absent means closed. Existing paired phones are untouched. New agents get the same
code. Going back: `POST /mobile/same-network/close`, or the kill switch; phones paired only this way then
cannot reach the agent and nothing else is affected.
