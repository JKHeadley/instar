---
title: "The owner's phone opens Remote Desktop with Face ID instead of the dashboard PIN, and can show the PIN when a browser asks for it"
slug: "mobile-owner-presence-pin"
author: "echo"
status: "draft"
created: 2026-11-06
tier: 2
parent-principle: "Mobile-Complete Operator Actions"
sibling-principles: "A Refusal Stays a Refusal; Signal vs. Authority; Operator-Surface Quality; An Instar Agent Is Always a Multi-Machine Entity; Maturation Path"
lessons-engaged: "no-pin-on-dashboard-controls (Justin 2026-09-27: a PIN over what the caller can already do is annoyance, not safety; keep the PIN for genuinely new authority); mobile-native-permissions §3.5 (an owner phone's fresh presence signature over a single-use, action-bound challenge is the PIN's equivalent for that action, and nothing weaker); mobile-console-device-signin FD2/FD6 (the phone never gets the operator session; kept: this spec mints a narrower desktop-only session instead); mobile-device-keys (the dashboard web view keeps its PIN); dashboardPin.ts 2026-06-06 placeholder incident; every-warning-needs-a-path-to-act; no-test-traffic-on-operator-root; no-single-device-lockout (the PIN path stays)"
origin: "Operator questions, Justin, topic 134088, 2026-11-06 08:03 PST: 'Since the user has already accessed the app, which means they have authenticated with a Face ID or some other method, does it really make sense to require the user to enter a PIN to access the Remote Desktop? I definitely understand this from the browser dashboard feature. I'm just asking from the perspective of the app.' And 08:23 PST: 'There also needs to be a dedicated spot in the app for retrieving the pin, so the user can easily access it if they need it for anything that is PIN gated.'"
eli16-overview: "mobile-owner-presence-pin.eli16.md"
review-convergence: "2026-11-06T17:23:07.847Z"
review-iterations: 6
review-completed-at: "2026-11-06T17:23:07.847Z"
review-report: "docs/specs/reports/mobile-owner-presence-pin-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 14
cheap-to-change-tags: 0
contested-then-cleared: 4
approved: true
approved-by: "Echo desk, 2026-11-06, under Justin's standing grant that only constitution changes need his approval (2026-10-22 08:58 PDT). This spec changes no constitution file. It implements Justin's own requests in topic 134088 on 2026-11-06: 08:03 PST (Remote Desktop from the app without the PIN) and 08:23 PST (a dedicated spot in the app to retrieve the PIN)."
---

# The owner's phone opens Remote Desktop with Face ID, and can show the PIN

## 1. Problem

### Remote Desktop asks for a PIN the phone doesn't need

The app's Remote Desktop screen (`apps/instar-ios` `RemoteDesktop/RemoteDesktopView.swift`, `DesktopAPI.unlock(pin:)`) asks for the dashboard PIN and posts it to `POST /dashboard/unlock`. That route answers with:

- the agent's API token;
- a 15-minute dashboard operator session (`DashboardOperatorSessionStore`).

Every `/desktop/*` route requires that session. The session exists because the API token alone cannot prove a human is present (the `AgentServer.ts` `/dashboard/unlock` comment).

The paired owner phone already proves presence in a stronger way:

- every request is signed by a Secure Enclave device key;
- a second "presence key" signs only after Face ID, Touch ID or the phone's passcode (`.userPresence`).

The app already uses that presence key in place of the PIN for permission approvals (`mobile-native-permissions`). Remote Desktop simply has no such path. The console ticket (`mobile-console-device-signin`) gives the phone the console's API token, and deliberately never an operator session.

### The PIN is hard to find on a phone

The browser dashboard keeps its PIN. When the owner is at a browser that asks for it, finding it on the phone today means one of:

- scrolling back through Telegram, where the agent posts the PIN to the Dashboard topic and the owner's private chat (`TelegramAdapter`, `TunnelManager`);
- asking the agent;
- reading the config on the machine.

None of these exists without Telegram, and none is a dedicated place. That fails *Mobile-Complete Operator Actions*.

## 2. What changes

### 2.1 A desktop-only, phone-bound session, minted with Face ID (server)

Two owner-phone routes:

