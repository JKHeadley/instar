# Side-Effects Review — Dev-Agent Dark-Gate Conformance Guard (Slice 1)

**Change:** Add a structural guard for the `developmentAgent` dark-feature gate
so a feature can't ship dark on dev agents by hand-rolling/forgetting the gate
(the PR #1001 miss). Slice 1:
- `src/core/devAgentGate.ts` — `resolveDevAgentGate(explicit, config)` funnel
  (`explicit ?? !!config?.developmentAgent`).
- `scripts/lint-dev-agent-dark-gate.js` — assertion A (no hand-rolled
  `?? !!<x>.developmentAgent` outside the funnel) + assertion B (no hardcoded
  `enabled: false` under a dev-gate marker comment in `ConfigDefaults.ts`).
  Wired into the `lint` npm script (Repo Invariants CI).
- Migrated the 11 existing hand-rolled sites in `src/server/AgentServer.ts`,
  `src/commands/server.ts`, and `src/server/routes.ts` to the funnel
  (behavior-identical). Assertion B is brace-matched on the config block (not a
  fixed line window) — the fix for the convergence-review finding that a long
  marker comment hid the growthAnalyst block from the original window.

**Files:**
- `src/core/devAgentGate.ts` (new), `tests/unit/devAgentGate.test.ts` (new, 8).
- `scripts/lint-dev-agent-dark-gate.js` (new), `tests/unit/lint-dev-agent-dark-gate.test.ts` (new, 7).
- `src/server/AgentServer.ts`, `src/commands/server.ts`, `src/server/routes.ts` — 11 call sites + imports.
- `scripts/lint-no-direct-destructive.js` — allowlist the new lint (reads
  `git diff --cached` for `--staged`, same as its siblings).
- `package.json` — `lint` script + two convenience scripts.
- `tests/unit/growth-analyst-gate-wiring.test.ts`, `tests/unit/resource-sampler-wiring.test.ts`
  — source-pattern assertions updated to the funnel form.
- `docs/specs/DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC.md` (the design).

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?
Assertion A bans `?? !!<x>.developmentAgent` everywhere but the funnel. A future
legitimate need to read `config.developmentAgent` for a non-gate purpose (e.g.
logging which agent kind it is) would trip it. Mitigation: the regex requires the
`?? ` nullish-coalesce immediately before `.developmentAgent`, so a bare
`config.developmentAgent` read does NOT match — only the gate-resolution shape
does. Assertion B only fires on `enabled: false` in *code* lines within 8 lines
of a dev-gate marker comment in `ConfigDefaults.ts`; `enabled: true` (fleet-flip)
and comment prose are deliberately not flagged. Verified clean on the real tree
(the convention's own documentation does not trip it).

## 2. Under-block — what failure modes does this still miss?
The honest, central limit (named in the spec's layer table): **a feature that
should be dev-gated but omits the gate entirely** is invisible to both
assertions — there is no `?? developmentAgent` to flag and no marker comment to
anchor on. That is exactly the #1001 *shape* (it had a hardcoded `enabled: false`
default and a `=== true` construction with no gate). Assertion B catches the
`enabled: false`-under-marker variant, but not a gate-less feature with no
marker. The layer that truly catches forgot-entirely is the both-sides wiring
test over a dev-gated-feature registry (Slice 2) and the spec-intent cross-check
(Slice 3) — explicitly deferred and tracked (CMT-1253), not silently skipped.

## 3. Level-of-abstraction fit — right layer?
Yes. The funnel mirrors the established single-funnel pattern (SafeFsExecutor,
SafeGitExecutor); the lint joins the existing `lint-*` family run in Repo
Invariants. The guard lives in CI (the same layer that already enforces
no-direct-destructive, no-unfunneled-topic-creation, etc.), not in a prompt.

## 4. Signal vs authority compliance (docs/signal-vs-authority.md)
The lint is AUTHORITY (it fails CI / blocks a commit) — appropriate, identical to
its lint siblings: a deterministic, mechanical invariant with a clear fix
message, not a judgment call. The runtime helper is pure and behavior-identical
to the code it replaces, so it holds no new authority over runtime behavior.

## 5. Interactions — shadowing, double-fire, races?
None. The helper is a pure function with no state. The lint reads files only. The
migration is a mechanical rewrite (`X ?? !!c.developmentAgent` →
`resolveDevAgentGate(X, c)`) that `tsc --noEmit` confirms type-identical;
`resolveDevAgentGate` returns exactly `X ?? !!c?.developmentAgent`, so every
migrated gate resolves to the same boolean as before for all inputs.

## 6. External surfaces — visible to other agents/users/systems?
None. No routes, no config, no agent-installed files, no Telegram. Purely
repo-internal source + CI. No Migration Parity entry needed (the spec's Migration
Parity section says so explicitly).

## 7. Rollback cost — back-out if wrong?
Trivial and low-blast-radius. Revert the lint line in `package.json` to disable
the CI gate instantly; revert the migration commits to restore the hand-rolled
sites (behavior was never changed, so a revert is a no-op at runtime). No data,
no state, no deployed artifact to unwind.

## No deferrals
Slices 2 (registry + both-sides wiring test) and 3 (spec-intent cross-check) are
NOT deferrals of this slice's scope — they are the explicitly-scoped follow-on
layers named in the spec and tracked as commitment CMT-1253, so the gap is
visible and re-surfaced, not dropped.

## Second-pass review (independent)
**Done — via /spec-converge (5 internal reviewers, 2 iterations; report at
docs/specs/reports/dev-agent-dark-gate-conformance-convergence.md).** The
independent pass found three material issues that this change now fixes:
1. **Assertion B silently no-op'd on its origin case.** The original fixed 8-line
   window missed the real growthAnalyst block (its ~10-line marker comment pushed
   the fields out of range) — empirically, an injected `enabled: false` reported
   "clean." Fixed by brace-matching the block; re-tested: now caught, real tree
   still clean.
2. **An 11th un-migrated site + regex blind spot.** `routes.ts` used
   `?? Boolean(ctx.config.developmentAgent)` — missed by the `!!`-only first pass
   and unmatched by the lint. Migrated; regex broadened to `!!`/`Boolean(`/bracket.
3. **Spec overclaim.** Softened "catches #1001 directly" → "when gate-marked" and
   "only legal path" → "for the realistic spellings"; layer table now names the
   alias/wrapper and markerless misses.
Round 2 (lessons-aware + adversarial) returned CONVERGED — no material findings.
Security and scalability reviewers found nothing material (fails safe toward
dark-on-fleet; ~0.3s scan, no regex backtracking).
