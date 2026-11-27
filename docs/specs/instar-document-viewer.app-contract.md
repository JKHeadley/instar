# Instar Documents — app contract answers (for echo-instar-app, 2026-11-10)

Answers to DOCS-APP-ACK questions 1–6. These are binding for both the server (built by Echo on the M5) and the app.

1. **Approval.** Yes: `approved: true`, Justin, Telegram topic 141469, message 141587, 15:19 PST. Build now.

2. **`instar-docpage-v1` signed string**, signed with the **device key** (never the presence/Face ID key):
   ```
   instar-docpage-v1\n{deviceId}\n{host lowercased}\n{docId}\n{op}\n{requestId}\n{timeMs}\n{sha256hex(canonicalPayload)}
   ```
   - `op` ∈ `comment | reply | resolve | reopen | edit | reanchor | send | open`.
   - `canonicalPayload` = JSON with keys sorted, no whitespace, of the op's fields (spec §3.6): `comment {docId, commentId, onVersion, start, end, bodyHash}` (`onVersion` is the version's id, the `versionId` from the summary or page data, not its label), `reply {docId, commentKey, replyId, bodyHash}`, `resolve|reopen {docId, commentKey}`, `edit {docId, commentKey, bodyHash}`, `reanchor {docId, commentKey, onVersion, start, end}`, `send {docId, batchId, commentKeysHash, primaryRow, messageRequestId}`, `open {docId}`.
   - Hashes: the app mints a random 16-byte hex `salt` per text, computes `sha256hex(salt + "\0" + text)` (UTF-8), and sends `{salt, text}` blobs in the request body next to the signed payload. The server recomputes and refuses a mismatch.
   - `start`/`end` are offsets in the version's plain-text projection (the page reports them). The server cuts the quote itself from that version, so the app never sends quote text.
   - `requestId` = `<13-digit ms>-<uuid v4>`, unique per device; used once.
   - Headers: `X-Instar-Device`, `X-Instar-Device-Time` (= timeMs), `X-Instar-Docpage-Sig` (base64url DER, low-S), `X-Instar-Docpage-Payload` (base64url canonicalPayload), `X-Instar-Request-Id`.
   - Accepted only on `POST /docs/{docId}/…` page write routes for that same `docId`. No other route accepts this domain, and the app refuses to sign anything else.

3. **Host.** Yes. The host in the signed string is the origin the document page was opened on, which `POST /mobile/docs/:id/open` returned. The server accepts it when it is one of this machine's own names (the same own-names check the multi-route device signatures use), not only the paired host.

4. **No stable origin.** Changed in the approved spec: there is no lease-holder retry. `open` is always served by the machine the phone talks to. With no named tunnel the answer is a final `409 documents-need-a-named-tunnel` with a `detail` sentence; show it as-is ("Documents need a permanent address for your agent. Turn on a named tunnel in Settings.").

5. **Grants.** `POST /mobile/team/grants` already exists (`src/server/teamRoutes.ts:491`): it is the same Face ID-signed team-log request your team screens already send, `{ events: [{ type: "grant", personKey, ref, access: "read" | "use" }] }`. `ref` is `telegram:<id>` or the bare app conversation uuid. Reuse your existing call. Moving a document is new, in two device-signed calls (owner phone only):
   - `POST /mobile/docs/:id/primary/challenge { primary, docDeps }` → `{ challenge, expiresAt }`. `docDeps` is exactly the `heads` from `GET /mobile/docs/:id/summary` that you showed in the share sheet.
   - After Face ID, `POST /mobile/docs/:id/primary { primary, docDeps, challenge, presenceSig }`, where `presenceSig` is the presence key's signature over `instar-permission-action-v1\n{deviceId}\n{host}\n{challenge}\ndocs-primary-set {docId} {primary} {sha256hex(canonicalJson(docDeps))}`. Send the body bytes exactly as signed by the device key: the server stores that whole device-signed request in the row so every machine can check it. → `{ ok, primary }`. `409 document-changed` means the document changed since the summary: re-read and ask again. `409 once-shared-stays-shared` means a shared document can't move back to a private conversation.

6. **Push.** `instar.kind = "document"`, with `itemId` = docId, `commentKey`, `count`, next to the usual `agentId`, `deviceId` and `machine` inside `instar{}`. The alert body is fixed: "New answers to your comments". Fetch the title for the notification with the device-signed `GET /mobile/docs/<itemId>/summary` (as the chat preview route is device-signed); tap → open the document at `#comment=<commentKey>`.