- **`POST /mobile/desktop-unlock/challenge`** answers `{ challenge, expiresAt }`. The challenge is a 60-second single-use secret from its own `BoundSecretStore` (4 per device, 64 in total), bound to this device and the signed Host.
- **`POST /mobile/desktop-unlock`** takes `{ challenge, presenceSig }`. The presence key signs exactly:

  ```
  instar-desktop-unlock-v1\n<deviceId>\n<host>\n<challenge>
  ```

  This version string is new, so a console-ticket, permission or PIN-reveal signature can never be replayed here. On success the route answers `{ operatorSessionToken, operatorSessionExpiresAt }`, where `operatorSessionExpiresAt` is in milliseconds.

The token comes from a **new `PhoneDesktopSessionStore`**, **not** the dashboard operator session store. Its sessions have these properties:

- **Desktop-only.** They are accepted only by a new `AgentServer.verifyDesktopOperatorSession(token)`, which accepts a dashboard operator session OR a live phone desktop session. That function replaces `verifyDashboardOperatorSession` at exactly these sites:
  - the `DirectDesktopAccess` session validator, which covers request status, ticket, resume, revoke and every control step through `validGrant`;
  - the mesh broker's `verifyFrontSession`;
  - the desktop setup routes' `verifySession`;
  - `GET /desktop/targets`;
  - `POST /desktop/requests`;
  - `GET /desktop/requests/:id/cursor` and `GET /desktop/requests/:id/displays`.

  Every other HTTP route that checks an operator session itself still accepts only the dashboard one, so a phone session can never switch features, read pairing codes, approve re-logins or do anything else. That includes `POST /desktop/locked/settings`: switching on locked-screen access stays a PIN decision, made in a browser. (`POST /desktop/locked/disable` checks no session, because it only turns access off; it is not on the device allowlist.)
- **Bound to the phone, two ways.**
  - **Caller binding.** A `router.use('/desktop')` check runs before every desktop route. Every site that accepts a phone session is reached only through an HTTP route under `/desktop`; the validator, the mesh front and setup are all called from those routes. The stream WebSocket takes only its single-use ticket. The target-side mesh routes take only delegated sessions, never phone sessions. So the check covers every entry. When the presented `X-Instar-Operator-Session` is a phone session, the request must be device-signed by the phone that minted it. A bearer caller, or another phone carrying the token, gets `403`.
  - **Revocation binding.** Every verify checks that the switch is still on, and re-checks `activeOwnerPhone` for that device at most once a second per session. The owner check reads the device registry from disk, and the desktop re-checks its session on every frame, so one answer is reused for a second. A failed registry read counts as "not an owner phone" and ends the session (fail-closed); the phone unlocks again with Face ID. This holds because production runs `DirectDesktopAccess` in `'pin'` approval mode, the only mode that re-checks the session; the phone path depends on that mode. Unpairing or revoking the phone, or turning the switch off, ends its sessions within that second. Desktop grants resting on them end too: `validGrant` re-runs the session check on every control step and every streamed frame, so an open view-only stream on this machine closes within a second. A desktop on another machine, reached through the mesh, ends within about 5 seconds, on the broker's refresh of the front session. `activeOwnerPhone` also fails when mobile pairing itself is turned off, so that ends phone sessions too.
- **Same lifetime and revocation as the PIN path.** Sessions last 15 minutes and are held in memory only.
  - **Two per phone, 32 in all.** A phone keeps at most two live sessions, so a re-unlock before opening another desktop never ends the session a running desktop rests on; a third drops the oldest.
  - **PIN change.** The `syncDashboardPinVersion` hook that clears the dashboard store also clears this one. The unlock route syncs the PIN version before issuing, so a PIN change can't clear a brand-new session.

### 2.2 The Face ID path gives the phone no API token

The desktop calls the app makes join the device allowlist (`DEVICE_ALLOWLIST`, `ownerOnly`). These are exactly the calls the app makes, and no others:

- **`owner-desktop-peers` bucket, 20 per minute.** These reads ask the other machines:
  - `GET /desktop/targets`;
  - `GET /desktop/setup`.
- **`owner-desktop-writes` bucket, 12 per minute:**
  - `POST /desktop/setup/:machineId`;
  - `POST /desktop/requests`.
- **`owner-desktop` bucket, 240 per minute.** The viewer polls status about every 1.5 seconds while pending and the cursor every 2.5 seconds:
  - `GET /desktop/setup/:machineId`;
  - `GET /desktop/requests/:id`;
  - `GET /desktop/requests/:id/{cursor,displays}`;
  - `POST /desktop/requests/:id/{ticket,resume,revoke}`.

The following stay off the allowlist:

- `/desktop/availability`, `/desktop/locked/*` and `/desktop/diagnostics`;
- the permission and config routes `/desktop/request-permission` and `/desktop/activate-config`.

