# Upgrade Guide — usage-limit-key-pickup

## What Changed

A key saved with `instar set-claude-key` now goes into use within a minute in every state. Before, the running server only read it while the key monitor already thought the key was dead or a session sat at the login screen. During a usage limit it never did, so the usage probe and restarted sessions kept the old walled key, `claudeUsage` stayed `limited`, and waiting conversations never picked up (B2Lead live proof, 2026-11-07). `ClaudeKeyHealth` gets a steady key watch and `refreshKeyFromDisk()`; `UsageLimitWatch` syncs the key before each limited check, so a new key is probed on the next pass; each usage probe result is logged. Second cause, found by the live re-run: a session whose first turn was refused for usage had no known transcript id (instar learns it from hook events, and such a turn fires none), so its wall could not be proven and it was never restarted. `confirmSessionUsageLimit` now falls back to Claude Code's own `sessions/<pid>.json` record for exactly that tmux session, and binds the id. Third cause: on an agent with one login, sessions carry no `CLAUDE_CONFIG_DIR` in tmux at all, so the config-home lookup returned nothing; a new opt-in `defaultWhenAbsent` maps that to the default home for the usage proof only.

## What to Tell Your User

If I run out of Claude usage and you give me a key from an account that has room, I now start using it within about a minute, and the conversations that were waiting get answered. Before this fix I could keep saying I was out of usage after the new key was in.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| A new Claude key takes effect within a minute, even during a usage limit | Automatic after `instar set-claude-key` |

## Evidence

`tests/unit/usage-limit-key-pickup.test.ts` wires the real ClaudeKeyHealth and UsageLimitWatch together. With the fix, a working key clears the limit on the next pass and both waiting conversations restart on it and are answered. Without the fix, the 2026-11-07 failure is reproduced. The first-turn case is tested with the real SessionManager check and the record shape measured on nimbus. 8 of the 9 tests fail on main. The nimbus log from that run has no "configured key changed" line, and `/health` showed the key as `ok` after a random bad key went in. A live re-run of the pickup step on nimbus follows the merge.
