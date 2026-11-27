# Private Slack replies after owner repair

An owner can turn private memory on so shared conversations cannot read the owner's private notes. When the agent's Claude Code is too old, the owner gets a private explanation and a repair link. That link is already shipped: opening it changes nothing, and pressing Fix it selects a working Claude Code while leaving privacy enabled.

The real Slack test found one more problem after repair. The session could read the owner's question and calculate its answer, but its Slack reply helper used a Bash here-string to prepare the message. On the Mac, Bash needs a temporary file for that operation. Private-memory sessions deliberately cannot write to that temporary location. The reply stopped before reaching Slack.

This fix prepares the same JSON using a pipe. It does not make the sandbox weaker or give the channel access to private notes. The message keeps the same text, destination, credentials and delivery safeguards. Existing agents get the corrected helper during their normal update, and customized helpers are still preserved for their owners. Tests run the real helper with regular-file writes denied and verify both ordinary channel replies and session-bound replies.
