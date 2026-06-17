# Side-Effects Review — Fix fleet-wide stray-`})();` in action-claim Stop hook + CI parse gate

**Version / slug:** `action-claim-hook-parse-fix`
**Date:** `2026-06-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required` (no decision-point / no runtime authority — CI-only guard + a generated-text fix)

## Summary of the change

`PostUpdateMigrator.getActionClaimFollowthroughHook()` emitted a hook whose template literal ended with `});\n})();` — but the hook body is **not** wrapped in an IIFE (it opens with a bare `let data = ''`). The trailing `})();` is therefore unbalanced, so `node` rejects the generated `.instar/hooks/instar/action-claim-followthrough.js` with `SyntaxError: Unexpected token '}'` on **every** Stop-hook fire. Because built-in hooks are always-overwritten on every migration, this broken hook shipped to the entire fleet and crashes once per turn (visible as the red "Ran 5 stop hooks → Stop hook error" in Claude Code). The hook is signal-only and dark-by-default, so the crash was noisy-but-harmless (it never blocked or corrupted work) — but it spammed errors continuously.

Two files change:
- `src/core/PostUpdateMigrator.ts` — remove the single stray `})();` line from the template (the hook body was already correct top-level code; only the extra IIFE-close was wrong).
- `tests/unit/generated-hooks-parse.test.ts` (new) — GENERATES every `get*Hook()` result and runs `node --check` on each JS hook. This is the gate that was missing: the existing `no-bare-require-in-generated-hooks.test.ts` only source-scans for one forbidden pattern and never parses, so a plain typo sailed past it.

The deployed fleet auto-heals on next update via the existing always-overwrite migration path (`migrateHooks` unconditionally re-writes this hook from the now-correct template). No new migration code required.

## Decision-point inventory

This change adds no runtime decision point. It corrects generated text and adds a CI test.

- `getActionClaimFollowthroughHook()` template — **modify** — remove one stray line; generated hook now parses.
- `tests/unit/generated-hooks-parse.test.ts` — **add** — CI-time parse gate over all generated hooks. A build-time signal (fails CI); it holds no runtime authority over any agent.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The CI test only fails the build when a generated hook genuinely fails `node --check`; that is the intended (and only) "block."

## 2. Under-block

`node --check` validates parse-ability, not runtime correctness — a hook that parses but throws at runtime would still pass this test. That gap is acceptable for this layer (parse failure was the actual fleet bug) and is the explicit motivation for Fix B (the runtime session-start hook-integrity guard), which catches post-deploy/runtime breakage. The test also skips `.sh`/`.py` generators (it is a `node` parse gate); shell/python hooks are out of scope here.

## 3. Level-of-abstraction fit

Correct layer. The bug is in source-generated text, so the prevention belongs in CI over the source generators (cheap, deterministic, runs before ship). The complementary runtime layer (heal already-broken hooks on disk without waiting for an update) is deliberately a separate change (Fix B) — this one does not try to be both.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface. The new test is a CI signal (fails the build); it never gates agent behavior at runtime. The template edit is a correctness fix to generated code. `docs/signal-vs-authority.md` reviewed — no brittle-detector-with-authority introduced.

## 5. Interactions

- **Shadowing:** None. The new test is additive and independent of `no-bare-require-in-generated-hooks.test.ts` (that one keeps its narrower source-scan; this one parses). They cover different failure modes and do not shadow each other.
- **Double-fire:** N/A — test-only + a one-line generated-text fix.
- **Races:** None. The test writes to a per-run `mkdtemp` dir; no shared state.
- **Feedback loops:** None.

## 6. External surfaces

- **Other agents / install base:** Positive-only. On next update every agent's `action-claim-followthrough.js` is re-written from the corrected template (always-overwrite), so the per-turn `SyntaxError` stops fleet-wide. No behavior change when the feature is enabled — the hook body is byte-identical except for the removed invalid line.
- **External systems:** None.
- **Persistent state:** None.
- **Operator surface:** No operator-facing actions — not applicable.

## 6b. Operator-surface quality

No operator surface (no `dashboard/*` or form files touched) — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — the fix is to a generated on-disk hook file; each machine installs and runs its own hook files locally (hooks are per-checkout infrastructure). The correction reaches every machine through the same always-overwrite migration each machine runs on update — there is no cross-machine state, notice, durable record, or generated URL involved. No one-voice gating, no topic-transfer stranding, no machine-boundary links.

## 8. Rollback cost

Trivial. Revert the two-file commit: the template line returns (re-breaking the hook) and the test is removed. No data migration, no agent-state repair. Because the hook is always-overwritten, a roll-forward or roll-back simply re-writes the hook from whichever template version is shipped.
