## What Changed

The feedback executor can select GPT-6 Astra first for critical or complex reports, and Claude Opus 5.5 first for ordinary reports. The separate second model check required for merging remains. Ordinary reports use GPT-6 Sol for that check. Echo's Claude review path remains disabled until its explicit Opus 5.5 pin is configured; enabling it without that pin cannot use Fable in this feedback lane.

## What to Tell Your User

After Echo's Opus review setting is enabled, the most demanding feedback gets Astra's attention. Ordinary feedback goes to Opus 5.5, with a separate safety check before a fix can merge. Until then, or if either reviewer is unavailable, the PR waits.

## Summary of New Capabilities

- Feedback review can route critical or complex work to GPT-6 Astra and ordinary work to Claude Opus 5.5 with GPT-6 Sol as the independent second check, once Echo explicitly enables its Opus reviewer.

## Evidence

Unit tests cover the risk split, Codex model selection and strict pin, the explicit Opus pin, the unchanged two-family decision, and re-review of a legacy pass. A one-shot Opus 5.5 clean-door probe passed on Echo's default Claude account. Complete test tiers and release verification remain required before enabling the runtime setting.
