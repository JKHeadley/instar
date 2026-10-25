# Outage notice permission: bot-compatible engineering correction

Status: implemented; 50 focused tests passed; full suite and production activation remain separate; no production activation or deployment. The unnecessary approval question was withdrawn on 2026-09-06 after checking the original authorization. No new user reply or elapsed-time approval is claimed.

The approved user behavior is to hold messages when durable origin recording
fails and notify the user. The draft added a stronger rule in N5/N6: before an
outage notice, positively observe recipient Telegram mute/archive/deletion and
notification opt-out state. Bot-only deployments cannot supply this observation. Requiring it would defeat the authorized notification behavior. This was an assistant-authored implementation overconstraint, corrected without manufacturing personal-policy permission.

## Evidence

- `TelegramOriginBoot.ts` now defaults to `OriginNoticePolicyObserver`, shared by main and Lifeline. It reads the existing config, real encrypted-secret authority, and operator-hub files independently of the recording workers, checks current ownership and exact runtime credential binding, and exposes only a memory projection at fire time. Secret resolution runs in a bounded separate worker; config/vault/key-file changes invalidate observations, and unchanged cached merges cannot renew freshness.
- `TelegramAdapter.ts` describes topic mute as client-side. Its inbound lifecycle
  does not maintain a complete authoritative archive/deletion/mute projection.
- Telegram conversations are intentionally outside `ConversationRegistry`.
- Batcher quiet-hours and enabled settings do not govern immediate notifications.
- `messageOrigin.outageNotice.enabled` is the explicit application permission: default on, false preserved by idempotent migration. Fresh and migrated agent awareness explains the setting.
- `TelegramWebKDriver` has no typed dialog/notification/topic policy reader.

Telegram offers user-account APIs, not Bot API equivalents:
[account.getNotifySettings](https://core.telegram.org/method/account.getNotifySettings),
[inputNotifyForumTopic](https://core.telegram.org/constructor/inputNotifyForumTopic),
[messages.getPeerDialogs](https://core.telegram.org/method/messages.getPeerDialogs).
Missing mute fields may inherit defaults; they are not proof of an unmuted state.
[Notification settings schema](https://core.telegram.org/constructor/peerNotifySettings).
Dialog folder 1 is the user's archive: [folder semantics](https://core.telegram.org/api/folders).
Topic existence needs a layer-compatible lookup; the current method name differs
from older Web K layers: [forum lifecycle](https://core.telegram.org/api/forum).

## Implemented contract for bot-only support

N5/N6 now specify this application contract:

> On recording failure, the pre-recorded outage notice may use only the configured
> operator alert hub, with current Instar application notification permission and
> credential ownership. The application permission defaults on with this feature
> and has an explicit opt-out. The independent projection carries its actual source
> version and expiry, valid for at most 30 seconds; lost observer health or known
> revocation suppresses sending. Telegram applies each recipient's personal mute
> and archive behavior. Instar does not claim to have inspected those private
> settings. A configured hub is not a delivery receipt or proof that the topic
> still exists; the one permitted network attempt records its concrete result or
> uncertainty, with no fresh attempt after ambiguous acceptance.

A muted or archived conversation can still receive a message under this revision.
The client controls presentation and archive behavior. This corrects the draft to implement the originally authorized hold-and-notify behavior. It does not assert that Telegram delivered the message or notified the client.

## Optional future alternative: inspect personal client state

Add a typed, account-bound, read-only policy reader to the existing browser broker,
resolve inherited notification settings, verify exact account/chat/topic, and
carry source freshness through main/Lifeline IPC. Add explicit application
outage-notification preference. Do not query the failed origin store or remote
Telegram at fire time. Account-reader failure invalidates its projection.

Bot-only agents cannot establish that optional stronger proof. It is not required by the corrected acceptance contract.
Neither alternative changes the always-record rule or grants a retry after an
uncertain external acceptance.
