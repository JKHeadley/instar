# Side-Effects Review — Cross-model review on the codex CLI (Step B)

**Slug:** `codex-crossreview-stepB`
**Date:** 2026-06-01
**Author:** echo
**Spec:** `docs/specs/codex-crossreview-stepB-spec.md` (approved by Justin + abbreviated convergence, 5 findings folded)
**Project:** Step B of the Tiered Development Process (`docs/projects/tiered-dev-process/PROJECT.md`)

## Summary of the change

Re-platforms the external **cross-model reviewer** in spec-review-convergence from the
(placeholder) `/crossreview` API path onto the **installed codex CLI**, so every instar
agent with codex gets a GPT-tier second opinion for free, no API keys. Honors the
constitution's **Signal vs. Authority** — the external review is *signal*, never a
blocking authority; an absent/failed reviewer is disclosed loudly, never faked.

**Files changed (in-scope):**
- `src/core/crossModelReviewer.ts` (NEW) — detection (`detectCodexReviewer` /
  `detectCrossModelReviewer`: codex binary present AND OAuth `tokens.access_token` AND
  Rule-1 clean), the `SUPPORTED_REVIEWER_FRAMEWORKS` registry (codex first; one entry per
  future framework), the reviewer driver (routes the cross-model prompt through the
  existing `buildIntelligenceProvider({framework:'codex-cli'})` → gpt-5.5, 120s, reusing
  the provider's env allowlist + the factory circuit breaker), `assembleReviewerPrompt`
  (inlines the spec in full + referenced context under a 60KB budget with **deterministic**
  priority order — constitutional docs first — and a truncation note that **names** the
  partial + omitted docs), `parseReviewerReply` (never throws/zeroes), and the flag
  machinery: `buildCrossModelFlag` + `aggregateRoundOutcomes` producing one of
  `codex-cli:<model>` (ran) / `degraded` / `degraded-all-rounds` / `unavailable` /
  `skipped-abbreviated`. Never throws, never blocks.
- `skills/spec-converge/scripts/cross-model-review.mjs` (NEW) — the thin CLI the skill
  shells out to (does only repo file-I/O — codex is sandboxed with no repo access —
  delegating logic to compiled `dist/core/crossModelReviewer.js`; always exits 0).
- `skills/spec-converge/scripts/write-convergence-tag.mjs` — `--cross-model-review` /
  `--cross-model-reason` args writing the `cross-model-review:` frontmatter field
  (idempotent, YAML-safe quoting).
- `skills/spec-converge/SKILL.md` — replaced the `/crossreview` placeholder with the real
  invocation; Phase 3 documents per-round aggregation (→ `degraded-all-rounds` when a
  framework was present but **zero** rounds got a successful pass); Phase 4 renders a loud
  `⚠` banner for **every** non-ran state (a real pass is the only unmarked one); Phase 5
  the valid flag values. Internal reviewers + the Standards-Conformance Gate unchanged.

**Files changed (not in-scope):** `skills/spec-converge/templates/reviewer-cross-model.md`
(patched: spec + context are "inlined below" — no file-read instruction codex can't
follow — and dropped the three-phantom-model GPT/Gemini/Grok framing → one codex pass);
the spec + ELI16; tests (`tests/unit/crossModelReviewer.test.ts` 45,
`tests/unit/write-convergence-tag-crossmodel.test.ts` 5,
`tests/integration/cross-model-review-flow.test.ts` 3).

## Blast radius

Additive. The new module is pure/injectable except the one provider call (reusing the
hardened codex provider). The convergence flow gains a real external reviewer where it had
a placeholder; the internal reviewers, the lessons-aware (non-skippable) reviewer, and the
Standards-Conformance gate are untouched. The reviewer never throws and never blocks — the
worst case is a loudly-disclosed `unavailable` / `degraded` / `degraded-all-rounds` flag.
The `cross-model-review:` flag is **disclosure, not a gate**: it does NOT touch the
`review-convergence` + `approved` enforcement in `instar-dev-precommit.js`.

## Risks considered

- **Could a failed/absent review read as a clean pass?** No (convergence Finding 1/2): every
  non-ran state carries a loud `⚠` banner, and a convergence where a framework was present
  but *no* round ever succeeded collapses to a spec-level `degraded-all-rounds` (as loud as
  `unavailable`) — "never actually got an external opinion" surfaces at spec level.
- **Silent partial context?** No (Finding 4): truncation is deterministic (constitutional
  docs first) and the note names the partial + fully-omitted docs.
- **API-key leak through codex?** No — reuses `buildCodexChildEnv()`'s allowlist; Rule-1
  (`validateRule1`) forbids an API-key-shaped credential; detection requires OAuth.
- **Cost?** Worst case ~10 capable-tier calls per spec (the 10-round convergence cap × 1
  call/round), bounded by the account circuit breaker. Stated in the spec.

## Migration parity

**None needed — verified.** `/spec-converge` is dev-only tooling: it is NOT in
`package.json` `files[]` and NOT installed by `installBuiltinSkills()`, so it never lands
in an end-agent home. No `PostUpdateMigrator` change. (The agents that *develop* instar get
it from the repo.)

## Tests / lint

`npx tsc --noEmit` exit 0; Step-B tests 53 green (45+5 unit, 3 integration); `npm run lint`
(tsc + destructive/LLM-http/url-log/codex-drift) green. (The worktree's ~28 pre-existing
local failures — node v25.6.1 + real-config + tunnel — are independent and CI-green.)
