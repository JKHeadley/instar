# A last-resort model for the sign-in repair, and two accounts of any provider — plain-English overview

## What this is about

Your agent keeps one or more subscription logins (Claude Code, Codex). When one of them stops working, an automatic sign-in repair exists to sign it back in: it opens that account's own browser profile, walks through the provider's sign-in pages, and then checks the result itself (the login completed, the email matches, a real authenticated call works). Nothing in this change touches how success is decided.

The repair needs a model in two places: a small "which button next?" chooser (the step supervisor) and, where a page is not in the fixed table, a page reader that picks the next control (agent navigation). On a Mac the repair can also hand the whole browser step to a short helper session that acts like a person. All of that model work normally runs on the agent's own subscription.

## The three cases the operator asked about

1. **Two accounts, one dies.** Already handled: the helper session runs on the other healthy account. This change adds tests that pin it.
2. **Two accounts with different providers (one Claude, one Codex).** Also already handled: the helper may be a Claude or a Codex account; it is never the account being repaired. The new tests pin both directions (a Claude repair helped by a Codex account, a Codex repair helped by a Claude account).
3. **Only one subscription.** This was the real gap. The agent's shared model runs on that same login, so when the login dies, the repair's model calls die with it, and there is no other account to run the helper on. The repair stopped at "no healthy helper account" and waited for the operator every time.

## What changes for the single-subscription case

If the operator puts an Anthropic API key in the agent's vault under one specific name, `relogin_last_resort_anthropic_api_key`, the repair gains a last resort:

- Its two model calls try the shared model first, exactly as before. Only when that call fails does a lightweight model (the haiku tier, over the API key) answer instead.
- A repair that finds no other healthy account on the machine no longer stops at "no healthy helper account". It runs the server-side browser path with agent navigation instead, using the last-resort model for its reads. The audit for that repair shows `last-resort-drive-started`.
- Spend is bounded: at most 60 calls per repair drive and 300 per day. The key is read live from the vault, so removing it turns the path off; adding it needs no restart.

## What does not change

- Nothing reads `ANTHROPIC_API_KEY` or the general `intelligenceProvider` setting. Every other internal model call stays on the subscription. Placing the key under the repair-specific name is the operator's consent to spend, and that consent covers only the repair.
- With no key in the vault, every path behaves exactly as today, including the "no healthy helper account" hand-off to the phone Sign-in cell.
- With a healthy helper account, the helper session runs as before and the last resort is never used.
- Success is still decided only by Instar's own checks. A model answer can never mark an account repaired.
- The key never appears in status, logs, or errors; status shows a status code or an error name only.

## What the operator needs to decide

Whether to give single-subscription agents a key under that name. Without one, nothing changes. The caps can be tuned under `subscriptionPool.assistedRelogin.lastResort`, and `enabled: false` turns the feature off even with a key present.
