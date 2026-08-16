# Upgrade Guide — v0.12.2

<!-- bump: patch -->

## What Changed

**Fix: Deterministic agent listing in setup wizard**

The setup wizard's agent listing is now generated deterministically in setup.ts code, not by the LLM. Previously the wizard LLM would enumerate agents from JSON data and sometimes truncate the list (e.g., showing only 1 of 2 GitHub agents in the summary while correctly including both in the options). Now a pre-formatted `AGENT SUMMARY` block is passed to the wizard with instructions to display it verbatim.

Technical: `buildAgentSummary()` in setup.ts generates the formatted text. The wizard skill.md instructs the LLM to display the `--- BEGIN AGENT SUMMARY ---` block as-is rather than generating its own listing.

**Fix: Playbook commands (add, status, list, etc.) now correctly locate the manifest**

The `PLAYBOOK_CONFIG` environment variable was not being set when Instar launched playbook Python scripts. Fixed by adding `makePlaybookEnv(stateDir)` helper.

## What to Tell Your User

- **Reliable agent listing**: "The setup screen now consistently shows all your agents — no more missing entries."
- **Playbook commands fixed**: "The `instar playbook` commands were failing with a 'General error' — that's now fixed."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Deterministic agent summary | Automatic — run `npx instar` |
| Playbook add/status/list working | Run `instar playbook status` or `instar playbook add --content "..."` |
