# Convergence Report — Ask for a key and cancel a request from the phone

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass ran through the agent's codex CLI on 4 rounds, each on a changed spec; round 4 also read `mobilePermissionsRoutes.ts` and `mobileSecretsRoutes.ts`. Gemini was inactive on this machine. The internal reviewer subagents did not run, because this work ran in a fork that cannot spawn them; a Claude clean-door pass read the spec and the code instead, and it is same-family, not cross-model.

## ELI10 Overview

The app can now ask someone for a password or key, and cancel a request, with Face ID each time. It uses the same checks as approving a permission slip. The one-time link stays out of the app's own routes; the person gets it from the console.

## Original vs Converged

- **Exact bytes are defined.** The challenge body, hashing, defaults and topic form are spelled out, with one shared test vector in the server and Swift tests.
- **Honest protection claims.** Face ID wording inherits the permissions spec's limits; the token-shape check is described as catching recognisable shapes only.
- **Audit ties up.** New success events, a one-way `requestKey` on a request's row, and a fixed route name so a pasted token can't reach the file.
- **The gate's reason is stated.** Presence is for phone writes; the agent's bearer route stays. The parent spec's scope is widened in words.
- **The handover is stated.** With console tickets off, the console's PIN still reaches the link.
- **A note can have line breaks.** A newline had been refused as if it were a secret; the rule is now its own code and notes allow it.
- **The cap isn't a catch-all.** Only SecretDrop's pending cap reads as too many; any other failure is reported.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|-----------|-----------------------|-----------------|--------------|
| 1 | codex | 2 + 2 precision | challenge contract, atomic duplicate check, presence wording, coverage naming |
| 2 | codex | 1 + 2 precision | audit events and request key, credential-shape wording, length and case rules |
| 3 | codex | 0 + 2 precision | link boundary, whitespace rule |
| 4 | codex, clean-door (with code) | codex 0 + 3 precision; clean-door 2 + 6 precision | gate rationale and parent scope, console handover, fixed audit route, note rules, refusal codes, cap handling, duplicate wording |

Standards-Conformance Gate: unavailable: the route refuses a spec path outside the running server's specs directory, and this spec lives in a worktree (same as the parent spec's report).

## Convergence verdict

Codex's rounds 3 and 4 had no design findings. The clean-door pass raised two design points in round 4; both are answered above, and no later reviewer has read those edits. The route, gate and test changes are covered by the unit, integration and e2e tests. No operator decision is needed.
