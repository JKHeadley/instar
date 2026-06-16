# Round 3 — Integration / Deployment + Multi-Machine lens

Scope: verify ONLY the four items in the round-3 charge. Grounded against the
actual current code (worktree `provider-fallback-chain`):
- `src/scaffold/templates.ts` line 836 (the "Per-Component Framework Routing"
  bold block in `generateClaudeMd`).
- `src/core/PostUpdateMigrator.ts` lines 5500-5532 (`migrateClaudeMd`'s routing
  block + the pi-cli follow-on block).
- `src/core/types.ts` line 2816 (`intelligence?` config block).
- `src/core/CodexCliIntelligenceProvider.ts` lines 127-170
  (`createCodexExecJsonConfigResolver` — the live precedent for an
  `intelligence.*` sibling key).
- `src/core/IntelligenceRouter.ts` lines 159-200 (the swap loop + `resolveConfig`).

---

## (1) N4 fix in §8 — VERIFIED CORRECT + EXECUTABLE ✅ (one precision note, not a blocker)

The N4 round-2 finding said: the original §8 sniffed `Per-Component Framework
Routing`, which is a no-op on every deployed agent, AND left the now-false
opt-in/heuristic text in place. §8 as rewritten is concretely correct and
executable against the real code:

- **migrateClaudeMd half is now executable.** The existing routing migration is
  at `PostUpdateMigrator.ts:5504`: `if (!content.includes('Per-Component
  Framework Routing'))`. CONFIRMED: that heading is present in every CLAUDE.md
  that already received the 2026-06-03 migration, so re-using it as the sniff
  WOULD silently no-op — exactly the N4 hazard. §8's instruction to add a SEPARATE
  block sniffing a NEW marker (`run off Claude by default` /
  `INTERNAL_FRAMEWORK_PREFERENCE`) and APPEND a corrective subsection is the only
  shape `migrateClaudeMd` can execute (it appends; it never edits a prior section
  in place). The new marker is genuinely absent from the current template/migrator
  (grepped: zero hits for either literal in `templates.ts` or
  `PostUpdateMigrator.ts`), so the content-sniff guard is real and idempotent.

- **generateClaudeMd half is now executable + targets real stale text.** The two
  now-false sentences §8 says to edit DO exist verbatim at `templates.ts:836`
  ("Routing is opt-in; with no config, everything stays on your default
  framework") and `templates.ts:839` ("if it's just rate-limited the component
  falls back to its heuristic (no herd onto the default)"). These are editable in
  place by `generateClaudeMd` (it builds the string fresh each call). So §8's
  split — edit-in-place for new agents, append-new-marker for existing agents —
  maps onto the real code with no stale-wrong text left behind. Not a no-op.

- **NEW (round-3) — marker-collision hazard with the pi-cli block, must be
  honored by the build.** The pi-cli follow-on migration at
  `PostUpdateMigrator.ts:5525` guards on
  `content.includes('Per-Component Framework Routing') && !content.includes("pi-cli")`.
  If the build's new corrective subsection (or the edited generateClaudeMd text)
  contains the literal token `pi-cli`, it will SUPPRESS the pi-cli awareness note
  on any agent that has the routing heading but had not yet received the pi-cli
  note — a silent regression of an unrelated migration. §8's own example text
  spells the chain as `Codex→PI→Gemini→Claude` (uses "PI", not "pi-cli"), so the
  spec's example is safe as written. This is a build-time constraint that §8
  should state explicitly so the implementer does not innocently write "pi-cli"
  into the new subsection. RECOMMEND: one sentence in §8 — "the appended
  subsection / edited block must NOT contain the literal token `pi-cli`, to avoid
  collision with the pi-cli follow-on migration's `!content.includes('pi-cli')`
  guard at PostUpdateMigrator.ts:5525." Low severity (the example already
  complies), but it is a real, code-grounded landmine for the build.

## (2) N8 boot-snapshot-vs-live-read documentation in §4.4 — HONEST + COMPLETE ✅