The phone session carries the same desktop authority as a PIN session, setup writes included. Those writes, all through `POST /desktop/setup/:machineId`, are turning Remote Desktop on or off on a pool machine and asking for its permission prompts; the separate `/desktop/request-permission` route stays off the allowlist.

A phone that unlocked with Face ID signs each of these calls with its device key, on the same route address it unlocked on, and sends the phone session in `X-Instar-Operator-Session`. It never receives or sends the API token. The WebSocket stream keeps its single-use ticket, encryption and target-key checks, unchanged.

The PIN path in the app is unchanged: bearer plus dashboard operator session. Browsers are unaffected.

### 2.3 Showing the PIN (server)

- **`POST /mobile/dashboard-pin/challenge`**: the same shape as above, from its own store.
- **`POST /mobile/dashboard-pin/reveal`** takes `{ challenge, presenceSig }` and signs:

  ```
  instar-pin-reveal-v1\n<deviceId>\n<host>\n<challenge>
  ```

  It answers `{ pin, machine }` with `Cache-Control: no-store`.

  - `pin` is **exactly the value this server's `/dashboard/unlock` compares against**: the in-memory `config.dashboardPin`, but only when it is a non-empty string that is not the `(check your config)` placeholder. Otherwise it answers `503 console-pin-not-set`.
  - It never falls back to a vault read: a value this process doesn't compare against would not open the browser either.
  - `machine` is the verified name of the answering machine.
- **Reveal only, never set.** Changing the PIN stays a console action.
- **The owner is told before the PIN is shown, wherever that is possible.** The notice goes through the owner's private chat (`ownerDM`, the channel the pairing-approval notice already uses). It names the phone and the machine and never contains the PIN: "Your dashboard PIN for Mac Studio was shown in the Instar app on Justin's iPhone. If that wasn't you, change the PIN from the dashboard and remove that phone on the Phones page."
  - **Chat reachable.** A private chat counts as reachable only when `ownerDM` exists and a Telegram owner is present on this machine (`telegramOwnerPresent()`, the live check `approvalPath()` also reads; here a missing check counts as absent). `ownerDM` merely being defined is not enough.
  - **Notice first.** The route awaits the send. A send that returns no message id, or throws, refuses this reveal with `409 notice-failed` (audited `pin:notice-failed`, plus a `featureEvidence` `error`). Trying again sends again.
  - **One notice per phone per 10 minutes.** After a confirmed notice, reveals on that phone in the next 10 minutes are shown without a new notice and audited `pin-notice-covered`. The window starts only on a confirmed send.
  - **No private chat at all** (no Telegram, or a standby without the Telegram owner present): the PIN is shown, audited `pin-no-notice-channel`, and the answer carries `noticed: false`. The page then says "This agent has no private chat to tell you about this." Refusing here would protect nothing: the agent's own instructions already tell it to give its owner the PIN when asked (the CLAUDE.md template's Dashboard section, "give them the tunnel URL + PIN"), including in the app's private conversation. A push-based notice for these agents is queued as feedback fb-51a654a6-270.
  - **Re-checked after the wait.** Once the send returns, the route re-checks that the switch is on, the phone is still an active owner phone and the PIN is unchanged. If anything moved, it answers `409 changed-while-notifying` and shows nothing.

### 2.4 The gate

Steps 1–6 run on all four routes:

1. The feature switch is on (Maturation plan). Otherwise `503 owner-presence-off`.
2. The caller is a device principal. Otherwise `403 device-signature-required`. A bearer caller already has `/dashboard/unlock` and the PIN.
3. The request arrived over local TLS or loopback (`arrivedOverLocalTls`; loopback is how the Cloudflare tunnel and `tailscale serve` arrive). Otherwise `403 secure-transport-required`.
4. The phone is an active **owner** phone; MSP and shared phones are refused. Otherwise `403 owner-phone-required`.
5. A real PIN is set, under the same rule as §2.3. Otherwise `503 console-pin-not-set`.
6. A presence key is enrolled. Otherwise `409 presence-key-missing`, and the app enrols it through the existing `/mobile/device/presence-key` route. That route now also opens when this switch is on, even if console sign-in (`mobilePairing.consoleTicket`) is off.

Steps 7–8 run on the unlock and the reveal only:

7. The challenge is consumed: it is deleted before it is judged, and it must come from this purpose's store and match this device and Host. Otherwise `401 challenge-invalid`.
8. The presence signature verifies as strict low-S DER over this purpose's message. Otherwise `401 presence-invalid`.

