# Side-Effects Review — WS5.2 Step 9: live credential re-pointing migration parity (dark)

**Version / slug:** `ws52-step9-migration-parity`
**Date:** `2026-06-13`
**Author:** `Echo`
**Second-pass reviewer:** `4-adversarial-lens self-review (folded as named tests)`

## Summary of the change

Step 9 of live credential re-pointing (spec §4). Migration + docs only — closes the Migration Parity Standard gap so a DEPLOYED agent that auto-updates picks up the feature's dark config defaults AND the operator-facing CLAUDE.md awareness, reaching parity with a freshly-initialized agent. NO src behavior change: no credential write, no new route, no runtime gate.

Two halves:
- **Config parity** — the dark `subscriptionPool.credentialRepointing` block (`enabled:false`+`dryRun:true`+`manualLeversEnabled:true`) reaches existing agents through the EXISTING generic `applyDefaults` path inside `migrateConfig()`. The block lives in `SHARED_DEFAULTS` (ConfigDefaults Step 1), so the generic migration add-missings it idempotently and never overwrites an operator-set `enabled:true`. **NO hardcoded migrator block was added** — a single source of truth for the dark shape (no behavior creep; no divergence risk between two copies of the dark literal).
- **Awareness parity** — a new "Live Credential Re-Pointing" CLAUDE.md section in BOTH `generateClaudeMd()` (templates.ts, new agents, `**`-bold form) AND `migrateClaudeMd()` (PostUpdateMigrator, existing agents, content-sniffed `### ` H3 form). Registered in `featureSections` + BOTH `**`/`### ` shadow-marker variants (Codex/Gemini parity). Carries the verbatim proactive triggers ("flip my default account" → `POST /credentials/set-default`; "which account is this session/slot on?" → `GET /credentials/locations`), states the dark posture, and folds in the one-line `/switch-account`+`autoMigrate` deprecation note.

Files touched: `src/core/PostUpdateMigrator.ts` (the `migrateClaudeMd` content-sniffed section + 2 shadow markers), `src/scaffold/templates.ts` (the `generateClaudeMd` section), `tests/unit/feature-delivery-completeness.test.ts` (the `featureSections` registration). CapabilityIndex `/credentials` routes were already registered in Step 7 — VERIFIED present, not duplicated. ConfigDefaults was untouched (Step 1 already placed the block).

## Decision-point inventory

This change touches NO runtime decision point. It is migration (existence-checked file patching) + documentation. The only conditionals added are content-sniff guards (`if (!content.includes('Live Credential Re-Pointing'))`) — these gate a doc-injection, not agent behavior, information flow, or any action. Phase-1 answer: **No decision point** — this is a documentation + migration change with no blocking/filtering authority.

---

## 1. Over-block

No block surface exists. The change adds no gate, no refusal, no message filter. The content-sniff `if (!content.includes(...))` only decides whether to APPEND a doc section; it can never reject a legitimate input. With the feature dark (the shipped state) the documented levers all 503 at the route layer (unchanged by this step). No over-block.

## 2. Under-block

N/A — there is nothing to block. The failure mode this step exists to prevent is the OPPOSITE of a missed block: a deployed agent silently running stale config / blind to a capability. That gap is closed by the config add-missing (proven delivered + dark) and the both-sites awareness section (proven present in new and migrated CLAUDE.md). The feature-delivery-completeness ratchet structurally prevents the awareness half from regressing.

## 3. Level-of-abstraction fit

Correct layer. Config parity rides the EXISTING `applyDefaults`/`SHARED_DEFAULTS` mechanism (the canonical add-missing path) rather than a bespoke hardcoded migrator block — the right altitude, and the one with a single source of truth for the dark shape. Awareness rides the EXISTING `generateClaudeMd` + `migrateClaudeMd` + shadow-marker machinery every other capability uses. No new abstraction introduced; the change slots into the established patterns.

## 4. Signal vs authority compliance