§4.4's second bullet states the semantics correctly and completely:
- Boot decides default-vs-operator ONCE from the construction-time snapshot.
- An operator who ADDS a `componentFrameworks` block AFTER boot needs a restart
  (consistent with §4.3's boot-computed primary and the active-set).
- An operator whose block was ALREADY set at boot gets live-read edits to its
  contents (the engine calls `resolveConfig` live — CONFIRMED at
  `IntelligenceRouter.ts:126,159`, both call `this.opts.resolveConfig()` per
  evaluate).
This matches the actual router contract (config read live per call) and the
construction-time snapshot mechanism. The restart-to-adopt caveat is stated, not
silent. No gap. The framing ("same restart-to-adopt semantics as the active-set")
is accurate and consistent with §4.3/§5. Honest and complete.

## (3) swapAttemptTimeoutMs config-default — NO ConfigDefaults/migration entry needed ✅ (but §4.5/§5 should say so explicitly — NEW)

VERDICT: §4.5/§5 do NOT need a config-default-table entry or a `migrateConfig`
addition for `intelligence.swapAttemptTimeoutMs`. Grounded reasons:

- **There is no central ConfigDefaults table for the `intelligence.*` namespace.**
  The `intelligence?` block in `types.ts:2816` is an all-optional interface; its
  siblings default via INLINE literal reads at the consumption site, not via a
  defaults table. The directly-analogous precedent is
  `intelligence.codexExecJson`: it has NO `migrateConfig` entry and NO
  ConfigDefaults row — it is resolved by `createCodexExecJsonConfigResolver`
  (`CodexCliIntelligenceProvider.ts:127`) which reads the key inline and falls
  through to a literal default when absent. `intelligence.circuitBreaker.openMs`
  follows the same "defaults apply when the section is absent, zero migration"
  pattern (explicitly documented at `types.ts:2810-2814`).

- **A frozen config-default for this key would be actively WRONG.** §5 already
  mandates "no persisted `componentFrameworks` block" so the active-set never
  pins stale. By the same logic, writing a `swapAttemptTimeoutMs` default into
  every agent's config via `migrateConfig` adds a persisted value with no benefit
  (the literal 5s default in code already applies when absent) and one cost (a
  config-bloat write to every deployed agent). The correct shape — consistent
  with `codexExecJson` — is: type the optional key in the `intelligence?` block in
  `types.ts`, read it inline in the swap loop with a `?? 5000` literal default,
  add NOTHING to `migrateConfig`.

- **NEW (round-3) — §4.5/§5 are silent on this and should state it.** §4.5 names
  the key (`intelligence.swapAttemptTimeoutMs`, default 5s literal) but does not
  say where it is typed or that it needs NO migration; §5's migration-parity
  section enumerates the CLAUDE.md migration but never addresses the new config
  key at all. Given Instar's Migration-Parity Standard (every new config default
  must be reasoned about for existing agents), the spec should add one line to §5:
  "`intelligence.swapAttemptTimeoutMs` is an optional, inline-defaulted key (5s
  literal at the read site) typed onto the `intelligence?` block in `types.ts` —
  NO `migrateConfig` entry and NO ConfigDefaults row, matching the
  `codexExecJson` / `circuitBreaker.openMs` precedent; the default reaches every
  agent through the shipped code, not a persisted block." Without this, a build
  agent following §5 literally has no guidance on the config key's migration
  posture and could either (a) wrongly add a `migrateConfig` write, or (b) forget
  to type the key in `types.ts`. Low-to-medium severity: a precision gap that the
  Migration-Parity Standard makes load-bearing.

## (4) NEW integration issues

- **N4-adjacent build landmine (pi-cli marker collision)** — surfaced under (1)
  above. The single concrete NEW integration risk this round.

- **No multi-machine integration issue found.** §5's multi-machine posture
  (active-set is machine-local by design; runtime-computed, never a
  replicated/persisted block) is correct and the strongest possible posture: a
  machine-local probe of installed CLIs cannot be pinned cross-machine because
  nothing is persisted to replicate. `/intelligence/routing` reflecting the local
  machine's resolution is the right read surface. Re-verified against the
  runtime-computed design — no cross-machine pin path exists. Converged.

- **CLAUDE.md template / migrator divergence is pre-existing, not introduced.**
  The bold-block form in `generateClaudeMd` (templates.ts:836) and the H3 form in
  `migrateClaudeMd` (PostUpdateMigrator.ts:5506) already diverge in wording today
  (this is the standard two-surface pattern Instar uses; the CapabilityIndex
  consistency machinery at PostUpdateMigrator.ts:6638+ accounts for it). §8's
  two-half approach correctly works WITHIN this existing pattern rather than
  fighting it. Not a new issue; noted for the build so it does not try to unify
  the two surfaces.

---

## Summary

All four round-3 verification items resolve in the spec's favor: the N4 §8 fix is
concretely correct and executable (not a no-op, no stale text left); the N8 §4.4
documentation is honest and complete; and `swapAttemptTimeoutMs` correctly needs
NO ConfigDefaults/migration entry (matching the `codexExecJson` precedent). Two
NEW precision items both warrant a one-sentence spec addition rather than a design
change: (a) §8 must warn the build off writing the literal `pi-cli` into the new
CLAUDE.md text (marker collision with the existing pi-cli migration guard); and
(b) §5 should explicitly state the inline-defaulted, no-migration posture of the
new config key. Neither blocks the design; both are cheap-to-add precision.
