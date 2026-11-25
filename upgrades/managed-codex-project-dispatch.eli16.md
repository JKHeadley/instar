# Prepare the startup sequence for managed Codex projects

When Instar starts a managed project worker, it needs to reserve the approved work before starting the worker. After launch, it needs to check that the approval and ownership still match, then bind the exact Codex session to the claim before letting the worker proceed. This change puts those steps in one dispatcher. Two callers asking to launch the same work cannot both start workers.

The tests show what happens when the setting is off and when ownership changes while the worker is starting. In the second case, the dispatcher keeps the refusal record and asks the launcher to cancel the pending worker. This change has no normal production caller. The project authority and launcher still need to supply their verified implementation before Instar can enable live project continuation.
