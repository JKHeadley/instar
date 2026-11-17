# Side-Effects Review — Project apps, part 2 (custom apps in a sealed frame, approved from the owner's phone)

**Version / slug:** `project-apps-custom`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `required (new authority surfaces: a narrow key, a sandbox frame, phone-only approval cards) — see below`

## Summary of the change

Implements `docs/specs/project-apps-sandbox.md` (converged at the 6-round cap plus two targeted verification passes; approved by Justin's "go!", topic 141385 2026-11-16 16:34 PST). The agent can write a small app for one project (`POST /project-apps`, `PUT /project-apps/:appId/source`). Each version becomes a server-written Work Board card that only the owner's phone can approve (presence-signed, bound to the card's material hash; console PIN taps refused with `phone-only-card`). The approved version runs in `dashboard/project-app/` (the wrapper), inside a frame served with CSP `sandbox allow-scripts allow-forms` (an opaque origin: no dashboard storage, cookies or DOM). The frame is reachable only through a single-use 60-second ticket, and `Sec-Fetch-Dest` is checked. The wrapper hands the frame a narrow key `pak_<claims>.<HMAC>` (15 minutes, bound to the app, its served version and its epoch) that reaches only `/project-apps/<appId>/api/data` and `/api/summary`.

New modules:
- `src/server/ProjectAppSandbox.ts` with `projectAppSandboxRoutes.ts` (ticket, key, frame, app API).
- `src/core/ProjectAppBlobStore.ts`: a new replicated kind `project-app-blob` holding base64 AES-256-GCM chunks of at most 32 KiB, HLC revisions and a 64 KiB serialized cap.
- `src/core/ProjectAppKeys.ts`: per-app keys in `state/project-app-keys.json` (0600, on the backup blocklist); erase works by destroying the keys.
- `src/core/ProjectAppCustomFold.ts`: the served version is derived only from Work Board approves.
- `src/server/ProjectAppCustomSource.ts` with `projectAppCustomRoutes.ts`.

Wiring:
- server.ts registers the kind, inert until `projectApps.custom.enabled`.
- CoherenceJournal, JournalSyncApplier and WriteDomainRegistry carry the new kind.
- WorkBoardService gets `entries()` and `serverCard`; workBoardRoutes gets `phoneOnlyCard`, and the card JSON carries `phoneOnly`.
- middleware: exact-path auth/CORS exemptions for the frame and app API, and the wrapper's CSP `frame-src`.
- The Redactor, credentialShapes and durableSecretScrub learn the `pak_` key shape.

Console: a custom app's Open goes to the wrapper (strict regex `^/dashboard/project-app/\?app=pa_[0-9a-f]{16}$`). Phone-only cards show "Approve this on your phone" and keep "Stop this app".

Example: `examples/project-apps/sales-pipeline.html`.

Switch: `projectApps.custom.enabled`, dev-gated. It needs `projectApps.enabled`, so it is off on the fleet.

**Stage 2 of this build (tracked, CMT-1882):**
- mesh write-forwarding to the lease holder
- the app-key fetch mesh verb
- the lease-epoch timeline for fenced late writes
- the catch-up barrier and revocation push/confirms
- erase/delete/enable/allow-again/budget cards
- phone Decline → reject

Until these ship, app keys never leave the lease holder. Another machine shows "still copying" (fail safe, nothing leaks), and erase destroys the only copy.

## Decision-point inventory

- Which version runs (ProjectAppCustomFold) — add — only an owner-phone `presence` approve on the server-written card for that exact content hash; console/PIN and Bearer taps refused.
- Frame load (sandbox routes) — add — a single-use 60 s ticket minted by an authenticated dashboard request; a direct open answers 403.
- App API (sandbox routes) — add — the narrow key only; it is checked for app, version, epoch and expiry, and never accepted on any other route (middleware: the key is not a Bearer).
- Writes (ProjectAppCustomSource) — add — lease holder only; revision CAS (`409 conflict`); pool-wide daily byte budget (`429`).
- Source size / data size / apps per agent / title length caps — add — starting values (2 MiB, 1 MiB, 10, 60 chars), raised from the phone.

---

## 1. Over-block

- On a machine that is not the lease holder, a custom app shows "still copying" and refuses writes until stage 2 (CMT-1882). It fails safe and the spec says so.
- The owner cannot approve a version from the desktop console. This is by design (the agent knows the PIN), and the card says "Approve this on your phone".
- An app cannot talk to any outside service. This is by design (`connect-src` is the app API only).

## 2. Under-block

- An agent with shell access on the host can change what the host serves. The spec states this limit plainly. The design protects the API-only hijack case, the owner's phone and the owner's browser.
- A user typing a password into an app's form: the bar reads "made by your agent" and the version check flags it. This is a stated residual.
- The browser proof (Chrome and WebKit, 390px) shows that every escape the hostile fixture attempts is blocked: localStorage, IndexedDB, cookies, the parent DOM, owner routes, external fetch, popups, top navigation, self-navigation, and the key on an owner route. Evidence: `.instar/lanes/project-apps-proof/hostile-proof-result.json` (agent home).

## 3. Level-of-abstraction fit

Approval reuses the Work Board and its phone presence proof, with no new approval system. Storage is its own journal kind, so it does not touch Instar Documents and its shared-editor semantics. The sandbox is a browser primitive (CSP sandbox, an opaque origin), not a hand-rolled filter.

## 4. Signal vs authority compliance

The agent's offer and its source are signals. Authority is the owner's phone tap, bound to the content hash. No LLM judgment gates anything here. The narrow key is a capability scoped to one app's data, not a decision.

## 4b. Judgment-point check (Judgment Within Floors standard)

The caps are floors with a stated basis, and only the owner can raise them. No judgment is replaced by a counter: the caps limit volume and never decide what is allowed.

## 5. Interactions

- Work Board: new server-written card class. `phoneOnly` is shown in the card JSON. Existing cards are unchanged; tests cover a regular card still accepting a console tap.
- Middleware: exact-path exemptions only, for `/project-apps/:id/frame` and `/project-apps/:id/api/*`. All other `/project-apps` routes keep Bearer auth. Covered by integration tests.
- Redaction: the `pak_` shape is added to the credential shapes, so keys are scrubbed from logs and outbound text.
- Backups: the key file is on the blocklist. A restored backup cannot resurrect erased data.

## 6. External surfaces

- New routes: `GET/POST /project-apps`, `PUT /project-apps/:appId/source`, `POST /project-apps/:appId/ticket`, `POST /project-apps/:appId/key`, `GET /project-apps/:appId/frame`, `GET/PUT /project-apps/:appId/api/data`, `GET/PUT /project-apps/:appId/api/summary`. All answer 503 when custom apps are off; the e2e test checks this.
- New wrapper page `/dashboard/project-app/`.
- New replicated kind `project-app-blob`. Older machines skip it.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The phone card says what the app does, shows the agent's change note, and has one Approve. The console states plainly where to approve. The wrapper bar names the app, its project and "made by your agent", plus a link back to the conversation. Failures read in plain words ("still copying", "Saving is paused until tomorrow").

## 7. Multi-machine posture (Cross-Machine Coherence)

There is one coordinator, the lease holder, which writes blobs, holds keys and mints tickets. Replicated revisions and approvals let every machine fold the same served version. Key distribution beyond the holder is stage 2 (CMT-1882). Until then another machine fails safe, showing "still copying" and serving nothing.

## 8. Rollback cost

Turn `projectApps.custom.enabled` off. The routes answer 503 and the console shows nothing new. The journal records stay inert. Reverting the commit is clean: the new kind is skipped by builds that do not know it.

## Conclusion

The change is safe to ship dark on development agents. The security boundary is proven in two browser engines against the real server, and every authority is the owner's phone.

## Second-pass review (if required)

Independent reviewer (Claude Opus 5.5 subagent, given the diff and spec, not this artifact's conclusions), 2026-11-16 21:37 PT. Verdict: **concur-with-fixes**. No path past the owner's phone approval was found in any of the six areas (frame/key/middleware, served version, tickets/keys, encryption/erase, loops, malformed records). Five findings, all fixed before commit:
- M1: erase left small data confirmable through unkeyed plaintext hashes in record keys. Fixed: data chunk ids and content hash are now HMAC'd under the generation's data key.
- M2: an out-of-range erase target from a peer threw inside one try and blocked every later revocation. Fixed: the validator matches the consumer, and each revocation runs in its own try.
- M3: hostile app code could loop cheap API requests and force a full refold on every call. Fixed: fold results are memoised until invalidate, and a per-app token bucket answers 429.
- L1: the agent's change note could fake the card's check-results block. Fixed: whitespace collapsed, length capped, server findings shown first.
- L2: the phone-only guard failed open on error. Fixed: it now fails closed.

## Evidence pointers

- Unit/integration: ProjectAppSandbox, ProjectAppBlobStore, ProjectAppKeys, ProjectAppCustomFold, ProjectAppCustomSource, project-app-custom-wiring, BackupManager-projectAppKeys, console model tests. Integration: project-app-custom-routes, project-app-sandbox-routes, work-board. 490 + 31 passed.
- E2E: `tests/e2e/project-apps-custom-alive.test.ts`. It covers create → source → a phone-only card → a console approve refused → the frame refused without a ticket, and checks that the switch off answers 503 on all six routes. Run together with project-apps-alive, work-board-alive and work-projects-alive: 8 of 8 passed.
- Browser: the hostile-app proof in Chrome and WebKit at 390x844 against the real AgentServer.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a` (negative declaration)
- **reason:** owner-driven: a version card opens once per (app, content hash), with a deterministic id, and sends one notice when it opens. Writes come from the app in the owner's browser and are capped by the pool-wide daily budget. Key renewal is bound to the loaded version, with bounded back-off and a two-hour breaker that stops and offers Try again. No timer creates work.