7. **Page ↔ app bridge (replaces brief item 3's `instarSign`).** Register one `WKScriptMessageHandler` named `instarDocs`. The page never sends a method or path; the app builds every request itself, only for the opened document, host pinned to the origin `open` returned.
   - Open: load `url#code=<code>` (add `&comment=<commentKey>` to focus a thread). The page trades the code for its read cookie and removes the fragment. Re-mint with `open` when the page reports `{type:'expired'}`.
   - Page → app: `{type:'ready', docId, title, openComments}` · `{type:'selection', docId, start, end}` (show your native sheet; cut the quote from the `projection` field of the device-signed `GET /docs/<id>/data` at those offsets) · `{type:'write', id, op, docId, fields, text?}` for `reply | resolve | reopen | edit` from a thread (sign it under `instar-docpage-v1` with the payload fields in item 2, salted blob for `text`, POST `/docs/<docId>/w/<op>` with `X-Instar-Request: 1` and body `{blobs:[{salt,text}]}`) · `{type:'expired'}`.
   - App → page: `window.dispatchEvent(new CustomEvent('instar-docs', {detail}))` with `detail` = `{type:'write-result', id, status, body}` · `{type:'refresh'}` (after your own comment or Send) · `{type:'focus-comment', commentKey}`.
   - Writes: `POST /docs/<docId>/w/<op>` where `op` ∈ `comment | reply | resolve | reopen | edit | reanchor | send`. `comment` → `201 {key}`. `send` payload is `{docId, batchId, commentKeysHash, primaryRow, messageRequestId}` (`primaryRow` from `GET /mobile/docs/<id>/summary` → `primary.primaryRow`); `409 document-moved` means show "This document moved while sending. Send again."
   - Send template (your bar): `I left N comments on "<title>" (version <label>): <origin>/docs/<id>` through the existing chat send route with `requestId` = `batchId` (both are `<13-digit ms>-<uuid v4>`: the chat routes and the send row accept only that form), then the signed `send` op with `messageRequestId` = that same id and `commentKeysHash` = sha256hex of the JSON array of your open (unresolved) comment keys, sorted. `409 comments-changed` means re-read the page and retry once.

The page routes (open, session, page-data, signed writes), the move and the `document` push are built and tested on branch `echo/doc-viewer-141469` (`src/server/documentPageRoutes.ts`, `tests/integration/documents-page.test.ts`). I'll send the dev agent address and a pairing code by Secret Drop when they're live.

8. **Answers to DOCS-APP-GAPS (v5).**
   1. Moving: item 5 above (no separate action names; the challenge route binds the action, and `docDeps` is the summary's `heads`). Linking a computer is not Face ID-signed to the server: the app asks Face ID locally, then sends the device-signed `POST /mobile/browsers/link` (item 9).
   2. The app never reads `page-data` (the read cookie lives in the web view). Use the device-signed `GET /mobile/docs/<id>/summary`: `myOpenCommentKeys` (sorted; hash these for `commentKeysHash`), `version` (the label number), `versionId`, `primary.primaryRow`, `heads`.
   3. `GET /docs/<id>/data`, device-signed (it is in the device allowlist): the projection text is the string field `projection`. Don't use the page cookie.
   4. Push preview: the device-signed summary (item 6).
   5. Linked computers: `GET /mobile/browsers` → `{ browsers: [{ id, host, fingerprint, linkedAt, expiresAt }] }`; forget with `POST /mobile/browsers/<id>/forget` (both device-signed by the person's phone).
   6. QR text: `instar-link:1:` + base64url(JSON `{ k: browserPublicKey, n: nonce, m: machineId, h: host }`). Show the fingerprint you compute from `k` exactly as the page does: the first 16 hex characters of sha256(raw key bytes), uppercase, in groups of four joined by `-` (e.g. `3F2A-91C0-7B44-0D1E`). No fingerprint travels in the QR.
   7. A shared document stays shared (spec §3.1). "Only me" on a shared document should say: "A shared document stays with the people of this conversation. You can move it to another shared conversation." and offer no private move.

9. **Linking a member's computer (spec §3.6a).** Device-signed `POST /mobile/browsers/link { browserPublicKey, nonce, machineId, host, expiresAt }` from a member's or guest's phone after local Face ID; `expiresAt` is set by the phone, at most 30 days ahead. The server checks the nonce was issued on this machine for that key, then answers `201 { id, host, scope, expiresAt }` (`scope`: `documents` for members, `documents-read` for guests). `409 browser-link-limit` = 3 linked computers already; `429` = 4 links in the last hour. Send the request to the machine named by `m` (the QR's host `h`).

10. **Answers (v6).**
    - Push title: the notification extension may call `GET /mobile/docs/<itemId>/summary` with the notify token (headers `X-Instar-Device` + `X-Instar-Notify-Token`, no signature), exactly like the chat preview. With the token it answers `{ id, title }` only. The title never travels through Apple.
    - Shared or private: read the summary's `shared` boolean (true once the document has ever had a conversation with anyone besides the owner; such a document stays shared). Don't infer it from wording.
    - Computer link host: yes. `h` is the host the server itself answered the page's nonce request on, and it only answers on one of its own names (the named tunnel's host, or `localhost:<port>` for a computer on the agent's own machine). Send the link to `https://<h>` (or `http://` for a loopback host).

11. **Who asked for the link code (v7, from the computer-link review).**
    - Before Face ID, the app calls the new device-signed route `POST /mobile/browsers/link/lookup { nonce, browserPublicKey }` (members and guests). It answers `200 { state: "waiting", fingerprint, host, expiresAt, requester }`. An expired code, or one for a different key, gets `410 link-code-expired`; an owner phone gets `403 member-phone-required`.
    - `requester` is `{ address: "203.0.113.7", browser: "Chrome on macOS", at: "<ISO time>", agoSeconds: 120 }`. `browser` comes from a fixed word list, never the raw User-Agent. The `201` from `POST /mobile/browsers/link` carries the same `requester`.
    - Show it above the fingerprint: "A computer using Chrome on macOS asked 2 minutes ago (203.0.113.7)", and the line "Only scan a code shown on a computer in front of you."
    - A caller may hold at most 3 waiting codes (`429 too-many-codes` to the page, not the phone).

12. **Development agent on loopback (test only).** With `documents.loopbackOrigin: true` in the dev agent's config, `POST /mobile/docs/:id/open` sent to `http://127.0.0.1:<port>` (or `localhost:<port>`) of that server, from the same machine with no forwarding header, returns that `http://` origin instead of `409 documents-need-a-named-tunnel`. The page cookie drops `Secure` on that origin only. Off by default and never written by updates.
