# Codex agents explain progress in plain language

## Summary of New Capabilities

Codex agents get clearer guidance for explaining progress and next steps.

## What to Tell Your User

Codex replies should now say plainly what the agent found, what it is doing, and whether it needs your input.

## What Changed

- Generated Codex instructions now ask agents to give a direct answer, explain what they found and what they are doing next, and state whether they need input from the user.
- Existing generated Codex instruction files receive this section when a session starts. Hand-authored files are preserved.

## Evidence

- The IdentityRenderer unit tests pass, including refresh and non-Codex isolation.
- The TypeScript build and pre-commit lint pass.
