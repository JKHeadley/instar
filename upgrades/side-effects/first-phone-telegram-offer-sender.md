# Private Telegram sender for first-phone enrollment

The sender uses the configured bot and normal Telegram delivery path. It requires the requested chat to match the verified owner before sending, preserves the disclosure as plain text and returns a receipt only for the exact text in the same verified private chat with a positive message ID and the exact Accept button. It checks the owner again after the API call. An unavailable or mismatched receipt cannot register an offer through the coordinator.

This checkpoint adds an adapter method without connecting it to production issuance. Verification uses a synthetic bot acknowledgement. No Telegram offer was sent.