The rate bucket is `owner-presence`, 12 per minute, own bucket, for all four routes. It is separate from `permission-actions`, so retries here can't use up the allowance for approvals.

### 2.5 Audit and records

The audit is a separate, append-only, size-capped `state/mobile-owner-presence-audit.jsonl`. It uses the console-ticket audit writer, with its file name made a parameter.

- **Rows:** `minted` with reason `desktop-unlocked`, `pin-revealed`, `pin-notice-sent`, `pin-notice-covered` or `pin-no-notice-channel`; `refused` with a reason of the form `<purpose>:<code>`, including `pin:notice-failed` and `pin:changed-while-notifying`. Each row carries the time, deviceId and a 12-character challenge digest reference.
- **Refusals** are written before the answer, as the permission gate does (*A Refusal Stays a Refusal*).
- **`featureEvidence`:** each success records `fired`; a failed audit write, or a reveal notice that didn't go out, records `error`.

**The PIN, the session token and the challenge never appear in the audit, a log line, a degradation report, a notice, or any other route's answer.** A test captures logs, the audit file and the notice text, and asserts that the PIN and the token are absent.

### 2.6 The app

**Remote Desktop.** The locked phase becomes one button, "Unlock with Face ID". The order is the one the permission and console flows already prove:

0. **HTTPS only, no redirects.** The challenge, unlock, reveal and every session-bearing desktop call go only to an `https` origin, checked before each request is sent, as `ConsoleTicketFlow` already requires. The server accepts loopback because the tunnel and `tailscale serve` arrive that way, so it cannot tell an HTTPS front from a local plain-HTTP proxy; the app must. The unlock, reveal and desktop calls use URL sessions that refuse every redirect, even to another `https` origin, because a redirect would forward the session header or the signed request.
1. **Face ID first.** A fresh `LAContext` with no reuse window. The app-launch unlock does not count.
2. **A signed challenge,** fetched with `AgentClient.exchange(resendable: false)`, as the permission flow does. It moves to another route only after a request that provably reached nothing. The unlock or reveal itself does not go through `exchange`: it is sent once, to the route the challenge came from (`AgentClient.on(route, pairedOrigin)`).
3. **The presence signature,** made with that same context.
4. **The signed unlock,** sent to the same route.
5. **`DesktopAPI.adopt(origin:signer:operatorSession:expiresAt:)`.** It holds that origin, signs every later call after its body is set, sends the session in `X-Instar-Operator-Session`, and counts as unlocked with no API token.
6. **One retry.** A `401 challenge-invalid` on that route gets one retry with a new challenge, using the same Face ID context.

`DesktopSession.open()` asks for Face ID and unlocks again before it begins a desktop when the phone session has less than 12 minutes left: a 10-minute grant plus up to 2 minutes waiting for approval. The app shows one desktop at a time, and it never re-unlocks while a desktop is live, so the two-session cap never evicts a session a live desktop rests on.

The app also gets two fixes here:

- It parses `operatorSessionExpiresAt` as a number or an ISO date. The PIN path's ISO value was being dropped, which is an existing bug fixed here.
- When a phone-minted session lapses, the app offers Face ID again, whatever words the server used. The PIN box appears only after a PIN unlock.

What each answer does:

| Answer | What the app does |
|---|---|
| 404, `403 device-not-allowed` (older agent), `503 owner-presence-off`, `503 console-pin-not-set`, no device id (a PIN-signed-in phone), or enrolment refused | The PIN box, exactly as today, with one plain line saying why |
| `409 presence-key-missing` | Enrol, then continue with Face ID |
| `401 challenge-invalid` | One automatic retry with a new challenge on the same route, then the PIN box |
| `401 presence-invalid` | The PIN box, with "This phone's Face ID key isn't accepted. Use the PIN, or pair the phone again." |
| `403` on a desktop call carrying a phone session | Unlock with Face ID again on the current route |
| Face ID cancelled | Stay on the button, and offer "Use PIN instead" |

**Dashboard PIN page.** A row titled "Dashboard PIN", with no description, sits beside Remote Desktop on the agent's screen. It is shown only for a device-paired agent. Each tap of "Show PIN" is one attempt. Leaving the page or the app going to the background ends the attempt, and an answer that arrives after that is dropped, so a slow notice can never put the PIN back on screen. A PIN already showing is hidden the moment the app goes inactive, before the app switcher's snapshot. Inactive alone does not end the attempt, because the Face ID sheet itself makes the app inactive. The page has:

