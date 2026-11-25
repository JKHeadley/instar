# Bind Codex project work before continuation is allowed

A project worker can reach its first Stop callback before Instar has verified its native Codex identity. Instar needs to remember that the launch is managed during that gap, so the callback cannot accidentally use an ordinary task list. This change adds an internal startup record that reserves the work before launch and binds it to the native identity once the launcher confirms it.

The original launch identity stays available for pause and completion. The native identity is used for continuation decisions. A different session cannot take the same record, and a failed launch stays ineligible for a directive. The disposable lifecycle test now uses this startup sequence with a real Codex worker while exercising both positions of the off switch. Normal startup still needs the live project admission provider before this can apply to existing agents.
