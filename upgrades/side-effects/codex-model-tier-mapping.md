# Side-Effects Review — Codex model tier mapping (light/medium/heavy)

**Change:** Set the Codex tier→model map in both resolution surfaces to the
mapping Justin confirmed 2026-05-23: `fast`=gpt-5.2 (light), `balanced`=gpt-5.4-mini
(medium), `capable`=gpt-5.5 (heavy). Previously `balanced`=gpt-5.5, `capable`=gpt-5.4.
Files: `src/providers/adapters/openai-codex/models.ts` (TIER_TO_MODEL),
`src/core/frameworkSessionLaunch.ts` (resolveModelForFramework), and the
`/sessions/create` allowlist in `src/server/routes.ts` (adds `gpt-5.4-mini`).

**Spec:** `specs/provider-portability/11-cost-aware-routing.md` (cost-aware routing —
the tier→model assignment is its concrete config).

## Why this mapping (research-grounded)

The ChatGPT subscription meters by token-weighted credits in a rolling 5h + weekly
window, so token-burn is the real cost metric, not a dollar proxy. gpt-5.2 is
non-reasoning (≈0 thinking tokens on trivial calls) → genuinely lightest. gpt-5.4-mini
is a small *reasoning* model (emits reasoning tokens even on trivial prompts) → the
cheapest *reasoning* option, right for medium work but wrong for the high-frequency
light tier. gpt-5.5 is the frontier reasoning model → heavy.

## Main-chat safety (the critical check)

Justin's hard requirement: the user's main chat stays on gpt-5.5. Verified safe:
- codey's `frameworkDefaultModels` is `null`, so the interactive session passes
  `defaultModel=undefined`. `resolveModelForFramework('codex-cli', undefined)` returns
  `undefined` (short-circuit on falsy), and the interactive builder's
  `?? 'gpt-5.5'` literal then applies → **main session = gpt-5.5**.
- Confirmed live against the deployed dist: `buildInteractiveLaunch('codex-cli', {})`
  emits `--model gpt-5.5`; `capable` tier → gpt-5.5.
- The `?? 'gpt-5.5'` literals (interactive + headless defaults) were left unchanged.

## Blast radius — internal tier callers that shift

The remap changes what `balanced` and `capable` resolve to for internal callers:
- `balanced` (5.5 → gpt-5.4-mini): ProjectDriftChecker, UpgradeNotifyManager chain,
  StallTriageNurse diagnosis, anthropic-headless default (Claude — unaffected, separate
  map). All are everyday/background judgment calls → medium (cheaper reasoning) is the
  intended tier. Net effect: lower quota burn, same capability class.
- `capable` (5.4 → gpt-5.5): JobReflector, ContextualEvaluator security path,
  LLMConflictResolver tier-2. These are heavy/critical calls → 5.5 (frontier) is an
  upgrade, appropriately reserved.
- `fast` (gpt-5.2): unchanged — all cheap internal calls keep the non-reasoning model.

No caller is the user's main interactive session (that path is the `?? 'gpt-5.5'`
literal, not a tier lookup), so none of these shifts touches the main chat.

## Interactions

- The two maps (models.ts adapter map + frameworkSessionLaunch session map) are kept
  in sync — both now light/medium/heavy = 5.2/5.4-mini/5.5.
- `/sessions/create` allowlist gains `gpt-5.4-mini` so an explicit raw-model request
  for the medium model isn't rejected (tier names already pass via GENERIC_TIERS).
- Model-availability: gpt-5.4-mini confirmed working on codey's ChatGPT subscription
  (live-tested 2026-05-23). Use base `gpt-5.2`, NOT `gpt-5.2-codex` (a reasoning model);
  the map uses the base id.

## Rollback cost

Trivial. Revert the two map entries (balanced→gpt-5.5, capable→gpt-5.4) in both files
and drop `gpt-5.4-mini` from the allowlist. No data, schema, or migration involved;
no on-disk state changes. The only effect of rollback is the tier semantics revert.

## Tests

`frameworkSessionLaunch.test.ts` + `StallTriageNurse.test.ts` updated to the new
mapping (104 pass). 127 codex adapter/canary tests pass. Also corrected a stale
StallTriageNurse fixture that fed a fabricated Codex hint ("press Ctrl+C to cancel")
— Codex's real interrupt hint is "esc to interrupt" per the empirical activity signal.
