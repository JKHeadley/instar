# Side-effects — Model-registry freshness guard

**Change:** add a deterministic, model-id-AGNOSTIC lint that flags when Instar's
per-provider "capable/latest/frontier" model pins have gone stale, plus its
manifest (the human-edit frontier allowlist + `lastReviewedAt`) and a unit test.
Ships **non-gating** (`enforcement: "report"`), dark/reversible.

## Files touched
- `scripts/lint-model-registry-freshness.mjs` (new) — the checker. Two teeth:
  staleness window + per-door allowlist-membership drift. Exports a pure
  `checkModelRegistryFreshness()` for the test; CLI honors `enforcement`.
- `scripts/model-registry-freshness.manifest.json` (new) — the single edit
  surface: `frontierAllowlist`, `pins` (file+regex), `lastReviewedAt`,
  `stalenessWindowDays`, `enforcement`, `doors` (door-status map), `flaggedStale`.
- `tests/unit/model-registry-freshness.test.ts` (new) — 11 tests, both sides of
  both teeth + gating + the shipped manifest's self-consistency.
- `package.json` — appended the lint to the `lint` chain (runs in report mode,
  exits 0, VISIBLE in CI logs) + `lint:model-freshness[:strict]` aliases.
- `docs/LLM-ROUTING-REGISTRY.md` — a freshness-guard pointer note.

## Blast radius
- **CI:** the lint is added to `npm run lint`. In `report` mode it ALWAYS exits
  0, so it cannot break the build while the current list is known-stale. It only
  prints findings/warnings. Flipping `enforcement: "strict"` (a future,
  operator-gated one-line manifest edit) is what makes it gate.
- **Runtime:** NONE. This is build/CI tooling only — it never runs in the server,
  never touches a session, never changes model routing. It reads source files
  and a JSON manifest; it writes nothing.
- **Model IDs:** UNCHANGED. This change deliberately does NOT swap any pinned
  model id — those swaps wait on operator confirmation of exact frontier ids.
  The manifest's allowlist is seeded with the CURRENTLY-pinned ids so drift is
  green today; the known-stale pins are carried in `flaggedStale` as warnings.

## Reversibility
- Delete the two new scripts + test + revert the `package.json`/doc edits.
- Or set `enforcement` stays `report` forever (inert-but-visible).
- No migration, no config default, no state file, no template change.

## Rollback lever
- Remove `&& node scripts/lint-model-registry-freshness.mjs` from the `lint`
  script, or set the manifest `enforcement` to any value other than `strict`.

## Migration parity
- N/A — this is repo-internal CI tooling, not an agent-installed file. No hook,
  config default, CLAUDE.md template section, or built-in skill is changed, so
  `PostUpdateMigrator` needs no entry.

## Follow-ups (operator-gated, NOT in this change)
1. Confirm exact frontier ids (`gemini-3-pro-preview`?, `gpt-5.6 Sol`?) and swap
   the pins + update `frontierAllowlist` + bump `lastReviewedAt` in one change.
2. Then flip `enforcement: "strict"` so the guard gates.
3. Door-liveness gaps surfaced by the audit: codex CLI not installed but routed
   to; Homebrew gemini-cli formula deprecated (disabled 2026-12-18).
