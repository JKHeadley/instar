# Side-Effects Review — Session Boot Self-Knowledge

**Version / slug:** `session-boot-self-knowledge`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `spec-converge multi-reviewer panel (3 rounds: security/adversarial/integration/scalability/lessons-aware internal + Standards-Conformance Gate + codex-cli:gpt-5.5 external each round)`

## Summary of the change

Adds the boot self-knowledge block: a bounded, sanitized `<session-self-knowledge>` context block (vault secret NAMES — never values — plus self-asserted operational facts) built server-side by the new `src/core/BootSelfKnowledge.ts`, served by `GET /self-knowledge/session-context` (with `?full=1`), written by `POST/DELETE /self-knowledge/facts`, injected by a new fetch block in `getSessionStartHook()`, retrieved-from by the new hardened `secret-get.mjs` script, and configured by the new `InstarConfig.selfKnowledge` surface (defaults via `ConfigDefaults` + `migrateConfig`; CLAUDE.md template + `migrateClaudeMd`; script via `migrateScripts` + init). Includes the structural `MasterKeyManager` VITEST constructor guard. Files: `src/core/BootSelfKnowledge.ts` (new), `src/core/SecretStore.ts`, `src/server/routes.ts`, `src/core/PostUpdateMigrator.ts`, `src/core/types.ts`, `src/config/ConfigDefaults.ts`, `src/scaffold/templates.ts`, `src/commands/init.ts`, `src/templates/scripts/secret-get.mjs` (new), plus 4 test files, the spec + ELI16 + convergence report, and the release fragment. Spec: `docs/specs/session-boot-self-knowledge.md` (converged + approved).

## Decision-point inventory

This change adds NO decision point with blocking authority — it is a pure signal producer (read-only context injection; per `docs/signal-vs-authority.md`). Conditionals it adds are availability switches and writer-input validation, not behavior gates:

- `GET /self-knowledge/session-context` enabled-resolution (`enabled ?? !!developmentAgent`) — add — availability switch (graduated rollout), not a behavior gate.
- Facts writer validation (400 empty/oversize; 409 duplicate/cap/ambiguous/expect-mismatch) — add — input validation on an agent-driven write surface.
- Pass-through: SecretStore read path (read-only), session-start hook (additive fetch block, fail-open), config write path (new atomic helper for one array).

---

## 1. Over-block

The enabled-resolution 503s the route on fleet agents (flag unset, `developmentAgent` false) — by design (graduated rollout), not an over-block: the hook fail-opens silently. The facts writer rejects: empty/oversize facts (legitimate long facts >256 chars must be split — accepted cost, keeps the boot block bounded), exact duplicates, adds past the 50-fact cap, ambiguous `match` deletes, and stale `index+expect` deletes. Each 4xx carries an actionable message. No legitimate session-context READ is ever rejected beyond auth + the availability switch. No other block/allow surface.

## 2. Under-block

- A fact that is misleading-but-validly-shaped (≤256 chars, unique) is stored and injected every boot — mitigated by the self-asserted/unverified labeling, per-index render for one-call removal, and the per-serve audit line; residual risk accepted for v1 and explicitly watched during the bake (spec §Threat model).
- The last-writer-wins window between the facts writer and the pre-existing NON-atomic config writers (PATCH /config, telemetry) remains — bounded to the handler's microseconds by re-read-before-write, pinned by the interleaving migration test; accepted and documented.
- Names already written into past transcripts are not retroactively scrubbed if the feature is later disabled.

## 3. Level-of-abstraction fit

Right layer. The names derivation stays in `secretKeyPaths()` (shared with `/secrets/sync-status` — no logic fork); the block-building/presentation is a new module rather than overloading sync-status (which 503s when secret-sync is dark — wrong availability semantics for a boot surface) or the SelfKnowledgeTree (LLM search over AGENT.md — different system, noted in code comments on both). The hook injection rides the existing org-intent/preferences pattern rather than inventing a new injection mechanism. Rejected alternatives (pull surfaces: /capabilities, MCP resources, memory files) are analyzed in the spec — the failure class is "agent doesn't know to look," which only push-at-boot removes.

## 4. Signal vs authority compliance

Compliant — pure signal producer. The block is wrapped in an envelope that explicitly subordinates it to org-intent constraints, safety rules, and user instructions. The guidance line is signal-shaped ("retrieve rather than re-ask, unless you have evidence it is invalid") not absolute. A deterministic block on credential re-asks was considered and rejected as brittle-authority (spec §Why guidance stays a signal); the designed escalation if the bake shows non-compliance is a smart-gate signal feed, not a regex block. The VITEST keychain guard is a test-environment safety rail, not a runtime decision point.

## 5. Interactions

