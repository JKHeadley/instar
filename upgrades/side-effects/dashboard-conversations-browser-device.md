# Side-Effects Review — Conversations in the dashboard: the browser as its own signed device

**Version / slug:** `dashboard-conversations-browser-device`
**Date:** `2026-11-08`
**Author:** `echo (M5 Pro builder, topic 134088)`
**Second-pass reviewer:** `independent reviewer subagent (claude-opus-5-5), focused on acceptance items 1–3 — see the end`

## Summary of the change

Implements `docs/specs/dashboard-conversations-browser-device.md` (converged at round 6, approved by Echo 2026-11-08 06:40 PST under the standing grant). A browser becomes its own signed device: a WebCrypto P-256 key that cannot be exported, kept in IndexedDB, approved through the agent's own approval path (Telegram owner → private-chat Approve tap or code, or an owner phone's Face ID; no Telegram owner → the live dashboard PIN session), limited to the conversation and media routes, and marked `client: 'browser'` inside the signed ledger activation row so its messages read "signed from a browser". A new console page `#/work/chats` shows app, Telegram and Slack conversations as chat bubbles (list left / conversation right; one pane at phone width) and sends with the browser's own signature.

Files (server): `src/core/MobileDeviceKeys.ts` (browser record fields, `deviceKeyOf`, registry methods: `createPendingBrowser`, `setSetupState`, `setActivating`, `activateBrowser`, `abandonActivation`, `setEffects`, `touch`, `removeIfStillSettingUp`; `decline` returns its outcome; expiry/pruning skip intents and effects), `src/core/MobileDeviceKeyLedger.ts` (+`client` in activation rows, `deviceKeyOf` readers, lookups), `src/core/MobileDeviceKeyLedgerReplicatedStore.ts` (`client` in KNOWN), `src/core/AppRecordSignatures.ts` (`LedgerKey.client`), `src/core/AppConversationService.ts` (`originClient`), `src/core/appConversationPool.ts` (💻 tag from the ledger), new `src/server/mobileBrowserDevices.ts` (setup + status routes, activation, effects, recovery), `src/server/mobilePairingRoutes.ts` (allowlist `browser` flag, authenticator rules, confirm/approve/decline/revoke browser branches, wording, mount), `src/server/mobileConversationRoutes.ts` (`deviceKeyOf` in `buildSignedOrigin`, `originClient` on history rows), `src/server/mobileOwnerDeviceAdmission.ts`, `src/server/mobileConsoleTicket.ts` (fail closed for a browser), `src/server/AgentServer.ts` (notice raiser, recovery at ledger attach, tap wording), plus Track C files: `src/core/deviceClientWording.ts`, `src/server/mobileMediaSend.ts`, `src/server/mobileSlackRoutes.ts`, `src/core/appInboundDispatch.ts`, `src/commands/server.ts`, `src/messaging/TelegramAdapter.ts`, `src/server/mobilePairingApproval.ts`, `src/server/middleware.ts` (`/view` sandbox CSP; console `blob:` images/media), `src/publishing/PrivateViewer.ts` (PIN page notice), `src/server/CapabilityIndex.ts`, `src/core/PostUpdateMigrator.ts`, `src/core/types.ts`, `src/core/devGatedFeatures.ts`, `src/data/feature-ladders.json`. Console: `dashboard/console/{console.js,browser-device.js,chats.js,chats-model.js,credential-shape.js}` and CSS/nav (Track B).

## Decision-point inventory

- Whether a browser key is activated — **add** — the existing `approvalPath()` rule, unchanged; the PIN never approves on a Telegram-owner agent.
- Whether a browser device may call a route — **add** — closed per-route `browser` allowlist (`BROWSER_ROUTES`), checked after the signature.
- Which host a loopback-bound browser's signature is checked against — **add** — exact stored loopback host, loopback peer, no forwarding header.
- Whether a decline / wrong code may change a record — **modify** — a record carrying an activation intent is "already approved".
- Whether a pending device is a "waiting device" for code-free approval — **modify** — a browser only once `awaiting` and without an intent.
- Setup limits (`maxBrowsers`, `maxSetupsPerHour`, one record per operator session) — **add** — reserved in the same synchronous registry write.
- Whether the page deletes its stored key — **add** (client) — only on a definite answer.
- `/view` responses — **modify** — sandbox CSP on every response.

