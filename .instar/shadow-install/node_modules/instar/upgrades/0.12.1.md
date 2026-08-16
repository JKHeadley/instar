# Upgrade Guide — v0.12.1

<!-- bump: patch -->

## What Changed

Setup wizard Entry Point B (no agent in CWD) now has improved agent listing consistency:
- Every discovered agent in `merged_agents` appears in the AskUserQuestion options
- Local agents shown as informational with "already running" explanation
- GitHub agents listed with "Restore X" options
- Prevents confusion when agents appear in summary text but not in choices

## What to Tell Your User

- **Setup wizard polish**: "The setup screen now clearly shows which agents you can restore from GitHub and which are already running locally. No more confusing mentions of agents without actions."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Improved wizard agent display | Automatic — just run `npx instar` |
