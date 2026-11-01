# The Instar app can hold its own conversations, without Telegram

<!-- bump: patch -->

## What Changed

Increment 1 of docs/specs/mobile-native-conversations.md, behind `mobilePairing.native.enabled` (omitted ⇒ the development-agent gate; read at boot; off ⇒ every new route answers 503 and the Telegram chat route is unchanged).

- A conversation store (`AppConversationStore`): one append-only JSONL file per conversation under `.instar/app-conversations/`, immutable events keyed by `eventId`, each line fsynced before anything is dispatched, a torn final line truncated and reported once, a per-file `ingestSeq`, deterministic delivery-state reduction, and a derived SQLite index (WAL) caught up at boot and rebuilt from the files when missing or corrupt. Deleting a conversation moves its file to `deleted/`; nothing is destroyed.
- The `appConversations` replicated-store kind (`app-conversation-event`): every local event is emitted on the replicated-store foundation and peers' events land in the local store, always on whenever native conversations are on.
- Registry: new journal ops `mint-app`, `bind-app`, `unbind-app` (a previous version skips them as unknown ops instead of loading a fake Slack entry), app aliases in an id range disjoint from Slack candidates, and an `'app'` descriptor variant.
- Device-signed routes: `POST/GET /mobile/conversations`, `PATCH/DELETE /mobile/conversations/:key`, `POST /mobile/chat/app/:key`, `GET /mobile/chat/app/:key/messages` (browse) and `/events` (sync). Every mutation is idempotent through the shared request record; a send follows the order look up → exact emergency stop → preflight → reserve → persist → pause intercept → dispatch → delivery event, and a later lookup answers from the current delivery state. Pairing invites and desktop codes are removed by exact match (`redacted: true`); credential-shaped text is delivered unchanged and only flagged (`credentialShaped: true`). Each app message is stored with its device-signature fields; history returns `originVerified: "unknown"` until signed-record checking lands (increment 2), never `verified`.
- The agent answers with the new `app-reply.sh` (`POST /app/session-reply`, bind-token scoped, `409 not-owner` unless this machine owns the conversation), installed by init, by `PostUpdateMigrator.migrateScripts`, at server boot, and tracked by the templates drift verifier.
- With native conversations on, the authentication-time device rate limit no longer applies to the send routes (their own 20-per-minute limit still does), so read polling cannot use up the allowance an emergency stop needs.

## What to Tell Your User

The Instar app can now start its own conversations with me that do not go through Telegram at all. You can give one a title, chat in it, rename it or delete it, and I answer right there in the app. Each message you send from the app is saved together with your phone's signature, so it can be checked later; showing the "signed" mark in the app comes in the next step. For now this is switched on for the development agent only.

## Summary of New Capabilities

- Native app conversations: create, list, rename, delete, send, browse and sync (`/mobile/conversations`, `/mobile/chat/app/:key`).
- `app-reply.sh` and `POST /app/session-reply` for sessions serving an app conversation.
- `appConversations` replicated store kind; `/health` → `appConversations.bytes`, `.count`.

## Evidence

Unit: store (commit and dedupe, torn tail, delivery reduction in every arrival order, out-of-order title resolution, index catch-up and rebuild, 250-message backwards browse, foreign sync cursor, tombstone move, replicated wire round trip), identity (title forgery, exact token removal, `mint-app` replay and snapshot, recording-disabled refusal, previous-version skip), service (create recovery returns the same conversation, send recovery, lease bind/unbind, replicated create gets an alias). Integration: every route through the production auth middleware. E2E: an AgentServer with no Telegram and no Slack pairs a phone, creates a conversation, sends a signed message, the session manager receives the `[app:…]` bootstrap with a scoped bind token, the reply is accepted, history shows both.
