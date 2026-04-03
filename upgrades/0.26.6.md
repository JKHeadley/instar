# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

**Fix Slack session resume** — The resume heartbeat (60s interval) was saving Slack channel resume UUIDs to the wrong file. It wrote to `topic-resume-map.json` using synthetic numeric IDs, but the Slack message handler reads from `slack-channel-resume-map.json` using real channel IDs. The heartbeat now writes to both files, ensuring that when a Slack session dies, the next message in that channel correctly resumes the previous session.

Also fixed a stale unit test for `findUuidForSession()` and added a public `jsonlExistsPublic()` method to `TopicResumeMap` for external UUID validation.

## What to Tell Your User

- **Session resume in Slack**: "When a conversation session stops in a Slack channel, the next message you send will now properly pick up where you left off instead of starting fresh. This was a bug where the resume data was being saved in the wrong place."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Reliable Slack session resume | Automatic — sessions resume on next message after dying |
