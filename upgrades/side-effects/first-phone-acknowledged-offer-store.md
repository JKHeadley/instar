# Durable acknowledged first-phone offer

Adds a dormant SQLite store for the exact private disclosure acknowledgement. The store keeps the callback digest, acknowledged chat and message, exact proposal and slot, paired device, issuing holder, and validity window. It refuses changes to an existing callback and refuses a second callback for the same acknowledged message. Reads expose only committed rows.

The production sender and holder do not use this store yet. No live offer is issued, and the raw callback token is not stored. The resolver still checks current authority and expiry before any nomination may be captured.

Independent review concurred. A production database must be scoped to the issuing bot and opened with the holder’s crash durability settings.
