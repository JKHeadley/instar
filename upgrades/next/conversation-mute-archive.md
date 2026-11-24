# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Chats gain per-person mute and reversible archive preferences. Archiving hides a chat from the ordinary list while preserving its history and active session. Muting suppresses eligible reply notifications while account and document notices keep their independent rules. Local save receipts distinguish pending synchronization and unknown delivery support. Typed pending notifications retain their intended reader across device reassignment; unattributable legacy summaries are held safely. Rolling back to an older sender requires disabling push until the guarded sender returns.

## What to Tell Your User

The server can now remember your personal mute and archive choices. Archiving keeps the same chat and its history available to restore. Muting keeps ordinary reply notifications quiet while important account and document notices keep their own rules. The app controls still need their separate update and verification before I can call them ready for you.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Personal chat preferences | Signed POST /mobile/conversations/preferences with a fresh request identifier |
| Reversible archive lists | GET /mobile/conversations with archive=exclude, only or all |
| Truthful save and delivery status | Read local receipt, emission status and delivery support separately |
| Reader-bound pending notifications | Automatic at guarded provider transport; unknown proof holds evidence |

Parent references also retain their exact Slack workspace identity. An unresolved reference cannot silently place a chat under another workspace with the same channel ID. Production initialization tests cover the refusal and exact-parent success.
