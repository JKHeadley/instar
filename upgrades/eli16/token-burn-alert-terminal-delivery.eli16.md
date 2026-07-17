# Token-burn alert terminal delivery — plain-English overview

The token-burn monitor can send warnings to a dedicated Telegram topic. If that
topic was deleted, Telegram returned “thread not found,” but the old sender only
logged the failure. The next monitoring interval tried the same dead destination
again, allowing the failure to repeat forever without a visible explanation.

The sender now distinguishes a permanently missing topic from an ordinary
network problem. A missing topic is retired and remembered on disk, including
across restarts. The failed warning and one explanation go to the agent's
existing Attention queue, which is durable and can recreate its own Telegram
hub. A newly configured topic is still tried normally.

Temporary network failures are not called permanent and are not immediately
duplicated, because Telegram may have accepted a message before the connection
failed.
