# See whether a scheduled job is running as expected

A job can be switched on without having a recorded run. Today the Jobs screen cannot always tell you why. The job might be new, paused, assigned to another computer, or missing older records. A run started by hand can also appear beside the schedule even though it says nothing about whether the scheduled job ran.

This change adds a short explanation to the Jobs screen. It checks the loaded schedule independently of the jobs themselves, so the screen can show that a scheduled time passed even when the scheduler did not make progress. When the server can verify what happened to that particular scheduled opportunity, it shows the recorded start, result, or skip. Where the records cannot establish what happened, it says so. A sleeping or unreachable computer shows unavailable coverage.

The first release focuses on what the current server can observe since it started. It does not assign missed runs to gaps in old history. When a computer restarts or takes over a job, the screen rebuilds what it can see and labels the gaps. The existing Jobs permissions still determine what each person can see.

The observer does not launch, retry, pause, or change jobs, and it sends no alerts. Rollout checks the real screen with a stalled scheduled callback, a healthy run, and a manual run so the owner can verify what the screen can prove.

A job runs a repeated check. A finite project has a finish, such as replacing a full drive. A standing project holds an ongoing responsibility such as Machine Stewardship. Its checks can be jobs, and an accepted follow-up can be a finite project. A successful review does not mean the drive is healthy.
