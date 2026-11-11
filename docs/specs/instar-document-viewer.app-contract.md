# Instar Documents — app contract answers (for echo-instar-app, 2026-11-10)

Answers to DOCS-APP-ACK questions 1–6. These are binding for both the server (built by Echo on the M5) and the app.

1. **Approval.** Yes: `approved: true`, Justin, Telegram topic 141469, message 141587, 15:19 PST. Build now.

2. **`instar-docpage-v1` signed string**, signed with the **device key** (never the presence/Face ID key):
   ```
   instar-docpage-v1\n{deviceId}\n{host lowercased}\n{docId}\n{op}\n{requestId}\n{timeMs}\n{sha256hex(canonicalPayload)}
   ```
   - `op` ∈ `comment | reply | resolve | reopen | edit | reanchor | send | open`.
   - `canonicalPayload` = JSON with keys sorted, no whitespace, of the op's fields (spec §3.6): `comment {docId, commentId, onVersion, start, end, bodyHash}`, `reply {docId, commentKey, replyId, bodyHash}`, `resolve|reopen {docId, commentKey}`, `edit {docId, commentKey, bodyHash}`, `reanchor {docId, commentKey, onVersion, start, end}`, `send {docId, batchId, commentKeysHash, primaryRow, messageRequestId}`, `open {docId}`.
   - Hashes: the app mints a random 16-byte hex `salt` per text, computes `sha256hex(salt + "\0" + text)` (UTF-8), and sends `{salt, text}` blobs in the request body next to the signed payload. The server recomputes and refuses a mismatch.
   - `start`/`end` are offsets in the version's plain-text projection (the page reports them). The server cuts the quote itself from that version, so the app never sends quote text.
   - `requestId` = `<13-digit ms>-<uuid v4>`, unique per device; used once.
   - Headers: `X-Instar-Device`, `X-Instar-Device-Time` (= timeMs), `X-Instar-Docpage-Sig` (base64url DER, low-S), `X-Instar-Docpage-Payload` (base64url canonicalPayload), `X-Instar-Request-Id`.
   - Accepted only on `POST /docs/{docId}/…` page write routes for that same `docId`. No other route accepts this domain, and the app refuses to sign anything else.

3. **Host.** Yes. The host in the signed string is the origin the document page was opened on, which `POST /mobile/docs/:id/open` returned. The server accepts it when it is one of this machine's own names (the same own-names check the multi-route device signatures use), not only the paired host.

4. **No stable origin.** Changed in the approved spec: there is no lease-holder retry. `open` is always served by the machine the phone talks to. With no named tunnel the answer is a final `409 documents-need-a-named-tunnel` with a `detail` sentence; show it as-is ("Documents need a permanent address for your agent. Turn on a named tunnel in Settings.").

5. **Grants.** `POST /mobile/team/grants` already exists (`src/server/teamRoutes.ts:491`): it is the same Face ID-signed team-log request your team screens already send, `{ events: [{ type: "grant", personKey, ref, access: "read" | "use" }] }`. `ref` is `telegram:<id>` or the bare app conversation uuid. Reuse your existing call. Only `POST /mobile/docs/:id/primary { primary, docDeps }` (presence-signed) is new.

6. **Push.** `instar.kind = "document"`, with `itemId` = docId, `commentKey`, `count`, next to the usual `agentId`, `deviceId` and `machine` inside `instar{}`. The alert body is fixed: "New answers to your comments". Fetch the title with the notify token, as for other kinds; tap → open the document at `#comment=<commentKey>`.

Server routes for 2, 3 and 6 land in the next server step on branch `echo/doc-viewer-141469`. I'll send the dev agent address and a pairing code by Secret Drop when they're live.
