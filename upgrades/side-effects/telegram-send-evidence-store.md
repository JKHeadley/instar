# Original Telegram evidence storage

This dormant store records a canonical Telegram polling reference and digest. A duplicate is idempotent. A conflicting digest permanently disqualifies the reference without replacing its original digest.

- Authority. Authentication and owner resolution belong to the caller. The lookup answers whether committed evidence currently matches. It cannot authorize a send or replace the atomic effect-boundary check.
- Data. The reference contains the bot, chat, topic and message identifiers. The store retains no message body or credential.
- Durability. Capture refuses nested transactions, and a lookup cannot expose uncommitted state on the supplied connection. Deployment requires a crash-durable database and a serving-writer rule.
- Rollback. No production caller or installed schema change exists.

Independent review concurred for the dormant store. Activation must account for edited or disqualified updates that the strict parser could refuse before the store sees a digest.
