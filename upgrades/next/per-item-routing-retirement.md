# The legacy one-topic-per-alert mode is deprecated and dated for removal

## What Changed

Attention items have gone to the single "🔔 Attention" topic by default since July. An old setting, `attentionRouting.mode: "per-item"`, still let an install give every alert its own Telegram topic, nothing stopped new work from choosing it, and nothing dated its removal. Now the setting still works for the installs that use it, logs a deprecation warning at startup naming the removal date, and from 2027-03-01 is ignored: alerts then go to the single Attention topic. No shipped source may select the mode (a unit-test ratchet counts every use in the source), agents' instructions no longer say how to switch it on (new agents from the template, existing agents through an in-place rewrite of the old sentence), and every agent is told the mode is deprecated. A person can still set it by hand until the date; it then only logs the warning.

## What to Tell Your User

Nothing changes for you: alerts already share one Attention topic. If an older setup of yours still gives each alert its own topic, that stops on 1 March 2027 and the alerts move into the one topic.

## Summary of New Capabilities

No new capability. The per-item attention routing mode is deprecated with a fixed removal date of 2027-03-01.

## Evidence

Before: src/messaging/TelegramAdapter.ts read `attentionRouting.mode === 'per-item'` with no date and no warning, and the agent template told agents how to turn it on. After: tests/unit/per-item-routing-retirement.test.ts proves single-topic for any setting other than exactly "per-item", per-item working with a dated deprecation notice before 2027-03-01 and ignored from that day, no shipped source selecting the mode, and the template and awareness text saying it is deprecated; tests/unit/PostUpdateMigrator-topicFloodGuard.test.ts proves the old opt-in sentence is rewritten in place once.
