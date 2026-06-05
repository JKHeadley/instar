# ELI16 — Telegram Reply Robust Content Mode

Agents usually send Telegram replies by pasting the reply into a shell heredoc. That is fine for normal text, but it can break if the reply itself contains the heredoc closing word on its own line.

This change adds a safer backup path. The reply script can now accept base64 text, decode it, and send the original message. That means the shell only sees safe base64 characters, while Telegram receives the real reply text.

Nothing changes for ordinary replies. The normal heredoc command still works, the server route is the same, and the script still builds the same JSON body after it has the final text. The new flag only changes how the text gets into the script.

Existing agents with the standard reply script are upgraded automatically. The migrator recognizes the last shipped script by its hash, backs it up, and installs the new version. If an operator edited the script locally, Instar does not overwrite it. Instead it writes the new version next to it as a review candidate, preserving the local customization.

This matters for agents because reply failures are easy to miss: the user sees silence, while the agent may only see a shell error in its pane. The safer path gives agents a reliable escape hatch for long reports, code examples, JSON snippets, or any text that accidentally contains the heredoc closing line.
