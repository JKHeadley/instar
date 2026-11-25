# Verify Studio Conversation Recovery After a Release

After installing the Studio recovery release, run this local check with the installed version, the machine identity, and the deployment time. It reads the running version, the installed hook settings and recent recovery records.

The check looks for a new Claude Code compaction with its recovery block and completion event. For Codex, it looks for a new compaction that received a recovery packet and an acknowledgment for that same packet. Test compactions, earlier records and results from another machine are excluded.

The output tells the person doing the verification which evidence was observed and which is still pending. Both engines must have evidence for the check to pass. The existing canary still controls automatic shortening. The script reports a bounded observation from recent history, so run it after the first new recoveries appear.
