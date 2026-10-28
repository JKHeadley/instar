# Codex agents explain progress in plain language

## What Changed

- Generated Codex instructions now ask agents to give a direct answer, explain what they found and what they are doing next, and state whether they need input from the user.
- Existing generated Codex instruction files receive this section when a session starts. Hand-authored files are preserved.

## Evidence

- The IdentityRenderer unit tests pass, including refresh and non-Codex isolation.
- The TypeScript build and pre-commit lint pass.
