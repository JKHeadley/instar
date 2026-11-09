# Snapshot failure log, readable — plain-English overview

When Echo reads the operator's Telegram page and the read fails, the caller gets a short "unavailable" answer on purpose, with no internal details. An hour ago I changed the server so it would at least write the real reason into its own log. When I checked that log on the live server, the line said "[object Object]" where the reason should be. The server's logging layer prints a bundle of details that way, as a placeholder, instead of the details themselves.

This change writes the reason as one plain line of text instead: which Telegram profile was being read, what kind of error it was, and the error's own short message, cut to 200 characters. Nothing else changes. The caller still sees the same short "unavailable" answer, and no detail is sent back over the network.

Why it matters: the snapshot read can fail for several different reasons. The browser can be paused after a Telegram update, the calling session's credential can be out of date, or the page can be on a version nobody has reviewed yet. Without the reason in the log, every one of these looks the same, and finding the real cause means guessing. Today that guessing cost a round of checking against the stored recovery state. With a readable log line, the next failure names its own cause.

Risk is minimal. It is one line of log text, the tests check the exact format, and a revert undoes it completely.