- One line: "The PIN a browser asks for, for example the dashboard on a computer. The app doesn't need it."
- A "Show PIN" button.
- After a fresh Face ID check: the PIN in large digits; "for Mac Studio. Another machine's dashboard may use a different PIN."; and a Copy button. Copying writes the pasteboard as `localOnly` with a 60-second expiry, so it never reaches Universal Clipboard.

How the page protects the PIN:

- The PIN is held only in the page's state.
- It is cleared on `.inactive`, so it is gone before iOS snapshots the app switcher.
- It is replaced by "Hidden while the screen is being recorded" while `UIScreen.isCaptured`.
- It is cleared when the page closes.
- It is never written to disk, a log, a notification or the transcript.

What each answer shows:

| Answer | Screen and action |
|---|---|
| `503 owner-presence-off` | "Showing the PIN in the app is turned off on this agent." and Ask the agent |
| `503 console-pin-not-set` | "This agent has no dashboard PIN right now." and Ask the agent |
| `403 owner-phone-required` | "Only the owner's phone can show the PIN." The row shows on any paired phone; a shared phone learns this after Face ID. |
| `409 presence-key-missing` | Enrol, then continue |
| `401 presence-invalid` | "This phone's Face ID key isn't accepted. Pair the phone again." and a link to Phones |
| `409 notice-failed` | "I couldn't tell you privately that the PIN is being shown, so I didn't show it." and Try again |
| `409 changed-while-notifying` | "Something changed while I was telling you." and Try again |
| 200 with `noticed: false` | The PIN, with the line "This agent has no private chat to tell you about this." |
| 404 or `403 device-not-allowed` | "This agent is too old to show its PIN here." and Ask the agent |
| Face ID cancelled | Back to "Show PIN" |

### 2.7 Agent awareness and registration

- **CLAUDE.md template.** `MOBILE_PAIRING_CLAUDEMD_SECTION` keeps its sentence "The phone stores no API token and never gets an operator session", which stays true: the desktop session is not an operator session outside the desktop routes. A new `OWNER_PRESENCE_BULLET` describes the unlock and the PIN page. It is added to the section, and to existing agents by a `migrateClaudeMd` insertion before the section's "Never ask the operator for the" line, using the bullet itself as its idempotency marker.
- **Registrations.**
  - A CapabilityIndex entry for the four routes.
  - A `DEV_GATED_FEATURES` entry for `mobilePairing.ownerPresence.enabled`.
  - A `feature-ladders.json` entry for `mobilePairing.ownerPresence`: risk `sensitive`, final `default-on`, a fleet soak of 14 days, fired ≥ 20 with `minSamples` 20, error ≤ 0.05 (the same numbers as the graduation criterion).

## 3. Authority comparison

| | Browser dashboard (unchanged) | Owner phone (new) |
|---|---|---|
| Proof | Knows the PIN | Paired device key signs the request, AND the presence key signs a 60 s single-use, purpose-bound challenge after Face ID, Touch ID **or the phone's passcode** |
| Who can attempt | Anyone who reaches the tunnel or the LAN (5 tries per IP per 5 min, plus a global budget) | Only an active owner phone, over local TLS or loopback (incl. the tunnel), own rate bucket |
| What Remote Desktop yields | API token plus a dashboard operator session (15 min) that also unlocks every other operator-session route | A desktop-only session (15 min), bound to that phone. It covers viewing and controlling, and the guided-setup writes (turning Remote Desktop on or off on a pool machine). It never switches on locked-screen access. No API token. |
| What the reveal yields | n/a | The PIN, a reusable secret that works from any browser and on PIN-accepting routes until it is changed. Typing it into `/dashboard/unlock` also yields the API token, so a revealed PIN reaches the API token one step later. |
| Ended by | PIN change (sessions); the API token is never ended by either lever | Desktop session: PIN change, unpairing/revoking the phone, or turning the switch off (checked on every use). A revealed PIN: only a PIN change. |

**The phone's Remote Desktop path is the PIN's equivalent and narrower.** It inherits the same honest limit as `mobile-native-permissions`: the server cannot see the prompt, and a passcode satisfies the presence key just as it does for permission approvals.

