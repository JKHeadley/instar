# Shell commands carrying a literal credential are refused

<!-- bump: patch -->

## What Changed

A GitHub personal access token was seen in the command-line arguments of a test command (2026-11-17). Anything in a command line is readable by every process on the machine while the command runs, and process samplers such as diagnostic logs and crash captures record it.

The built-in dangerous-command guard (setup template, update migrator and `init`, all three writers) now always refuses a Bash or exec command that contains a literal credential shape. That covers GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, fine-grained `github_pat_`), Anthropic keys (`sk-ant-`), Slack tokens (`xox?-`) and Telegram bot tokens. The refusal names the safe form: read the secret inside the command (`GH_TOKEN="$(gh auth token)"`, or the agent's secret reader), which the shell expands so it never reaches the command line. Fixture files with fake tokens are written with the Write tool, which is not a command line.

## What to Tell Your User

- **Keys stay off command lines**: "I no longer put passwords or keys directly into the commands I run, where other programs on the computer could see them. My safety check refuses that and I read the key inside the command instead."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Literal-credential refusal in the command guard | Automatic, every safety level |

## Evidence

- `tests/unit/dangerous-command-guard-literal-credential.test.ts`: six credential shapes are refused by the template and migrated guards, with the safe form named. Reading the secret inside the command, a regex that describes a token, a short partial shape and ordinary git commands all pass. The `init` copy carries the same rule.
