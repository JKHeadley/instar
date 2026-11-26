# A waiting restart pauses new verifies, and closed pull requests are skipped — plain-English overview

**What went wrong (1).** The local verifier runs the full test suite on each of our pull requests before it may merge, one at a time, from a queue. When the auto-updater installs a new instar version, the server has to restart to use it, and that restart waits while a verify is running (stopping a run halfway would waste it). There was already a rule meant to stop that wait from going on forever: while an update is waiting only on the verifier, the verifier starts no new run, so the current one finishes and the restart happens. But the rule looked at the wrong field. The moment the new version is installed, the updater clears its "an update is pending" field and keeps a separate "restart is waiting" record instead. The verifier only looked at the first field, saw nothing pending, and started the next pull request seconds after each one ended. The updater checks again every five minutes and kept finding a fresh run in progress, so a release only took effect when the queue happened to empty (on 2026-10-25 version 1.3.1429 sat installed but not running for hours).

**What changes (1).** The "restart is waiting" record now counts as an update waiting. So when the restart is waiting only on the verifier, the run in progress finishes, no new one starts, the restart goes ahead, and the queue picks up again after the server is back. The existing safety limits stay: if anything else is also delaying the restart (an active conversation, another hold), the verifier keeps working as before, and after two hours of waiting it resumes starting runs anyway.

**What went wrong (2).** A pull request could sit in the queue after it had already been merged or closed, and the verifier would still spend about 18 minutes testing it. On 2026-10-25 four already-merged pull requests were waiting their turn.

**What changes (2).** Asking the verifier to check a pull request that is no longer open now gets a clear "pr-closed" answer instead of a place in the queue, and any place it already had is given up. And right before starting a pull request that has been waiting a while, the verifier asks GitHub whether it is still open; if GitHub says it is closed, it is taken out of the queue (and the audit log says so). If GitHub cannot be reached, nothing is dropped.

**Rollback.** Revert the commit. There is no stored state or migration.

**What you need to decide.** Nothing.
