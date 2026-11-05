# Side effects: save a Claude key without the Claude CLI

Tier 1, narrow reversible command fix. PR #2719 changes one command and strengthens its existing E2E test. The first two commits lacked a decision audit because their worktree gate did not record one; this follow-up supplies a real trace and runs the gate for the changed source path. Two additional commit attempts were needed to diagnose that audit failure. No spec review round was needed for this small fix.

1. **Over-block.** The key shape check remains unchanged. A valid setup token is still accepted. The test intentionally removes all framework commands from `PATH` only inside its child process.
2. **Under-block.** The command still cannot save a malformed token, and it does not prove the key is valid with Anthropic. That validation belongs to the later authenticated call. The test checks storage and output only.
3. **Layer.** Directory resolution belongs in this key-saving command. Loading the full runtime configuration just to locate `.instar` created the unwanted framework prerequisite.
4. **Signal and authority.** The key-shape check remains the only local authority to reject a supplied value. A missing session CLI is no longer treated as authority to reject key storage. This follows `docs/signal-vs-authority.md`: the framework check is relevant when launching sessions, not when persisting a credential.
5. **Interactions.** The command still calls `writeClaudeKeyToConfig`, so configuration updates, encryption behavior and output wording follow the existing path. The test uses an isolated temp project and an empty child `PATH`, avoiding interference with the host's installed CLI.
6. **External surfaces.** Users on headless hosts can now save a key. No new endpoint, network host, notification or other agent behavior is introduced. The dummy test key is never sent externally.
7. **Multiple machines.** This command remains machine-local by design: it writes the project configuration on the machine where it runs. Replication of that configuration is unchanged and owned by the existing agent installation flow.
8. **Rollback.** Revert the small command change and test if needed. No data migration or key repair is required because the file format and storage path stay the same.
