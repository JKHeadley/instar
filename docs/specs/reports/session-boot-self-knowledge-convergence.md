# Convergence Report — Session Boot Self-Knowledge

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in **all three rounds** (round 1: 6 findings, "MINOR ISSUES"; round 2: 6 findings, "SERIOUS ISSUES" — including the one genuinely load-bearing gap the internal panel missed; round 3: confirmation pass). Spec-level flag: **codex-cli:gpt-5.5 (RAN — clean pass state)**.

## ELI10 Overview

Your agents keep asking you to re-send credentials they already have, and keep not knowing about tools they've used dozens of times. The reason isn't lost data — the encrypted vault and the tool are right there on disk. The reason is that every new session wakes up with no awareness of what it owns.

This spec adds a small "what I already have" note to the context every session receives at startup: the *names* (never the values) of the secrets in the agent's vault, plus any operational facts the agent has recorded about its machine (like "your logged-in Telegram test browser lives at this path"). One rule rides along: if a secret is named here, fetch it from the vault with the provided retrieval script — don't ask the user to re-send it unless it's actually invalid.

The main tradeoffs: secret *names* will now appear in session transcripts (which can travel further than vaults — debug bundles, provider retention), and a free-text "facts" list could in principle be polluted or go stale. The review process hardened both: names and facts are sanitized and size-capped so they can't smuggle instructions; facts are explicitly labeled as unverified hints that safety rules outrank; a vault that won't decrypt says so honestly ("don't touch it, tell the operator") instead of pretending to be empty; and the feature starts dark on the fleet (live on Echo, the development agent) unless/until the operator explicitly flips it live fleet-wide.

## Original vs Converged

- **Rollout:** originally default-ON fleet-wide. Review forced an honest engagement with two standards — the canonical graduated-rollout pattern AND the in-flight "User-Facing Fixes Ship Live" amendment (PR #800) — landing on one Resolution rule: coded default is dark-fleet/live-dev-agent; the live-fleet flip is a one-line change that rides #800's merge or the approver's explicit direction. Every section of the spec now follows that single rule (round 2 caught the sections contradicting each other).
- **From "trust the text" to "treat as hostile":** originally names/facts rendered raw. Converged: vault key names are writable by peers (secret-sync does no name validation) and facts by the agent itself, so everything rendered is sanitized (control chars/ANSI stripped, envelope-breakout structurally escaped), clamped, depth-capped (no nested credential structure leaks), alphabetized, and capped at 50 names — with truncation always carrying a "here's how to get the full list" recovery marker pointing at the authoritative route.
- **The retrieval gap (cross-model catch):** the original block told agents to "read it from the SecretStore" without a usable read path — risking "I know a token exists but can't reach it." Converged: ships `secret-get.mjs` (value streams to stdout for piping, never echoed), and the live verification now requires a REAL credential-consuming operation, not just naming the secret.
- **Vault honesty:** decrypt-failure handling matured from a warning into a contract: absent ≠ decrypt-failed (exists-check first, one retry to absorb key-rotation races), the route returns 200 (a 500 would be swallowed by the hook's `curl -sf` and hide the warning), the wording carries no paths/key material, and it explicitly forbids agent-driven "repair" (the 2026-06-05 incident was recoverable precisely because nothing destructive ran).
- **Facts grew a real lifecycle:** from "edit config" to first-class Bearer routes (validation, duplicate/cap 409s, TOCTOU-guarded delete, audit lines) writing through a new atomic config-write helper — after review proved the "existing atomic config path" the spec originally leaned on doesn't exist.
- **Honest costs added:** names-in-transcripts threat accounting (including export paths beyond the machine), per-machine fact scoping (config doesn't sync), boot-latency budget (capped tighter than sibling curls; the pre-existing uncapped siblings recorded as a tracked framework issue), observability's half-funnel limitation, and a rejected-alternatives section (why boot injection beats the pull surfaces that already failed).
- **Collateral findings:** the review surfaced and durably recorded two adjacent defects — `/secrets/sync-status` renders a decrypt-failed vault as empty (the exact "empty-vault lie"), and the session-start hook's ~7 uncapped curls — both filed to the framework-issues ledger with dedup keys.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security 7, adversarial 9, integration 9, scalability 7, lessons 8, conformance gate 2, codex 6 | ~38 (overlapping) | Full rewrite: rollout reframed, sanitization/clamps/depth-cap, VITEST constructor guard, names cache, facts writer routes, threat model, decrypt honesty, observability, release-note plan |
| 2 | adversarial 7, integration 2, scalability 4, lessons 1, security 0, codex 6 (incl. the retrieval-gap catch) | ~14 (overlapping) | Resolution rule unifying the rollout default; `writeConfigAtomic()`; cache placement+key (path + mtimeMs/size); `?full=1` authoritative recovery; depth-2-as-post-process; DELETE expect-guard; `secret-get.mjs` retrieval affordance; facts route contract; transcript-export honesty; rejected alternatives |
| 3 | convergence verifier 1 (stale sentence), codex "MINOR ISSUES" (5 refinements of accepted risks) | 1 | One-line fix (Decision-points → `writeConfigAtomic()`); codex refinements folded anyway: this PR codes ONLY the gate default (flip = named follow-up), `secret-get.mjs` pipe-only usage contract + value-silent error paths, facts stamped `{fact, updatedAt, machine}` at write (reader keeps accepting bare strings), last-writer-wins config semantics pinned by an interleaving test |

## Full Findings Catalog

The complete per-round reviewer outputs (all findings with severity, perspective, and resolution) are preserved in the session transcript of the authoring run (2026-06-05, topic 19437). Material findings and their dispositions are enumerated in the Iteration Summary and the Original-vs-Converged section above; every material finding was either resolved in spec text or durably tracked (two framework-issues filed; one follow-up commitment already existed and is referenced by marker).

## Convergence verdict

Converged at iteration 3. The round-3 fresh-eyes pass verified all 13 round-2 material findings genuinely resolved and found one residual stale sentence (fixed in-line, re-verified). No material findings remain. Spec is ready for user review and approval — the approver has ONE decision beyond approval itself: confirm the coded dark-fleet default, or direct the live-fleet flip (Resolution rule, Availability section).
