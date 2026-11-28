# Tokenless adapters preserve Telegram egress decisions

The authored-text wrapper skips credential lookup when a token is absent or empty. It calls the original send operation in the existing context. Active Telegram egress still rejects the request before the network, and the dashboard keeps the original refusal and saved message. Registered credentials still use the authored capture path. There are no new credentials, permissions, retries or routes.

## 6b. Operator-surface quality

A dashboard refresh with no usable Telegram credential reports the existing hold instead of a generic JavaScript error. It leaves the pinned message unchanged.

## Framework generality

This applies to Telegram adapter and lifeline calls through the shared authored-text wrapper.

## Independent review

Concur. Tokenless calls skip only metadata capture. Active origin egress still returns the hold before contacting Telegram, and registered credentials retain the same capture logic.
