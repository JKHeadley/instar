# Gemini final pane replies now reach Telegram

Gemini can finish a Telegram task by printing the final answer in its terminal pane without running the Telegram reply script. That is exactly the bad user experience: the work is visible in the live pane, but Telegram stays silent.

This change gives the session monitor a Gemini-specific fallback. When a Gemini topic has an unanswered Telegram message, the monitor looks for Gemini's completed assistant block: a line beginning with `✦`, followed later by Gemini's normal input footer. Only then does it treat the block as the reply and send it to the Telegram topic.

The guard is intentionally narrow. It only runs for `gemini-cli` sessions with a pending Telegram injection, only considers text after the matching `[telegram:N]` prompt, and only fires after Gemini has returned to the input/footer state. Claude and Codex keep their existing reply-script and transcript paths.

Respawn-context note: after the server restart, the durable pieces survived: the Telegram history preserved the cycle id and repro, and the `gemini-final-output-relay` worktree survived cleanly. What had to be re-derived was the in-memory claim-check trail: which exact source files owned final relay, completion detection, and Gemini pane parsing.
