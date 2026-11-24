# ELI16: the dashboard's file editor can't change the files that decide what runs (SEC-144)

The dashboard has a file editor, so you can read and fix the agent's files from your phone. A few files are too powerful to edit that way, because changing them changes what programs the agent runs, so the editor refuses to save them. That list already had the old hook folder, the scripts folder and the main settings file.

It missed several of the same kind: the Claude settings files that list the hook commands, the folder where the hooks that actually run live today, the agent's own scripts folder, the files that define scheduled jobs, the file that names the tool servers sessions start, other coding tools' settings, and the Git hooks that run on every commit. It also missed the same files inside the agent's work copies of the project, which sessions use too. Anyone with dashboard access, which is the PIN, could edit one of those and get their own commands run.

Now the editor refuses to save those too. You can still open and read every one of them. Scheduled jobs are still edited from the dashboard's Schedule page, which has its own checks.