---

## 1. Over-block

- A browser on an agent with a Telegram owner can be set up only from the machine holding the serving lease (the approval message travels through it): a dashboard opened on another machine is refused `409 approval-unavailable` with the reason. Intended (spec §5).
- Behind a local reverse proxy that adds forwarding headers, a loopback setup is refused `not-secure-address`; the operator uses the agent's secure address instead. Intended (§4.5).
- A setup whose approval message took more than 30 s to send is removed and must start over with the PIN (the slot is returned).
- The `/view` PIN page no longer shows a form; its unlock already answered 401 through the real middleware, so nothing that worked stops working (tracked separately as CMT-003).
- A browser cannot use the Phones list, sessions, attention or any owner-phone route — by design.

## 2. Under-block

- Code the agent's own server serves (the installed console files, `/dashboard/preview/`) can make an open browser sign while a page is open. This is the honest boundary of §4.1; it is made visible (every browser-signed message is labelled from the signed ledger row), not closed.
- On a no-Telegram agent a process running as the agent's OS user can read the PIN and create a browser key (the boundary phones already have there); the owner notice is best-effort and the durable record is the ledger row + People > Phones + "approved on dashboard".
- The forwarding-header list is a denylist of what instar-configured fronts add; a raw TCP pass-through front would look like loopback (machine-owner configuration, inside the OS-user boundary). The live proof records the fronts' real headers as a contract test.

## 3. Level-of-abstraction fit

Authentication stays in the one device authenticator (`deviceAuthenticator`), which already owns the signature check, allowlist, rate buckets and person check; the browser rules are added there rather than in each route. Approval reuses `approvalPath()`, `approvePending`, `/mobile/device/confirm`, the decline nonces and the shared DM delivery helper. The activation sequence uses the existing ledger-first discipline; the new controller only adds the intent and the effects. Durable state stays on the device records (no new store).

## 4. Signal vs authority compliance

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but every blocking decision is deterministic over an enumerable domain or a cryptographic check (signature, exact host string, closed route list, the existing approval path), not a brittle content heuristic.

