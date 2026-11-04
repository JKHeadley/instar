# Standby Telegram replies

## What Changed

A session on a standby machine can send a Telegram reply through the machine holding Echo's lease. The forwarding design and lease fence already existed, but a reply that was held and later recovered could reach Telegram without appearing in the session machine's topic history. Worse, the standby could label an operation "delivered" from a forwarded receipt that contained no Telegram message ID. The holder's receipt and the standby's outcome now require the actual Telegram ID. When a held reply later succeeds, the standby records that ID and text in the topic history without sending a second copy. If the lease changed while it waited, recovery follows the replacement operation. An uncertain send stays unknown and is never resent blindly.

The lease holder still performs the outbound policy checks. The standby's recovery only records confirmed delivery; it does not grant itself permission to send. The observed Mama PC operation `afe843bf` previously said delivered with no ID while the Studio had Telegram ID 1508. This change closes that false answer. A live reply from Mama PC remains the final verification after the release reaches that machine.

## What to Tell Your User

Replies from a standby are forwarded through Echo's connected machine. A delivered answer now includes Telegram's message ID and appears in the topic history. If delivery cannot be confirmed, Echo says unknown and does not send a duplicate.

## Summary of New Capabilities

- Confirmed held replies add a topic history row after delivery.
- Delivery outcomes require a real Telegram message ID.
- Recovery follows a lease transfer without breaking the one-voice fence.

## Evidence

Before: on 2026-11-03, Mama PC reported operation `afe843bf-6143-4fe8-b61f-4ffcca96c85f` delivered with `messageIds: []`; Studio reported the same operation delivered with `messageIds: ["1508"]`. After: unit tests cover missing IDs, valid IDs, duplicate acceptance refusal, and history logging. The signed-mesh integration suite covers standby delivery, holder refusal, lease transfer, and unknown transport outcomes. Live standby verification awaits rollout and is not claimed here.