- Coexists with the org-intent and preferences injections: placed after both in the hook (authoritative contract first); envelope states precedence. No shadowing — different routes, different envelopes.
- `/self-knowledge/*` namespace shared with the SelfKnowledgeTree routes (search/validate/health) — no path collision; comments mark which system serves which path.
- The names cache keys on the vault file path + (mtimeMs,size); secret-sync writes go through the same in-process server, so a peer-pushed secret invalidates the cache on its atomic write. No double-fire: the route is the only consumer.
- `migrateConfig`'s recursive add-missing merge interacts with operator-set `selfKnowledge` values — partial-override case pinned by test.
- The VITEST guard interacts with every existing test that constructs SecretStores — it can only make them SAFER (file-key instead of keychain); tests that explicitly pass `forceFileKey: true` (e.g. SecretMigrator's) are unchanged.

## 6. External surfaces

- Vault key NAMES become visible in: the Bearer-gated route response, the agent's session context, and therefore on-disk session transcripts (which can travel further than vaults — debug bundles, provider retention; spec §Threat model). This is the feature's one genuinely new exposure and the reason it ships dark-fleet with the live flip as an explicit follow-up decision.
- No cross-agent or cross-machine surface changes: facts are per-machine (config doesn't sync); names reflect the local vault (which secret-sync may populate). Nothing here changes timing-sensitive behavior visible to other systems; the hook fetch is fail-open with `--max-time 4 --connect-timeout 1`.

## 7. Rollback cost

Low. Per-agent: `selfKnowledge.sessionContext.enabled: false` (route 503s, hook silently skips — no restart needed; the flag is fresh-read). Fleet: revert the PR — no data formats change; the only state this feature writes is the `operationalFacts` array via explicit calls, which survives or is hand-removable. The VITEST guard's rollback is one constructor line. Names already in transcripts are the only non-revertible residue (documented).

## Deferred / follow-ups (all tracked)

- Live-fleet flip (`enabled: true` in ConfigDefaults) — rides PR #800's merge or explicit approver direction (spec §Availability Resolution rule; the approver was asked directly in the approval request).
- Session-start hook's pre-existing uncapped sibling curls — framework-issues ledger `session-start-hook-uncapped-curls`.
- `/secrets/sync-status` rendering decrypt-failure as an empty vault — framework-issues ledger `sync-status-decrypt-fail-reads-empty`.
- Per-agent keychain accounts + key-id header + dual-key read fallback — pre-existing commitment from the 2026-06-05 incident (CMT lineage in topic 13481), unchanged by this PR.

## Post-review fix round (fresh-eyes code review, 2026-06-05)

The independent code review of the feature commit found ONE real bug, fixed before PR: the names cache (keyed on the vault file) cached the `decrypt-failed` outcome — but a decrypt failure is almost always a MASTER-KEY problem (a separate file the cache key cannot see), so a recovered key kept serving the stale hands-off warning until a restart. Fix: only the healthy outcome is cached; a failed state is re-tried on every read (cheap relative to lying about recovery). Plus hardening: backticks are stripped from rendered names/facts (a hostile name can no longer break the inline-code span). Two regression tests added (decrypt-recovery-heals-without-restart; backtick-inertness).

## CI-fix round (post-PR, 2026-06-05)

Three CI failures owned per Zero-Failure: (1) `ConversationStore.test.ts` time-bomb — the test anchored retirement at fixed `2026-05-30`, and its 25h-stale entries crossed the store's 7-day expiry on 2026-06-05 (main's last CI run squeaked under the boundary by an hour; this PR's run detonated it) — re-anchored at real now, semantics unchanged; (2) no-silent-fallbacks ratchet — the four new BootSelfKnowledge catch blocks annotated `@silent-fallback-ok` with per-catch justifications (never a baseline bump); (3) docs-coverage route floor — the three new routes documented in the site API reference + a new features page (which also satisfies the route ratchet for the existing tree routes' namespace).

## Compaction-parity round (approver design review, 2026-06-05)

Justin's review surfaced the long-session gap: the block injected at session start survives compaction only if the summary carries it. Fixed in-PR: the compaction-recovery hook now carries the same fail-open fetch (re-injection after every compaction — refreshed, not merely preserved), with a Phase-3 e2e running the real compact-hook block against a live server. Collateral: org-intent + preferences share the boot-only gap (filed as `session-context-injectors-lack-compaction-parity`); a "Compaction Parity" constitution amendment is proposed separately. His scale concern is answered by the existing hard 2KB byte-cap (pointer-not-payload design); the AGGREGATE boot-budget concern across all injectors filed as `boot-context-aggregate-budget`.

## Post-merge-conflict round (2026-06-05 AM)

Rebase onto the post-#848 main + CI surfaced the feature-delivery-completeness registry: the new CLAUDE.md section is now tracked in `featureSections` AND mirrored to the framework-shadow markers (`migrateFrameworkShadowCapabilities`) — Codex/Gemini agents learn the capability too (the Secret Drop lesson: an unshadowed capability gets improvised around). Local pre-push had skipped the smoke ("CI is the authority"), which is why CI caught it.
