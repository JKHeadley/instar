# Conversations Explain When The List Is Still Loading

Opening Conversations could leave the list blank while the agent was answering. If that read failed, there was no button to try the list again. Some temporary failures even said Conversations was switched off. A filtered page containing no rows could also say there were no conversations at all, although more pages were available.

This repair gives the list an immediate loading message, a clearer explanation after ten seconds and a retry button after failure. A read that does not finish reaches a recoverable deadline instead of leaving the list stuck. Known conversations stay on screen during a refresh failure. Empty pages with a next-page cursor explain that more pages are available; a genuinely empty list points to New conversation. Pinned conversations remain visible even when the ordinary page has no rows.

Only an explicit feature-off answer uses switched-off wording. When that answer arrives after a list was already loaded, the list is clearly described as the last loaded copy and its unavailable actions are disabled. A successful later read restores them. Retrying only reads the list. It never sends a message, starts enrollment or approves anything.

The repair also keeps older reads from overwriting newer results or affecting a rebuilt page. If a list read times out during a browser-status check, its late answer cannot tear down the recovered list or remove a newer device record. A current, authoritative revocation still removes the key as before. Keyboard focus remains useful while retrying and returns to the recovered list. Tests and local browser examples use invented data; complete verification and release remain separate from this source repair.
