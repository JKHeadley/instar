# Automation footer cleanup
<!-- bump: patch -->

## What Changed
Automation message footers omit unavailable machine, harness and model labels. Known fields and configured-model qualifiers still appear. Unknown evidence remains in the durable audit record.

## What to Tell Your User
Routine notices now show a shorter footer, such as “echo · Mac Studio · automation”, instead of trailing “unknown” labels.

## Summary of New Capabilities
- Cleaner automation footers with available information only.

## Evidence
Formatter regression tests and the Telegram origin runtime lifecycle exercise visible output and retained unknown audit evidence. Validation results are recorded in upgrades/side-effects/automation-origin-footer.md.