**The PIN reveal is a deliberate escalation, and the operator asked for it** (08:23). Graduating it to the fleet before API-token rotation exists is an explicit decision at graduation, not an automatic result of the soak. Through a browser unlock it reaches the API token, which changing the PIN does not end, and there is no API-token rotation from the dashboard today. That rotation is queued as feedback fb-51a654a6-270, and the notice will name it once it exists. Someone who steals the phone and has watched its passcode can read the PIN, and the PIN outlives revoking the phone. The mitigations:

- The owner is notified before the PIN is shown wherever a private chat is reachable, naming the phone (at most one notice per phone per 10 minutes). With no private chat at all, the reveal is silent apart from its `pin-no-notice-channel` audit row, and the page says so. Every reveal is audited.
- The notice says what to do: change the PIN and remove the phone.
- The audit row names the device.
- It is live only on development agents until it graduates (Maturation plan).

## 4. Multi-machine posture

Each machine answers for itself. These surfaces are machine-local, each with its justification:

- **The two challenge stores and the phone desktop sessions.** These are live authentication credentials: bearer-like secrets that each prove one owner's Face ID moment on one machine. Copying them to other machines would put a live desktop credential on every disk and process in the pool, widening theft and making single-use impossible to enforce. Desktops on other machines are already reached through the mesh broker's machine-signed assertion, which is the unified path.
  `machine-local-justification: physical-credential-locality impossible-because="live single-use challenges and desktop session tokens are credentials; replicating them would multiply where a stolen credential works and break single-use, while cross-machine desktops already go through the broker's machine-signed assertion" permanence=permanent`
- **Presence-key verification.**
  `machine-local-justification: physical-credential-locality impossible-because="the device record and presence key are verified only on the machine serving the signed hostname (mobile-device-keys)" permanence=permanent`
- **The revealed PIN.**
  `machine-local-justification: physical-credential-locality impossible-because="the value is the one this server process's /dashboard/unlock compares; secret sync may make it equal to its peers', but only this process's in-memory value is guaranteed to open this machine's dashboard" permanence=permanent`
- **The audit file.** It records what this machine's credentials did, beside them. The owner notice is a partial, live alert about reveals. The complete history of which phone revealed the PIN is the audit files of the machines involved.
  `machine-local-justification: physical-credential-locality impossible-because="it is the use record of the machine-local credentials above, written where they are verified" permanence=permanent`

Remote Desktop to other machines works only when the paired machine is the configured front (`remoteDesktop.frontMachineId`), where the mesh broker turns the front's session into a machine-signed assertion. The same holds for the PIN path today. Otherwise only the paired machine's own desktop is offered. The PIN page names the machine and says another machine's dashboard may use a different PIN.

There is one user-facing notice, from the machine that revealed. If the phone's paired hostname is served at that moment by a standby without the Telegram owner, the reveal goes out silently apart from its audit row. A paired machine that does not serve Telegram (a standby without the owner present) has no reachable chat, so it reveals with `noticed: false` and an audit row rather than relaying. Relaying the notice through the Telegram-serving machine is part of the push-notice later work (feedback fb-51a654a6-270). It holds no replicated state and makes no URLs.

## 5. What does not change

- `/dashboard/unlock`, the dashboard operator session store, `desktop.html` and the browser's PIN prompt.
- The desktop stream ticket, its encryption and target-key verification.
- The console ticket, and its rule that the phone gets no operator session. The new session is not an operator session outside the desktop routes.

## 6. Tests

- **Unit**
  - Message bytes and purpose separation: a console-ticket, permission or other-purpose signature is refused.
  - Store separation: a challenge from one store is refused by the other.
  - `PhoneDesktopSessionStore`:
    - expiry;
    - two live sessions per phone, a third dropping the oldest;
    - drop on owner-check failure;
    - cleared on PIN change.
  - `revealablePin` refuses empty, placeholder and object values.
  - Every gate step on both sides.
  - Neither the audit nor the notice ever contains the PIN.
- **Integration**, through the real `authMiddleware` and `deviceAuthenticator`, with a paired owner phone holding device and presence keys:
  - Unlock, then a signed `GET /desktop/targets` with the phone session returns 200.
  - The same phone session sent to a non-desktop operator-session route (the feature switch) is refused, and so is `POST /desktop/locked/settings`.
  - A bearer caller, or a second owner phone, presenting the first phone's session is refused with `403`.
  - Turning the switch off ends a live phone session.
  - With a chat reachable, a send that returns no message id answers `409 notice-failed` with no PIN, and the next try sends again. With no chat at all (no `ownerDM`, or no Telegram owner present), the PIN is shown with `noticed: false` and audited `pin-no-notice-channel`.
  - A phone revoked, the switch turned off or the PIN changed while the notice was being sent: `409 changed-while-notifying`, no PIN.
  - After revoking the phone, the session is refused.
  - After a PIN change, the session is refused.
  - Refused as specified: an MSP phone, a bearer caller, a reused challenge, a cross-purpose challenge, a wrong Host, no TLS, no PIN, a placeholder PIN, the switch off, a missing presence key.
  - The reveal returns the exact PIN with `no-store`, and the notice fires without the PIN.
