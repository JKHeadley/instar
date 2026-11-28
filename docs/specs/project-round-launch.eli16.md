# Project rounds use the project's saved model

An Instar project can run a group of related items as a round. The round uses the conversation tied to the project. Today the runner always tries Claude. It can do that even when the conversation says to use Codex. If the process stops before it gets any work done, the project shows a failed round and does not say why.

The fix reads the same framework and model setting that the project conversation uses. It reuses the normal launcher to pick the command and the account. If that launch is unavailable, the round records that it could not start. When a child runs, the round records its exit code or signal and keeps the diagnostic message locally, after masking recognized credentials. The record also says when the diagnostic was too large or incomplete to keep. That gives the person reviewing the round a way to tell a failed test from a missing login or a process that never started.

The fix keeps the existing approvals and project evidence rules. Some Claude profiles require an interactive subscription session. The direct round launcher records that limitation instead of moving the work to a different billing account. The code is tested with local fake child processes that exercise the same launcher and project read.
