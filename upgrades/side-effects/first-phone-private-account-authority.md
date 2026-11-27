# First-phone private account authority

Adds a dormant coordinator for the private Telegram enrollment callback. It uses the trust journal’s current unwithdrawn Telegram approval-account acceptance and first-device slot, and requires that account acceptance to predate the offered nomination. The caller must separately resolve the independently verified owner, holder and stored offer with a digest recomputed from the current device and policy.

The coordinator records only the nomination and remains unwired in production. Tests exercise missing, late or withdrawn acceptance, missing or changed holder and proposal, and exact retries. No acceptance writer, bot link or production configuration is installed.

Independent review concurred on committed account and slot checks for nomination only.
