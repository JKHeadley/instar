# Convergence Report — Codex Intelligence-Provider Clean-Call Fix

## ELI10 Overview

Instar agents constantly ask themselves tiny background questions — "is this message urgent?", "did that finish?", "summarize this." For Claude-powered agents these little questions are asked on a blank notepad. For the Codex-powered agent (Codey), each one was accidentally booting his *entire* 26,000-character identity and running his full session-startup routine — about 1,550 times a day. That flood is what made Codey spam "still working" messages and drop incoming messages. This change gives Codey's background questions the same blank notepad: it runs them in an empty throwaway folder instead of his project folder, so no identity and no startup hooks load.

The review process changed one important thing: *which* throwaway folder. The first draft used a single, predictably-named folder in the system temp area. On a shared Linux machine, that predictable name is a security hole — another user could create that folder first and slip a malicious "hook" file into it that Codey would then run as himself. The fix now creates a folder with a random, unguessable name and locked-down (owner-only) permissions, so nothing can be planted in it. The tradeoff is essentially nil: it's the same mechanism, just with a safe folder name.

## Original vs Converged

- **Originally:** the scratch folder was a fixed path, `<tmp>/instar-codex-intel-scratch`, created with a plain `mkdir`. On Linux (`/tmp` is world-writable) an attacker could pre-create it or symlink it and drop a `.codex/hooks.json` inside — and the `project_doc_max_bytes=0` guard does NOT block hooks, only the identity doc. That re-opened hook execution under the agent's identity.
- **After review:** the folder is created with `fs.mkdtempSync(...)`, which appends a random suffix, sets owner-only (`0700`) permissions, and refuses to reuse a pre-existing path. The path is now unguessable, so nothing can be planted in it. The provider also re-checks the folder before each call and recreates it if a temp-cleaner removed it. The now-unused `workingDirectory` field was removed (kept on the type only for API compatibility).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec/code changes |
|-----------|-----------------------|-------------------|-------------------|
| 1 | adversarial, lessons-aware (security); integration = clean | 1 (shared predictable tmp name → Linux squatting / planted hooks.json) | switched to `mkdtempSync` (0700, unguessable) + re-verify-before-use; removed dead `workingDirectory` field; added 3 hardening unit tests; clarified spec (hooks not covered by `project_doc_max_bytes`; caller analysis; honest testing tiers) |
| 2 | (converged) | 0 | none |

External cross-model reviewers (GPT/Gemini/Grok) were skipped under abbreviated convergence — permitted for a single-file change with no new route/state/network surface. The mandatory lessons-aware reviewer ran.

## Full Findings Catalog

**Iteration 1**

- **MATERIAL — shared, predictable scratch path (adversarial + lessons-aware).** Fixed name under world-writable `/tmp` (Linux) lets another local user pre-create/symlink the dir and plant `.codex/hooks.json`; codex walks up from cwd and fires it; `project_doc_max_bytes=0` does not cover hooks. macOS unaffected (per-user `0700` tmpdir). **Resolution:** `mkdtempSync` (random suffix, `0700`, no-follow) + re-verify each call. Closed.
- **MINOR — dead `workingDirectory` field (integration + lessons).** Field no longer read after the cwd change; type "lies." **Resolution:** field removed; option retained on the type for API compat with a comment. Closed.
- **MINOR — testing tiers vs spec text (lessons).** Spec promised three tiers but the change is a spawn-arg/cwd contract with no HTTP route. **Resolution:** testing section rewritten to be honest — unit contract (incl. new security assertions) + mandatory live test-as-self reproduction; routed-feature E2E tier explicitly noted as not applicable. Closed.
- **CLEAN (integration).** Caller audit: only `reflect.ts`, `route.ts`, `server.ts` construct the provider; none depend on the codex cwd content (`route.ts`'s `workingDirectory` feeds only its own PreferenceStore DB path). Migration-parity claim ("code-only, no migrator entry") verified correct. `project_doc_max_bytes=0` confirmed a real, in-use key. No concurrency race. Claude path untouched.

**Iteration 2** — re-review of the hardened design surfaced no material findings. `mkdtempSync` structurally eliminates the squatting/symlink/planted-hooks vector; minors addressed.

## Convergence verdict

Converged at iteration 2. No material findings in the final round. Spec is ready for user review and approval.
