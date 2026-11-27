# Save a Claude key before installing the Claude command

An agent can run on a machine that uses an Anthropic key but does not have the Claude command installed. The `set-claude-key` command is supposed to save that key so the agent can start or recover. It previously loaded the agent's entire configuration simply to find the settings folder. That loading step also checked whether the Claude command was installed. On a headless machine, the command failed before reading or saving the key.

The change in PR #2719 finds the settings folder from the project directory directly. The key still goes into the same `.instar/config.json` file and is checked for the same expected shape. The command still avoids printing the key. It no longer asks whether a session framework program is installed, because saving a key does not use that program.

The test now creates an empty command search path and runs the real built CLI from its absolute Node path. That makes the missing-Claude case reproducible on a developer's machine as well as in CI. It checks that a correctly shaped key is stored and absent from command output, then checks that a malformed value is rejected without replacing the stored key. This is the failure that currently makes a CI shard red on unrelated feedback PRs; fixing it lets those PRs receive meaningful test results again.

The change is small and reversible. If it misidentifies a project directory, restoring the old command behavior is a code revert; keys already saved remain in the same configuration location. It does not change key storage, send a key over a network, or alter how agents select their session framework.
