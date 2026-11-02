# Side-Effects Review — Native app conversations, increment 3 (dashboard pairing and push without Telegram)

**Version / slug:** `mobile-native-conversations-inc3`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not run (--second-pass false, as instructed for this build)`
**Tier:** 2 (spec-driven; auth surface). Size: ~9 source/dashboard files, ~330 added lines source + ~420 test lines. One spec review round (the spec was already converged and approved); commit attempts recorded in the PR.

## Summary of the change

Increment 3 of docs/specs/mobile-native-conversations.md: §4.4 (pairing without Telegram) and §4.7 (push without Telegram), behind the existing boot-read `mobilePairing.native.enabled` gate.

- **Pairing path selection** (`MobilePairingService.approvalPath()`): with native conversations on, a Telegram owner present → the unchanged private-chat path (`approvedVia: telegram-dm`); otherwise → the dashboard path. With native off, exactly the old behaviour (try the DM whenever an adapter exists; else `409 approval-unavailable`).
- **Dashboard path:** redeem answers at once `{status: "pending", approval: "dashboard"}`; the confirmation code's plaintext is kept in process memory only (`dashboardCodes`), for the pending device's 15-minute life; the HMAC check is unchanged. New Bearer routes `GET /mobile/pairing-approvals` and `POST /mobile/pairing-approvals/:id/decline` return the fingerprint and code / decline ONLY with a valid dashboard operator session (`X-Instar-Operator-Session`, issued by a PIN unlock); the Bearer token alone and every device principal are refused (403). Confirm records `approvedVia: "dashboard-pin"` in the ledger row and the registry, and needs no serving lease. A lease move no longer expires a dashboard-path pending device (`DeviceRegistry.expireAllPending(except)`, `ConfirmationCodes.clearAll(except)`); a restart still expires it (the code lived only in memory). `GET /mobile/device` tells a pending phone `approval: "dashboard"` and an active phone its `approvedVia`.
- **Dashboard Phones tab** (`dashboard/phones.js`): the waiting phone, its key fingerprint and code (text only, after a PIN unlock), a "Not my phone — decline" button, and the paired-phones list with Remove.
- **Push on app replies:** `AppConversationService.pushHook` (the increment-1 hook point) is now wired to `MobilePushService.onAppReply`, a `reply` trigger (dedupe key `app-reply:<messageId>`) through the existing budgets, fold and dedupe, fanned out to peers; the payload says "New reply" and names the conversation, never the text. The peer route `POST /mobile/push/notify` accepts `kind: "reply"` only with a strict conversation UUID. The push service itself was already built without Telegram (PR #2522 follow-up on main).
- **Awareness:** new CLAUDE.md section "Pairing a phone without Telegram" in the template and `migrateClaudeMd` (sniffed by heading); CapabilityIndex lists the two routes.

## Decision-point inventory

- Pairing path selection — add — invariant (configuration presence: Telegram owner known, native conversations on).
- `GET /mobile/pairing-approvals` / decline — add — invariant: a verified dashboard operator session (PIN), never content, never a name.
- Confirm lease check — modify — skipped for a dashboard-path device (spec §4.4: no lease dependency).
- Lease-loss expiry — modify — spares dashboard-path pending devices.
- Push trigger acceptance from peers — modify — `reply` kind with a strict UUID.

---

## 1. Over-block

No new refusal of a legitimate input on existing paths. The two new routes refuse a Bearer-only caller by design (the code must not be readable by anything holding the API token, which agents can read). A peer on an older version answers `400 bad-trigger` to a `reply` trigger, so its phones miss reply pushes until it updates (the fan-out has no retry by design, mobile-push §4).

---

## 2. Under-block

The dashboard path proves the phone's holder unlocked the dashboard with the PIN; a process running as the agent's OS user can read the PIN from config, the boundary mobile-device-keys.md §2.2 already states and spec §4.4 repeats. Codes are shown only on the machine holding the pending record (device records are machine-local); the operator opens that machine's dashboard, which is the one serving the paired hostname. The pairing-paused attention item and the "three wrong codes" notice still go through Telegram helpers and are no-ops without Telegram; the pause itself is enforced and the phone sees 429 (attention without Telegram is the existing gap fb-4ce98e0f-293). A leaked dashboard code typed into an app chat is still caught by `scanInbound` and the pairing declined.

---

## 3. Level-of-abstraction fit

Reuses the existing pieces: `DashboardOperatorSessionStore` (via `RouteContext.verifyDashboardOperatorSession`, the same proof the Features, Origins and Desktop surfaces use), `ConfirmationCodes`/`DeviceRegistry` for the code and the 3-wrong-codes and 24-hour budgets, the device-key ledger's `recordActivation` for the approval method, and `MobilePushService.onHubPost`'s trigger path for the reply push. No new crypto, no new store.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no brittle block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The only authority added is structural: whether the caller holds a verified operator session issued by a PIN unlock. Nothing reads message content or a name to decide.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added. The spec's decision table classifies the pairing-path choice as an invariant (configuration presence).

---

## 5. Interactions

- **Existing e2e tests** that stub `ownerDM` on a Telegram-free server now also stub `telegramOwnerPresent: () => true`, so they keep covering the Telegram path; without it a dev agent with no Telegram correctly takes the dashboard path.
- **Lease tick and confirm lease branch** both pass the dashboard-path set, so neither expires such a device.
- **Push dedupe:** the owner machine raises the reply trigger once; peers receive it by fan-out and do not raise their own when the replicated reply arrives (only the session-reply route triggers).
- **Restart:** the boot `expireAllPending()` still expires every pending device, including dashboard-path ones; their in-memory codes are gone too.

---

## 6. External surfaces

Two new Bearer+operator-session routes; `redeem` responses gain `approval: "telegram" | "dashboard"`; `GET /mobile/device` gains `approval` (pending dashboard) and `approvedVia`; the push payload gains `kind: "reply"` with `conversationKey` (the iOS app change is increment 5; today's app shows the alert text). A new dashboard tab "Phones". New CLAUDE.md section for every agent on update. No new durable file; the plaintext code is never written to disk (tested).

- **Operator surface (Mobile-Complete Operator Actions):** the one operator action added — reading a waiting phone's code (and declining it) — has a phone-completable surface: the dashboard Phones tab, reachable through the tunnel with the PIN. No API-only operator action.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Touches `dashboard/phones.js` (new) and `dashboard/index.html` (tab button, panel, registry entry, styles), `dashboard/glance.js` (adoption list). The new console's navigation (`dashboard/console/nav-model.js`) lists the tab under People as "Phones" with a phone icon and a plain one-line description, so the console still links every legacy tab exactly once (its `console-nav-model` test).

1. **Leads with the primary action?** Yes. The glance headline says whether a phone is waiting ("A phone is waiting to pair. Open Waiting to see the code."); the first tile is Waiting, and its drill shows the code first in large type, then one sentence on what to do with it. With no session, the first control is "Unlock with PIN to see pairing codes".
2. **Zero raw internals as primary content?** Yes. The front layer carries fixed prose and two counts. The code is the content the operator came for; the key fingerprint is shown as a support line ("Phone key: … The app shows the same key; check they match"), no device ids, hashes or JSON.
3. **Destructive actions de-emphasized?** Yes. "Not my phone — decline" sits below the code and its instruction; "Remove this phone" is behind the Paired tile and asks for confirmation.
4. **Plain language + phone width?** Yes. Labels are everyday words ("Waiting to pair", "Paired phones", "Not my phone"); buttons are 44px tap targets, cards wrap long text (`overflow-wrap: anywhere`), no tables. Unit-tested in a real DOM (`tests/unit/dashboard-phones.test.ts`); the glance passes the F10 word/jargon floor in every state.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- Pending dashboard codes: **machine-local BY DESIGN** (physical-credential-locality, spec "Multi-machine posture": a pending code lives only in the memory of the machine serving the phone's paired hostname).
- Reply pushes: **proxied by fan-out** — the owner machine fans the trigger out over `POST /mobile/push/notify` so phones paired on any machine are notified once (dedupe key per reply).
- The approval method rides the replicated device-key ledger (unchanged machinery).

---

## 8. Rollback cost

Switch `mobilePairing.native.enabled` off: pairing returns to exactly the old behaviour, the approvals routes return empty, and no reply pushes are raised (the conversation service is not built). Or revert the PR: no data migration; a phone approved via `dashboard-pin` stays paired and keeps its ledger row.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The reply push is not a self-triggered loop: it fires once per agent reply written through `/app/session-reply` (an external event), never on a timer or in response to its own output, and every send rides the existing push bounds (2-minute fold, hourly after 40 per 24 h, 10-minute dedupe per reply, APNs backoff and pause).

---

## Second-pass review

Not run for this build (`--second-pass false`, per the build instructions). The PR is the review surface.
