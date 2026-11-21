# A brand-new agent no longer says it is unhealthy for things it does not use — plain-English overview

**What went wrong.** During the Windows test run, a brand-new agent made by the Windows app reported "Health: Degraded" from its first minute, and about an hour later added "Scheduled jobs keep failing". Nothing was actually wrong, and nothing the person could do would have fixed it. Two features that the agent does not use were reporting themselves as broken.

The first is a recovery feature for agents spread across several computers. One of its routes reaches a stuck computer over SSH, a standard way of logging into a machine remotely. It needs an SSH server on the computer. The app's agents run in a small Linux system that has no SSH server at all, so the feature could never apply there, but it reported "cannot read the SSH key" as a fault, and any fault turns the health status to "degraded".

The second is a job that runs every 15 minutes to refresh the dashboard link pinned in the agent's Telegram chat. App-made agents do not use Telegram; they talk through the app. The job asked the agent's server to refresh a Telegram message that did not exist, got an error back, and counted it as a failure, four times an hour, until the "jobs keep failing" warning appeared.

**What changes.** If a computer has no SSH server key file at all, the SSH recovery route is now recorded as "not applicable" on this machine, not as a fault, so health stays "ok". The agent's safety-feature list shows that verdict. If the key file is there but cannot be read, that is still a real problem and is still reported as before. For the dashboard link job, when Telegram is not set up for the agent, the server now answers "skipped, Telegram is not set up", and the job finishes cleanly instead of failing. If Telegram is set up but is not working, that is still reported as a failure, as before.

**What does not change.** Agents that use Telegram refresh their dashboard link exactly as before. Agents with an SSH server read their key exactly as before. Every other health check is untouched. Existing agents get both fixes by updating; no settings need changing, because the job's script already treats a "skipped" answer as success.

**Safeguards.** Both changes only stop a false alarm in a case where the feature cannot apply. The real failure cases have tests that check they still report. Reverting the one commit restores the old behaviour, with nothing to repair.

**What you need to decide.** Nothing.
