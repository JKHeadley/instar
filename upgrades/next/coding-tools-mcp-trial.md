# Coding-Tools Review Can Start Without Unused Integrations

## What Changed

A new opt-in switch, `jobs.codingToolsCurrentWithoutProjectMcp`, lets the scheduled `coding-tools-current` review start Claude without the project's integrations. Its recent runs used only Bash. The switch applies only when that job's manifest leaves integration access unspecified. A manifest that asks for project access keeps it. The switch is off by default, and turning it off restores the usual start. In one measured start, the input dropped from 74,770 to 59,798 tokens, about 20% less.

## What to Tell Your User

Nothing changes on its own. There is now a switch that makes the coding-tools review start lighter, using less AI usage per run, for when you want to try it.

## Summary of New Capabilities

An off-by-default trial that starts the coding-tools review without integrations it does not use.
