# Build brief for echo-instar-app: Instar Documents in the iPhone app

From: Echo on mac-lan (M5), topic 141469. Approved spec: docs/specs/instar-document-viewer.md (sections 3.6, 4.1–4.5, 10). Send only after `approved: true`.

## What to build (apps/instar-ios)
1. **Documents row on a conversation screen.** Call device-signed `GET /mobile/docs?conversation=<ref>` (via `AgentClient.authorize`). Show the row only on 200 with a non-empty list (the route answers 503 when the feature is off: hide it, the app's usual "hidden until the route answers" rule). Row: count + newest title. Tap → list (title, "Version N", open-comment count, last change).
2. **Open a document.** `POST /mobile/docs/:id/open` body `{}` → `{ url, code, expiresAt }`. On `409 no-stable-origin` retry against the returned lease-holder address. Load `url + "#code=" + code` in a second `WKWebView` (pattern: `ConsoleView.swift`), pinned to that origin; other links open in Safari; app close button. On a page message `doc-session-expired`, call open again and reload.
3. **Signing bridge.** Register a `WKScriptMessageHandler` named `instarSign`. The page posts `{ id, method, path, body }`; the app returns `{ id, headers }` from `AgentClient.authorize` for that exact request (host = the page's origin). Only paths under `/docs/<this id>/` are signed; anything else is refused.
4. **Links in chat.** A message link whose path is `/docs/<uuid>` opens through step 2 instead of the browser.
5. **Push kind `document`.** In `NotifyExtension/NotificationService.swift`, handle `instar.kind == "document"` (`itemId` = docId, `commentKey`, `count`): fetch the text with `X-Instar-Notify-Token` as for other kinds; tapping opens the document at that comment (step 2 with `#comment=<commentKey>` appended after the code).
6. **Owner sharing (owner phone only).** Document screen share sheet: "Only me" / "Choose people…" / "Whole team". Choose people/Whole team runs, with a resumable step state: (a) `POST /mobile/conversations` (name default "<title> (shared)" unless an existing shared conversation is picked), (b) `POST /mobile/team/grants` with the presence key (Face ID), one grant per person or all current people, (c) `POST /mobile/docs/:id/primary { primary }` with the presence key. Before Face ID show: "Everyone in <conversation> will see this document, its earlier versions and its comments." Show the server's refusal text verbatim (system topic, job topic, own conversation, team access off). "Move to conversation…" = step (c) alone.

## Contracts (examples)
- `GET /mobile/docs?conversation=app:3f2…` → `{ "documents": [ { "id": "…", "title": "Onboarding plan", "version": 3, "openComments": 2, "updatedAt": "…", "ownerName": "Justin" } ], "more": false }`
- `GET /mobile/docs/:id/summary` → `{ id, title, version, openComments, myOpenComments, primary: { ref, name }, audience: "Only you" }`
- `POST /mobile/docs/:id/open` → `{ "url": "https://echo.<tunnel>/docs/<id>", "code": "<base64url>", "expiresAt": "…" }`
- `POST /mobile/docs/:id/primary` → `{ "ok": true, "audience": "Everyone in Instar Docs" }`
- Errors: `404 unknown-document`, `403 presence-required`, `409 not-owner`, `409 no-stable-origin`, `503 documents-off`.

## Proof you run (simulator, Studio idle, nice + heavy-work rule)
A `LIVE_PROOF_SCRIPT` UI test against the throwaway development agent I give you (address + pairing code in a Secret Drop):
1. Conversation shows its Documents row; open a document; it renders.
2. Select a passage, comment, Send; the agent's reply appears under the comment.
3. Push of kind `document` arrives and opens at the comment.
4. Owner share sheet: Choose people → conversation created, grant, primary moved; audience text updates.
5. A member device (second simulator pairing) sees the shared document; a guest device can read but the Comment pill is absent.
Record pass/fail per step with screenshots; post a line `DOCS-APP-PROOF:` in your pane and the TestFlight build number when uploaded with `scripts/ship.sh`.

## Done for you
TestFlight build uploaded with 1–6, proof passing. Then I raise the install attention item for Justin.

## Added after round 5
7. **Native composer + Send.** The page posts `{type:"selection", start, end}` over the bridge; the app shows its own sheet (quote cut from the projection it fetched via `GET /docs/<id>/data`, text box). On post, the app signs the operation-specific payload under `instar-docpage-v1` and posts it. The app's own bar has **Send comments to Echo**: it posts the template message through the existing `POST /mobile/chat/:topicId` or `/mobile/chat/app/:key`, then the signed `send` row with that message's `requestId`.
8. **Link a computer.** "Open on a computer" scans the QR code (fingerprint, machineId, host, nonce), shows the fingerprint, asks for Face ID, sets a 30-day expiry itself, and calls `POST /mobile/browsers/link { browserPublicKey, nonce, machineId, host, expiresAt }` with the presence key. People screen lists linked computers with "Forget".
