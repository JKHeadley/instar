# Convergence Report — Unified trust initialises on a machine that joined via pairing

## Cross-model review: codex-cli:gpt-6-astra (RAN — one round)

One review round, proportionate to a one-function bug fix. Stopped when the findings stopped changing the build: every finding below was folded in, and a second Standards-Conformance Gate run on the revised spec returned no finding.

What ran:
- The Standards-Conformance Gate (`POST /spec/conformance-check`, 92 standards), twice: 0 findings both times; parent-principle fit verdict `fit`.
- An external GPT-tier review through the agent's codex CLI (`gpt-6-astra`), with the loader, the key-file reader, the pairing installer and the parent spec as context. Verdict: MINOR ISSUES.
- One internal adversarial/security reviewer (Claude subagent), which read the spec, the diff and every reader of the canonical file. Verdict: nothing material.
- `scripts/lint-machine-local-justification.js --strict`: clean.

The other internal reviewer angles (scalability, decision-completeness, lessons-aware, integration) did not run as separate passes. That is a deliberate abbreviation for a bug fix, stated here rather than implied away.

## ELI10 Overview

When a new computer joins an agent, it saves the agent's key in a short file that does not say "this key is not locked". The code that starts the agent's trust layer refused any file that did not say whether the key was locked, so the trust layer never started on a computer that joined later. The fix reads a missing label as "not locked", but only after the existing checks confirm the key really is a plain, matching key. Anything else is still refused, and nothing is rewritten.

## Findings and what was done

| # | Source | Finding | Resolution |
|---|---|---|---|
| 1 | codex | The Problem section describes behaviour the supplied source no longer shows. | It described the code before this change; the heading now says so ("before this change"). |
| 2 | codex | "Refused with `Unknown encryption method`" and "no write" were broader than the code: a key that fails validation throws `IdentityFileInvalidError` first, and the existing hex repair can write before a refusal. | Design §1 and §4 and Rollback now state both. This change adds no write. |
| 3 | codex | The integration test covers the initializer, not `server.ts` boot. | Tests section now calls it initializer coverage; the joined-machine boot observation is the release check in the maturation plan. |
| 4 | internal | `??` let an empty stored `canonicalId` through. | Empty identifiers are now derived too; unit test added. |
| 5 | internal | No test for the installer shape stored as hex, or for a declared empty method. | Both tests added (hex repairs, loads, adds no field; empty method refused). |
| 6 | internal | Recovery data is not carried by the handover. | Stated in "What it does not do" (pre-existing, unaffected). |
| 7 | internal | MoltBridge will now initialise on a joined machine under the same identity. | Stated in Multi-machine posture (intended; MoltBridge is off by default). |
| 8 | internal | A stored non-empty `canonicalId` is used without checking it against the key. | Pre-existing behaviour, unchanged; recorded in the side-effects under-block section. |

## What the reviewers confirmed

- The widening can only admit a verified plaintext key pair: the shared reader requires a 32-byte seed whose public key matches before the loader branch runs; ciphertext without its label is refused.
- The derived identifiers equal what `create()`, migration and key rotation compute, so a joined machine gets the same `canonicalId` and `displayFingerprint` as the source.
- No other reader of the canonical file needs these fields from disk.
- Fixing the loader rather than the installer is the right trade: no migration, no rewrite of private-key files.
