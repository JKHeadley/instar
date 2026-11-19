<!-- bump: patch -->

## What Changed

Codex work now runs on the GPT-6.2 models released 2026-11-17: the `balanced` tier uses `gpt-6.2-sol` and the `capable` tier uses `gpt-6.2-astra`. The `fast` tier stays on `gpt-6-luna`, since there is no GPT-6.2 small model. Both new ids are recognized for topic pins, the dashboard model picker and the configured Codex default. Echo Bugs topics now default to `gpt-6.2-sol`. A machine whose Codex CLI is older than 0.166.0 uses `gpt-6-sol` or `gpt-6-astra` instead of starting a session that fails. Session launches also use the older model when the CLI version cannot be read. A fallback is recorded on the session and in the audit log, not posted in the chat (this also retires the older gpt-6.1 chat note). Feedback readiness and triage approval proposals name a model the local Codex can run. List prices for both new ids are recorded so spend is reported from the first call. The feedback reviewer and feedback triage checks accept the GPT-6.2 model of the same size. A model you chose yourself in settings or on a topic is left as it is.

## What to Tell Your User

Codex now uses the new GPT-6.2 Sol and Astra models for everyday and heavy work. If a machine still has an older Codex version, it keeps using the previous models until Codex is updated.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| GPT-6.2 Sol and Astra on Codex | Automatic for the balanced and capable tiers; a topic can also be pinned to either model by name. |

## Evidence

Live subscription probes on 2026-11-17: on Codex CLI 0.169.0 all five Codex accounts listed both ids and answered a one-line prompt with each. CLI 0.166.0 and 0.168.0 also answered both. CLI 0.165.0, 0.160.0 and 0.156.1 refused both with "not supported when using Codex with a ChatGPT account", which sets the 0.166.0 floor. Unit tests cover each tier, each fallback pair, the version boundary, and the review checks. The provider test file gives its fake CLI's version probe a 20 second budget through a test-only environment variable, so a busy machine cannot turn a slow start into a wrong model expectation; the product's 2 second deadline is unchanged.
