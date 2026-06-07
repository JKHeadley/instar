# Git Maintenance Promotion — Plain-English Overview

Instar agents often live inside real git repositories. Over time, those repositories can collect local machine files: session logs, temporary recovery files, generated databases, images, local settings, and other state that belongs on one computer but not in shared source history. When those files get tracked by git, every future change becomes harder to review because source work is mixed with operational clutter.

Codey tested a local cleanup tool first. The tool looks at the current git status, classifies paths into understandable groups, writes a report, and can perform one narrow repair: if a file is already ignored by git but is still tracked, it can remove that file from the git index without deleting the file from disk. That distinction matters. Removing from the index means "stop versioning this local file"; it does not mean "delete the user's data."

This promotion makes that capability available to all Instar agents. New agents will get two scripts in their neutral `.instar/scripts` folder, and existing agents will receive those scripts during upgrade. Instar will also ship a built-in `git-maintenance` job that runs in audit mode and writes a durable report. Audit mode is intentionally non-blocking: it tells the agent what looks wrong, but it does not stop work or mutate the repository.

The only mutating mode is explicit `--apply`, and even that mode is deliberately small. It only handles files that are already covered by ignore rules. It does not delete files, push to remotes, clean the working tree, or guess new ignore rules. This keeps the low-level classifier in the role of a signal producer rather than a brittle authority. Humans or higher-level agent work still decide what to commit, what to ignore, and what to review.

The main risk is false positives. Source repositories often contain files with words like "token" or "secret" in documentation or tests. The promoted classifier was adjusted so ordinary source, docs, tests, skills, and playbook scripts are treated as source unless they match explicit local-secret paths such as local config files or environment files. That makes the job useful without turning it into constant noise.

The change is reversible. If it causes trouble, a later Instar release can remove the built-in job and stop installing the scripts. Any reports already written are local runtime files and do not require a migration.