- **E2E**, on the production `AgentServer` path: alive on a development config (unlock 200, reveal 200), dark on a fleet config (503). Wiring integrity: `verifyDesktopOperatorSession` accepts the phone session, and the broader verifier does not.
- **App**
  - Path choice for every row of both tables.
  - The expiry parse accepts a number or an ISO date.
  - The presence routes are called only over `https`.
  - The PIN page hides a shown PIN on `.inactive`. An answer arriving after `.background` or after leaving the page is dropped, and one arriving after an inactive/active bounce (the Face ID sheet) still lands.
  - The copy is local-only and expires.

## Maturation plan

The feature rides `mobilePairing.ownerPresence.enabled`, resolved through `resolveDevAgentGate`:

- Omitted: live on development agents and dark on the fleet.
- Explicit true or false: wins.
- It is read live, with no restart.
- It is registered in `DEV_GATED_FEATURES`.

It also needs:

- `mobilePairing.enabled`;
- an enrolled presence key, which this switch can enrol on its own (§2.4, step 6);

The rungs:

- **test-agent-live:** the §6 tests on a real server boot, with a phone paired through redeem and confirm with an enrolled presence key.
- **dev-agent-live:** after release, on a **throwaway test agent** whose owner chat is the recommended-services test chat (the `recsvc` test-bot rig). That chat receives the pairing code and the reveal notice, so nothing goes to the operator's chat. A simulator app:
  1. pairs to the throwaway agent;
  2. unlocks Remote Desktop with the presence flow;
  3. reads targets and opens a desktop;
  4. reveals the PIN;
  5. checks that the test chat got the notice, without the PIN.

  Echo records PASS or FAIL for each step. This is tracked as an Echo commitment opened with the PR.
