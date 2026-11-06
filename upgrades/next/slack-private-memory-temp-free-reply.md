# Slack replies after private-memory repair

## What Changed
Private-memory sessions on macOS can send Slack replies without Bash trying to create a forbidden temporary file. Existing shipped reply helpers migrate to the corrected template; customized helpers remain preserved.

## What to Tell Your User
The owner repair link keeps privacy enabled, and the repaired agent can now send its answer back to the private Slack channel.

## Summary of New Capabilities
No new capability; restores Slack replies inside the existing privacy sandbox.

## Evidence
Real shared-Mac Bash sandbox regression, exact prior-template migration test, and live Slack owner-repair acceptance in topic 10000001598. See upgrades/side-effects/slack-private-memory-temp-free-reply.md.
