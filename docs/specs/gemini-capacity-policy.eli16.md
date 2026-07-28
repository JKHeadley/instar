# Gemini Capacity Policy ELI16

Gemini sometimes says a request cannot run right now because the account or model is at capacity. Those errors can include a reset time, like a few seconds or several hours. The important difference is that a few seconds is worth retrying, while several hours is not.

This change teaches the Gemini provider to tell those cases apart. If Gemini says to wait only a short time, the provider waits briefly and tries once more. If Gemini says the reset is long, or if the error clearly looks like capacity but does not include a useful reset time, the provider records a local cooldown and fails quickly until that window is over.

The change also tightens Gemini model names. Only known local Gemini models are passed to the CLI. If an old or unsupported model id is requested, the system falls back to the known default instead of sending a model name that is likely to fail.

The tests cover the small parser rules, the one-shot adapter path with a fake Gemini CLI, and the live provider lifecycle path. That gives confidence that the policy works both as a helper and through the actual provider surface users hit.