- **physical-device check:** the simulator's keys are software, so the hardware claims need a real phone: a Face ID prompt on every unlock and reveal, a cancelled prompt sending nothing, and the PIN hidden in the app switcher and during screen recording. This is the one human step, and it is hardware-bound. After the dev-agent-live record passes, Echo asks the operator once, with one link, to run it on a TestFlight build. The operator is never the first to find a defect.
- **fleet:** dark until the dev-agent-live record and the physical-device check pass and the graduation criterion holds. Graduation flips the default in its own reviewed PR. An operator can opt in with `true`, or turn it off live with `false`.
- **graduation criterion:** over a 14-day soak on development and opted-in agents, `featureEvidence` for featureId `mobilePairing.ownerPresence` shows `fired` ≥ 20 (so the error ratio means something) and `error` ≤ 0.05 (a reveal notice that didn't go out records `error`). Every `pin-revealed` row is preceded by a `pin-notice-sent`, `pin-notice-covered` or `pin-no-notice-channel` row for that phone. `refused` rows show only the expected codes.
- **dark-window:** the fleet is dark from release until graduation; development agents are live from release.
- **ladder:** mobilePairing.ownerPresence

## 7. Rollback

This is code plus one optional config key.

- Turn the switch off, or revert. The app falls back to the PIN box.
- The audit file is inert.
- Phone sessions end within 15 minutes, at once on a PIN change, and on any server restart.

## Decision points touched

- **Owner-presence gate** (§2.4). **`invariant`**: deterministic by design. Each step is a cryptographic or ledger fact, with no competing signals, and the conservative default is refusal. It is the same classification as the permission-action gate it copies.
- **`verifyDesktopOperatorSession`** (§2.1). **`invariant`**: a session either is a live dashboard session, or is a live phone session whose phone still qualifies. The narrowing to the desktop sites is a fixed list, pinned by a test.
- **App path choice** (§2.6). **`invariant`**: it follows the server's typed answer, and every branch ends on an existing safe path, the PIN box.

## Frontloaded Decisions

1. **A new desktop-only, phone-bound session store, not the dashboard operator session** (§2.1). This departs, for Remote Desktop only, from `mobile-native-permissions` FD4 ("one proof per action, never a reusable phone session"): a desktop needs many calls over minutes, so it gets a 15-minute session bound to the phone instead of a proof per call. This keeps console-signin FD2/FD6 true outside the desktop routes. It is a token, not a "this phone is unlocked until T" flag, because the existing desktop grant, mesh assertion and resume code is built around a session token, and reusing it keeps those paths unchanged.
2. **The native Face ID desktop path gives the phone no API token.** Desktop routes accept device signatures, owner-only (§2.2). The app's PIN path and the console web view are unchanged and keep their existing behaviour.
3. **Reveal returns exactly the value unlock compares against.** Placeholders are refused, with no vault fallback (§2.3).
4. **Reveal only, never set** (§2.3).
5. **The reveal notifies the owner**, without the PIN: the first reveal per phone in any 10 minutes, with every reveal audited (§2.3). This reverses the round-1 draft, which had no notice.
6. **A fresh Face ID check for each unlock and each reveal**, with no reuse window. The passcode is accepted, as for permission approvals (§2.6, §3).
7. **Separate challenge stores and message versions for each purpose** (§2.1, §2.3).
8. **Rate buckets** (§2.2, §2.4):
   - `owner-presence`: 12 per minute for the four new routes;
   - `owner-desktop-peers`: 20 per minute (targets, setup list);
   - `owner-desktop-writes`: 12 per minute (setup action, new request);
   - `owner-desktop`: 240 per minute (the viewer's polls);
   - challenge stores hold 4 per device and 64 in total.
9. **App screens for every answer** (§2.6 tables). Every failure ends on the PIN box or on a next step.
10. **The switch is dev-agent gated, with the maturation plan below.** No update restricts an existing agent.
11. **The CLAUDE.md template line is updated by migration** (§2.7).
12. **Caller binding is a `router.use('/desktop')` check** (§2.1); `POST /desktop/locked/settings` stays dashboard-only.
13. **The reveal waits for a confirmed private notice wherever a private chat is reachable**, and re-checks after the wait. With no private chat at all, it reveals with an audit row and `noticed: false`, because refusing would protect nothing the agent's own chat doesn't already disclose (§2.3).
14. **The proof rungs run on a throwaway test agent with the test chat**, never the operator's chat. The physical-device check is the one operator step, asked once after dev-agent-live passes (Maturation plan).

## Open questions

*(none)*

## Left behind

- `DirectDesktopAccess` labels every grant `dashboard-pin:<hash>`, including phone-minted ones. The new audit file records which phone minted the session; passing the origin into the desktop audit is queued as feedback fb-51a654a6-270.
- The console-ticket gate refuses without writing an audit row (a foundation gap under *A Refusal Stays a Refusal*). It is filed to the feedback queue, not fixed here.
- The private-chat notice may reach the same stolen phone's Telegram. It still leaves a record in the owner's chat history on their other devices. Notices to the owner's other paired phones are part of the push-notice later work (feedback fb-51a654a6-270).
- A phone-approved browser sign-in (the browser shows a code; the phone approves it with Face ID; the browser gets a one-time sign-in) would avoid revealing a reusable secret at all. It is the stronger design for "a browser asks for the PIN", but the operator asked for a place to find the PIN itself, so it is queued as a proposal in feedback fb-51a654a6-270 rather than built here.
- Some terms ("signed Host", "front", `validGrant`) are used before they are defined. Glossary lines are queued as feedback fb-51a654a6-270.
- `MOBILE_PAIRING_CLAUDEMD_SECTION`'s "never gets an operator session" stays as written, and the new bullet beside it names the desktop-only session. Rewording that sentence to "never gets a dashboard-wide operator session" in place is queued as feedback fb-51a654a6-270.
- A thief who reveals within 10 minutes of the owner's own reveal on the same phone sends no new notice. That reveal is still audited, and a reveal count in the next notice is queued as feedback fb-51a654a6-270.
- `operatorSessionExpiresAt` is milliseconds on the phone path and ISO on the PIN path; the app reads both. Unifying on ISO is queued as feedback fb-51a654a6-270.
- A simpler reveal rule (notify when possible, always audit, never block) was offered in review. It is not adopted: where a chat is reachable, a confirmed notice before the PIN leaves is cheap and is the owner's only live signal.
- A biometry-only presence key (`.biometryCurrentSet`) would refuse the passcode. It is not adopted, because it would differ from every other presence use in the app and lock out owners without Face ID. §3 states the passcode limit instead.
