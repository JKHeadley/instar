# Machines always have a name, and reply footers show the real model

## What Changed
Every machine now carries a human name. When a machine sets itself up it takes the name its owner already gave the computer (on a Mac the Sharing name, on Linux the pretty hostname, otherwise a tidied hostname), with no question asked. Every boot and every update fills in a name for any machine that had none, and never replaces a name a person typed. The reader that learns a session's model from its transcript no longer gives up for good when one transcript line (a screenshot or a large tool result) is bigger than a single read, and at send time it catches up on the whole unread transcript before answering. When a footer field still cannot be known it is left out instead of printing the word "unknown", on Telegram and Slack.

## What to Tell Your User
The small line under my messages that says which machine and model wrote them was showing a raw machine code and "unknown" for the model. It now shows your computer's own name and the actual model. If you would like a different name for a machine, tell me and I will rename it.

## Summary of New Capabilities
- Machines are named automatically after the computer's own name, and unnamed machines are named on update.
- Reply footers show the real model for long Claude Code sessions, and leave out anything that is genuinely unknown.

## Evidence
Operator report 2026-11-12, footer `bob · Machine m_4851af · Claude Code · unknown`. Live replay on a real 4 MB Luna transcript: the old reader returned unknown (malformed-native-record), the new one returns claude-fable-5-2. Tests: tests/unit/friendly-machine-name.test.ts, tests/unit/machine-nickname-backfill.test.ts, tests/unit/telegram-origin/runtime-origin-observer.test.ts, tests/integration/message-origin-all-platforms.test.ts, tests/e2e/machine-name-and-model-footer-lifecycle.test.ts.
