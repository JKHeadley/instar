# Preview Job Definition Migration

Instar has an old file that lists jobs and a newer folder with one definition per job. The same job can be in both places. Today, the scheduler usually uses the newer definition when it can load it. That can hide a difference in when the job runs, whether it is enabled, or what it actually does. The Jobs screen can already point out missing files, but it does not explain which definition would matter to a migration.

This proposal adds a private preview for the owner. It shows jobs that agree, jobs that are present in only one place, and jobs that need investigation. If a file changes during the check or another machine has not been checked, the preview says what is missing. It reports the type of difference without showing private instructions, credentials or command details.

Opening the preview leaves every job as it was. A later, separately reviewed migration would need to prove that the effective definitions and their behavior carry over. Restoring an old backup would also require a fresh check before an old definition could be used again.
