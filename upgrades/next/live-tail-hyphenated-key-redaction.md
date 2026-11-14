## What Changed

The live-tail scrubber now redacts hyphenated `sk-` keys whole: Anthropic (`sk-ant-api03-`, `sk-ant-admin01-`, `sk-ant-oat01-`), OpenAI project / service-account / admin (`sk-proj-`, `sk-svcacct-`, `sk-admin-`) and OpenRouter (`sk-or-v1-`). Before, its rule needed 16 unbroken alphanumerics right after `sk-`, so these keys never matched and went to peer machines in plain text. `REDACTION_CATEGORY_VERSION` is now 2. The same blind spot was closed in the claim-observation scrubber, the Threadline open-conversation brief, the PromiseBeacon excerpt check and the post-drive transcript audit.

## Evidence

On main, `redactForLiveTail` returns `sk-ant-api03-…` and `sk-proj-…` keys unchanged; after, each is replaced by `[redacted:api-key]` with no fragment left (tests/unit/liveTailRedaction-hyphenated-keys.test.ts: 11 tests fail on main, all 20 pass after). Ordinary hyphenated text such as `sk-learn-compatible-estimators` and `task-proj-migration-checklist` stays untouched.

## What to Tell Your User

Modern API keys that start with a short word and a hyphen are now fully hidden before your agent shares its live activity with your other machines. Nothing to do.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Hyphenated API keys are hidden whole in the live tail | Automatic |
