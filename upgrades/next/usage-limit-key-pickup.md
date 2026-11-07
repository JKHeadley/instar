# Upgrade Guide — usage-limit-key-pickup

## What Changed

A key saved with `instar set-claude-key` now goes into use within a minute in every state. Before, the running server only read it while the key monitor already thought the key was dead or a session sat at the login screen. During a usage limit it never did, so the usage probe and restarted sessions kept the old walled key, `claudeUsage` stayed `limited`, and waiting conversations never picked up (B2Lead live proof, 2026-11-07). `ClaudeKeyHealth` gets a steady key watch and `refreshKeyFromDisk()`; `UsageLimitWatch` syncs the key before each limited check, so a new key is probed on the next pass; each usage probe result is logged.

## What to Tell Your User

If I run out of Claude usage and you give me a key from an account that has room, I now start using it within about a minute, and the conversations that were waiting get answered. Before this fix I could keep saying I was out of usage after the new key was in.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| A new Claude key takes effect within a minute, even during a usage limit | Automatic after `instar set-claude-key` |

## Evidence

`tests/unit/usage-limit-key-pickup.test.ts` wires the real ClaudeKeyHealth and UsageLimitWatch together. With the fix, a working key clears the limit on the next pass and both waiting conversations restart on it and are answered. Without the fix, the 2026-11-07 failure is reproduced. 8 of the 9 tests fail on main. The nimbus log from that run has no "configured key changed" line, and `/health` showed the key as `ok` after a random bad key went in. A live re-run of the pickup step on nimbus follows the merge.
