# Message your agent from the Instar iPhone app

<!-- bump: patch -->

## What Changed

An active paired phone can send a message into a topic: `POST /mobile/chat/:topicId` with `{ text, requestId }`, device-signed only (a Bearer token gets 403). The message enters the same inbound handler as the owner's Telegram message (emergency stop and pause, exactly-once ledger, observers, a2a hook, history, delivery), with the owner's identity, and is mirrored into the Telegram topic as "📱 <owner> (from the app): …". It never binds the topic operator, never stamps serve progress, and its history row records `via: "mobile-device"` with forwarded unknown, so it never counts as standing-authorization evidence. Pairing invites, `/desktop` codes and credential-shaped text are refused from the app (422). Each `requestId` is recorded before delivery and answered from that record on retry, so a retry never delivers twice; an interrupted request answers `outcome-unknown`. Only the serving-lease holder accepts app messages (`409 not-serving`). `GET /telegram/topics/:topicId/messages?scope=pool` merges history across machines. The lifeline route's behavior is unchanged. Gate: `mobilePairing.chat.enabled` (omitted ⇒ follows `mobilePairing`, development-agent gated).

## What to Tell Your User

Once your phone is paired, you can type a message to me in the Instar app and I get it just as if you had sent it in Telegram. A copy shows in the Telegram topic with a 📱 mark. Stop commands work from the app too. For passwords and keys, use a Secret Drop link instead; the app refuses them.

## Summary of New Capabilities

- Chat from the Instar iPhone app as the owner (`POST /mobile/chat/:topicId`).
- Topic history across machines (`GET /telegram/topics/:topicId/messages?scope=pool`).

## Evidence

Spec converged at the 6-round cap with GPT-6 Astra and internal reviewers. Tests: 8 unit (request record: repeats, in-flight, restart, failed write, age window, no stored text), 12 integration through the real inbound handler (owner identity and label, one history row, mirror, retries, concurrent retries, emergency stop once, refusals, lease, rate, gate, lifeline path unchanged, pool history merge), and the production-boot check.
