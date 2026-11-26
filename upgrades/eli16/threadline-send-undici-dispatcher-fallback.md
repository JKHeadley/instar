# Sending a Threadline message works again on Node 26

On a computer running Node 26, every Threadline message sent from an MCP session failed with "Failed to reach agent server", even though the agent server was running fine. The sending code handed Node's built-in fetch a connection pool from a separately installed copy of the same networking library. Node 26 bundles a newer version of that library and refuses the older pool before it even opens a connection.

When that refusal happens, the message is now sent once more using Node's own default connection pool, and the process remembers to skip the refused pool from then on. Nothing was sent on the refused attempt, so a message is never delivered twice. This is the same fix Telegram sending already had. Nobody needs to do anything when upgrading.