Compliant by construction — the change holds NO authority of any kind (no block, no gate, no filter). It is pure migration + docs. `docs/signal-vs-authority.md` Question 4: this adds neither a brittle check with blocking authority nor a signal producer; it is below the authority/signal distinction entirely.

## 5. Interactions

- **Config:** the generic `applyDefaults` already iterates `SHARED_DEFAULTS`; the `credentialRepointing` block was added there in Step 1, so `migrateConfig` has been add-missing-capable for it since Step 1. This step does not add a SECOND config write — verified the feature-delivery-completeness config auto-detect (`if (!config.X) { config.X = {`) does NOT fire (no such pattern added), so no double-write and no untracked-block red.
- **Awareness:** the content-sniff marker `Live Credential Re-Pointing` is unique (greps to only the new section in both files), so it cannot shadow or be shadowed by another section's sniff. The migrator appends after the WS5.1 pool-scope block and before Session Boot Self-Knowledge — narrative-adjacent to its sibling Subscription Pool section.
- **Shadow markers:** two tail-truncated line-leading variants (`**Live Credential Re-Pointing` / `### Live Credential Re-Pointing`) cover both deployed forms; each CLAUDE.md contains exactly one, so the other no-ops — the established Per-Feature-LLM-Metrics precedent, no double-fire.
- **Dark-gate:** ConfigDefaults untouched → no new attributed `enabled:` path → dark-gate line-map UNCHANGED (24/24 green as-is, no recompute).

## 6. External surfaces

The only external surface is the CLAUDE.md text an agent reads at session start. It documents an existing (dark) capability accurately, including that the levers ship disabled. No new API, no message to another agent/user/system, no timing or conversation-state dependency. The awareness is a static doc string emitted deterministically.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN — and that locality is the WHOLE POINT.** Migration is per-machine: each machine's own update path runs `migrateConfig` + `migrateClaudeMd` against its own local config.json + CLAUDE.md. An N-machine pool = N independent migrations; no cross-machine dependency, no LAN assumption, no replication path needed. A headless/cloud VM agent picks up the SAME dark defaults + awareness on its own update. The Migration Parity Standard is precisely what makes a fleet of cloud VMs coherent without per-deployment hand-config: every machine converges to the same dark, aware starting state on its own. There is no durable state to strand on topic transfer and no generated URL to survive a machine boundary — this is config + docs, applied locally.

## 8. Rollback cost

Trivial. To back out: revert the single feat commit. No data migration, no agent-state repair. An agent that already received the dark config block keeps it (it is harmless and inert — `enabled:false`); an agent that already received the awareness section keeps a correct (if then-unreferenced) doc paragraph. Because everything is idempotent and dark, a rollback leaves no broken state on any machine.

---

## Adversarial 4-lens verdict (folded as named tests)

1. **Dark-posture parity (the blocker):** PASS — `migrateConfig` delivers the byte-identical dark block (`enabled:false`+`dryRun:true`+`manualLeversEnabled:true`) whether or not `subscriptionPool` pre-exists; an operator-set `enabled:true`+`dryRun:false` is proven NEVER clobbered. (`PostUpdateMigrator-credentialRepointing.test.ts`: 3 config tests + the no-subscriptionPool case.)
2. **Idempotency:** PASS — double-migration leaves a single dark config block + a single awareness section, byte-stable CLAUDE.md, and no re-report. (unit + integration idempotency tests.)
3. **Both-sites parity:** PASS — E2E proves new (`generateClaudeMd`) and migrated (`migrateClaudeMd`) CLAUDE.md both carry the same section, triggers, and route pair. (`credential-repointing-awareness-parity.test.ts`.)
4. **No-behavior-creep:** PASS — `lint-no-unfunneled-credential-write` clean; no new route/gate; dark-gate unchanged; the config auto-detect does not fire (no hardcoded block).

Concur with the review — no concern raised. The one real finding (config parity is ALREADY delivered by the SHARED_DEFAULTS/`applyDefaults` path, so a hardcoded migrator block would be redundant behavior-creep) was folded into the design decision and pinned by the "no-subscriptionPool" + "double-migration" named tests.
