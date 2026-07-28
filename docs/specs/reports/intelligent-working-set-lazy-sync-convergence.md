# Convergence Report — Intelligent Working-Set Lazy-Sync (agent-artifact scope)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-5.5 external pass ran through the codex CLI on rounds 1–3. **Honest model posture (per operator directive, 2026-07-03):** codex GPT-5.5 external RAN (strongest *accessible* OpenAI); Gemini door UNAVAILABLE (gemini-cli retired 2026-06-18); internal reviewers on Opus 4.8 (Fable 5 gated until ~Jul 7) — the strongest AVAILABLE model on each REACHABLE door.

## ELI10 Overview

There's already an engine that moves a conversation's files between my machines, but it only sees files a scheduled job produced — a file I write *interactively* while chatting is invisible to it. This spec closes that one gap for agent-produced artifacts under my own `.instar/` working area: I record them, they follow the conversation across machines via the existing hardened transfer engine, and I'm grounded on them at startup. It deliberately does NOT sync git-tracked project files (docs/src/tests) — that would widen a security boundary to the whole repo and fight git, so it's called out as a separate operator decision, not turned on quietly.

## Original vs Converged

- **Originally:** the draft promised "any file you create/edit follows the conversation" and confidently described the existing engine — but round 1 (reviewers grepping the real code) found those claims WRONG: the engine is *computed-not-declared* (it deliberately rejected declaration-driven manifests), its jail is `.instar/`-rooted (NOT the project repo), its caps are 4MB/16MB/64-files/32MB (not the draft's 50MB), its TTL is 7d (not 30d), and the PostToolUse recorder it assumed doesn't exist. The headline "sync docs/src/tests" was structurally impossible without widening a security jail to the whole repo + reversing a deliberate decision + colliding with git-as-source-of-truth.
- **After convergence:** re-scoped to the safe, additive NARROW version — agent artifacts under the existing `.instar/` jail only, via ONE new source (a durable interactive-artifact record) unioned into the existing computed engine + startup grounding. The BROAD project-file sync is documented as an explicit operator-gated decision with its own security review (F10). The replication carrier was corrected from an append-log journal kind (no recordKey/tombstone/no-clobber, + a missing apply branch that silently halts replication) to the WS2 replicated-store path (which provides recordKey + tombstone + append-both-on-divergence for free), with the first-ever path payload handled against the envelope's structural path-jail (recordKey = non-path-shaped hash; relPath carved out + strictly receive-validated). Owner-only tombstones, per-content suppression, content-identity row states (only `ready` fetchable), a deterministic read API, one canonical path-validator, and a full Migration-Parity site list were all added.

## Iteration Summary

| Round | Reviewers | Material findings | Key changes |
|-------|-----------|-------------------|-------------|
| pre | (author) | — | lessons-informed strengthening (mandatory sections, foundation-binding) — but with WRONG foundation claims |
| 1 | 5 internal (grepping code) + codex | fundamental mis-scope | foundation claims wrong; scope fork (narrow vs broad) surfaced; ~13 findings |
| — | (author) | — | full re-scope to narrow + fix all round-1 findings with verified facts |
| 2 | 3 focused internal + codex | 1 (wrong replication carrier) + 1 low (NUL) | foundation now verified-correct; decision-completeness converged; carrier retargeted to WS2 store + path-jail collision handled; tombstone authority; recorder contract; advisory grounding |
| 3 | codex (MINOR) | refinements (all addressed) | suppression storage/lifecycle; diff-recorder allowlist; content-identity row states; deterministic read API; one canonical path-validator |

## Full Findings Catalog

Round 1 (fundamental): the engine is computed-not-declared + `.instar/`-jailed + real caps/TTL/shape — the draft's project-file premise was structurally impossible; plus credential-fail-open, jail canonicalization/symlink, manifest authentication, `(path,producerMachineId)` key, deletion tombstones, `.from-*` recording loop, hash algorithm. All resolved by re-scope + fixes. Round 2 (carrier): the WS2 replicated-store path (not an append-log kind) is the correct carrier and already provides the designed semantics; the record's path payload collides with the envelope's structural path-jail → recordKey as a non-path-shaped hash + a carved-out, receive-validated relPath. Round 3 (refinements): suppression keyed `{topic,recordKey,contentHash}`; diff-recorder allowlist; explicit row states; deterministic `GET /coherence/working-set`; single `jailValidateRelPath` module.

## Convergence verdict

**Converged at round 3.** The internal panel converged in round 2 (foundation claims verified-correct, decision-completeness clean, all security items closed, self-heal + posture correct) modulo the single carrier finding, which was fixed per the code-grepping reviewer's exact verified prescription; codex settled at MINOR across rounds 2–3 with each finding a narrowing refinement, all addressed. Ready for operator review and `approved: true`.

**Operator note before approval:** (1) This ships the NARROW `.instar/`-artifact scope. The BROAD project-file sync (F10) is a SEPARATE decision for you — it would widen a security jail to the whole repo and needs its own security spec; I did not choose it autonomously. (2) The cross-machine live-verify is BLOCKED until the Laptop is online.