The new authority surfaces are cryptographic and enumerable (they are "invariant" rows in the spec's decision table with basis + evidence). The one heuristic in this change — the credential-shape check in the composer — is a signal only: it asks the operator and never blocks a send (parity with the phone, mobile-native-conversations §4.2).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The judgment candidates (poll budget, ≤8 polled conversations, `maxBrowsers`, `maxSetupsPerHour`) are declared in the spec's `## Decision points touched` with floor, arbiter and fallback; the rest are invariants (enumerable domain / irreversible consequence / external constraint).

## 5. Interactions

- **Shadowing:** the browser checks run inside `deviceAuthenticator` after the signature and before the person check; a browser is refused `browser-device-not-allowed` before team-tier or owner-only checks could answer differently. Phones never hit the new branches (`client` absent).
- **Double-fire:** activation can be reached from three sites (`approveOutcome`, `/mobile/device/confirm`, the dashboard path); all go through `BrowserDeviceController.activate`, whose first write (`setActivating`) admits exactly one. The owner notice uses a dedupe id `mobile-pairing:browser:<deviceId>`; the one-time local fallback is guarded by `fallbackRaisedAt`.
- **Races:** decline vs approval — one synchronous registry read-modify-write each; whichever writes first wins (tests: acceptance 1, both orders and the crash window). Concurrent setups — steps 4–8 run with no `await`, the setup slot and the session are reserved in the record write (acceptance 2). Lease loss during a Telegram-path activation — `expireAllPending` skips records with an intent.
- **Boot order:** the constructor removes stuck `notifying` setups and expires other pending records (skipping intents); recovery runs once when the ledger is attached (`AgentServer`, after `reconcile`), then from `leaseTick` while the in-memory work flag is set.
- **Feedback loops:** none — effects only write the record they belong to and raise one notice.

## 6. External surfaces

- **Telegram:** a new private message for a browser approval (browser wording); Approve/Decline taps answer in browser wording; mirrors of browser sends say `💻 <name> (from the dashboard)`. Phone wording is byte-identical (tests).
- **Slack:** browser mirrors use 💻 and "open it in the dashboard".
- **Sessions:** the app inbound tag reads `(💻 signed)` for a browser message, derived from the signed ledger row.
- **Persistent state:** `mobile-devices.json` gains browser records and a `browserSetups` list (unknown fields preserved by older readers); the replicated device-key ledger gains activation rows with `client: 'browser'` (older machines reject that one row as `bad-signature` and read those messages "couldn't check", never phone-signed; after upgrading they accept the stored raw row).
- **HTTP:** new Bearer routes `POST /mobile/browser-devices`, `GET /mobile/browser-devices/status`; every device 401 now carries `machineId`; `/view/*` responses carry a sandbox CSP; console CSP allows `blob:` images and media.
- **iPhone app:** unchanged; it shows a browser in its Phones list as a paired device and its generic signed mark for browser messages (CMT-002, a fleet-graduation condition).
- **Operator surface (Mobile-Complete):** browser setup is approved from the phone (Telegram Approve tap or Face ID) — phone-completable; revocation from People > Phones.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes — the Conversations page opens on the list (or the setup card when the browser is not set up, whose primary button is "Set up this browser"); the composer is the foot of the open conversation.
2. **Zero raw internals as primary content?** The key fingerprint is shown only on the setup card, where comparing it with the Telegram message is the point; ids and hashes never appear as headline content.
3. **Destructive actions de-emphasized?** "Forget this browser", rename and delete live in the header menu; delete asks to confirm.
4. **Plain language + phone width?** Labels are plain ("signed from a browser", "couldn't check on this machine"); the layout is single-pane below 900 px. The live proof drives both 1280×728 and 390×844 before done.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Browser device records — machine-local BY DESIGN** (physical-credential-locality): the key lives in one browser's IndexedDB for one origin and is bound to the one machine serving that hostname; a tunnel move answers `elsewhere` and the browser is set up again there with `replaces`.
- **Activations and revocations — replicated** through the device-key ledger's replicated store; a revocation is definite on every machine.
- **Conversations shown — proxied-on-read** through the existing `?scope=pool` reads.
- **Owner notice:** raised once, by the machine where the activation happened (one voice).
- **`/view` sandbox:** a header set by whichever machine answers, including relayed views; no state.
- **Status surfaces:** new `GET /mobile/browser-devices/status` answers for THIS machine (`machineId`, `nickname`) with the key's state from the replicated ledger (`revoked`, `elsewhere`) plus this machine's registry; an unreadable ledger is `unknown`, never a guess.
- **URLs:** the notice names People > Phones in the dashboard, not a machine URL.

## 8. Rollback cost

Switch `mobilePairing.browser.enabled` off: the routes answer 503, browser requests are refused 403, the page shows the off text; phones are unaffected; records and ledger rows stay, so sent messages keep verifying. Rolling back to an older version: browser records cannot authenticate there (no `publicKey`), its ledger reads browser rows it already stored as plain `verified`, and `/view` loses the sandbox (today's state). No data migration; no agent state repair.

## Conclusion

The change implements the approved spec without design changes. Build deviations (recorded in the build summary): the shared owner-DM delivery helper is shared at the delivery step (the 10 s race), with phone and browser texts built separately so the phone text stays byte-identical; `lastSeenAt` is written for browser devices only (phones are unchanged). Echo's acceptance conditions 1–4 are covered by `tests/unit/mobile-browser-devices.test.ts` and the credential parity test; condition 5 is the second-pass review below. Live proof on a throwaway agent follows the merge, before done.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass reviewer subagent (claude-opus-5-5, read-only, fresh context), focused on Echo's acceptance items 1–3, 2026-11-08
**Independent read of the artifact: concern raised; all items fixed; re-check by the same reviewer: concur (39/39)**

Findings, verbatim in substance, and what was done:
- Item 1 (decline / third wrong code vs approval, both orders, crash window): PROVEN in code — every write that sets `declined` checks the intent first; every write toward `active` refuses a declined record; `normalize`, `expireAllPending`, pruning and `abandonActivation` skip or refuse correctly; `activate()` has no `await`. Gap: tests drove service methods only → **added** route-level tests (a real signed `POST /mobile/device/confirm` against the Telegram Decline tap, both orders).
- Item 2 (hourly slot, one PIN entry, slot return): no `await` between the retry check and `createPendingBrowser`; every removal returns the slot. Gap: with no device-key ledger, a dashboard-path setup failed without writing anything and held its slot until expiry → **fixed**: the setup is refused `503 ledger-unavailable` before anything is charged, and a failed dashboard activation removes the setup (slot returned).
- Item 3 (recovery on ledger attach): PROVEN — attach, `reconcile`, `recoverOnLedgerAttach` in one synchronous block; intent without a row → expired; with a row → active (also from expired); no ledger → left, reported once.
- Low: a revoked record could keep `activating` and keep recovery busy → **fixed**: `revoke()` clears the intent (test added).
- Low (wording): a leaked code answered "cancelled" for a record an approval had claimed; the dashboard decline answered `declined: true` regardless → **fixed** (owner not told "cancelled"; dashboard decline answers 409 `already-approved`; test added).
- Low: the stuck-setup sweep could remove a record while its message was still sending, and the route still answered 201 → **fixed**: a failed `setSetupState` answers 409 `approval-unavailable`.
- Authenticator browser branch and setup route: no defects found.

After the fixes: `tests/unit/mobile-browser-devices.test.ts` 39/39; the reviewer re-read each fix and concurred.

Noted by the reviewer and accepted:
- The concurrent-setup route tests would also pass sequentially; the no-`await` property is now guarded by a static test over the setup route source.
- The crash-window race is tested at the service level (no HTTP path can interleave inside `activate()`, which has no `await`).
- A tick before the ledger attach could report "no device-key ledger" — harmless (nothing is decided); in production the attach runs synchronously in the constructor before the first tick.
- An Approve tap that lands before the setup reaches `awaiting` is answered "ended" — a rare timing quirk, not a safety issue.
- The owner-phone decline still answers `declined: true` when the registry write itself throws (wording only; the code is already dropped).

---

## Evidence pointers

- `tests/unit/mobile-browser-devices.test.ts` — acceptance 1–3, activation/effects, authenticator, setup and status routes.
- `tests/unit/browser-device-readers.test.ts` — the §4.1 reader ratchet; ledger `client` validation, replication, older-peer rejection then acceptance, reconciliation backfill.
- Track C tests: `device-client-wording`, `browser-device-taps`, `html-site-ratchet`, `view-tunnel-routes`, `pool-view-link-proxy`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed here. The change adds a self-triggered controller (the activation-effect retry), declared in the trace:

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `guard`
- **`citation`** — `tests/unit/self-action-convergence.test.ts` (enforcement: ratchet), controller `browser-activation-effect-retry` registered in `src/testing/selfActionRegistry.ts`
- **`guardEvidence.howCaught`** — control-loop edge: an activation effect fails → `nextAt` moves out. Steady-state bound: one attempt in flight per record, `nextEffectAttemptAt` 30 s doubling to a 1 h ceiling (≤ 728 attempts per record over 30 days); records bounded by `maxBrowsers` and `maxSetupsPerHour`. Settling brake: the 1 h ceiling, one report after 24 attempts, one local fallback notice (`fallbackRaisedAt`), and the in-memory work flag that stops all reads when nothing is pending.
