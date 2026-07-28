# Side-Effects Review — Process Health dashboard tab

**Version / slug:** `process-health-dashboard-tab`
**Date:** 2026-05-27
**Author:** echo
**Spec:** `docs/specs/PROCESS-HEALTH-DASHBOARD-TAB-SPEC.md` (v4, converged, approved: true)

## Summary of the change

Adds a read-only dashboard tab that renders the Failure-Learning Loop's data (captures, surfaced patterns, rollout stage) as a calm, plain-English surface. Until now those data were API-only (`/failures*`); this makes them visible in the dashboard. The feature ships with the loop's existing on/off flag — when the loop is disabled every `/failures*` route 503s and the tab renders a friendly disabled state.

**Files changed (source):**
- `dashboard/process-health.js` (NEW, ~504 lines) — browser-native ESM module: pure renderers + the polling controller, both exported for tests. The load-bearing safety contract lives here (`sanitizeForDisplay`, `safeUrl`, `isMixedScript`, friendly-wording maps).
- `dashboard/index.html` — the tab button, panel markup, calm CSS (measurable type bars, no monospace), tab registration, and the lazy-import lifecycle wiring (start on activate / stop on hide).
- `src/server/routes.ts` — ETag/304 on `/failures` + `/failures/insights`, `before=` ISO-validation (400 on garbage), and the `rollout` block assembled in `/failures/analysis` (stage derived from the two `failureLearning` flags).
- `src/monitoring/FailureLedger.ts` — `ListFilter.beforeMs`/`limit`, a new `InsightListFilter` (50-default / 1000-max), a `listInsights` query-builder rewrite (where[]+LIMIT), and a `discovered_at` index for keyset pagination.
- `src/scaffold/templates.ts` — the "Process Health (Dashboard Tab)" CLAUDE.md section for new agents (Agent Awareness Standard).
- `src/core/PostUpdateMigrator.ts` — `migrateClaudeMd` backfill of that section for existing agents + a `migrateFrameworkShadowCapabilities` marker so Codex/Gemini agents learn it (Migration Parity Standard).

**Files changed (tests):**
- `tests/unit/process-health-render.test.ts` (NEW) — sanitize/safeUrl/wording + renderers against jsdom + CSS type-bar assertions.
- `tests/integration/process-health-tab.test.ts` (NEW) — the polling controller's full §4.3 surface (XSS, layout-bomb, race, visibility-gating, staleness hard-fail + 304-pinned, backoff, diff-aware) + the glance no-debug-vocabulary check.
- `tests/e2e/process-health-tab-lifecycle.test.ts` (NEW) — real HTTP server + jsdom-mounted tab, feature ON and OFF; detail.full-never-leaks verified end-to-end.
- `tests/integration/failure-routes.test.ts` — ETag/304, `before=` 400, rollout-stage derivation.
- `tests/unit/FailureLedger.test.ts` — before=/limit pagination + insight clamp.
- `tests/unit/PostUpdateMigrator-processHealth.test.ts` (NEW) — runtime migration + idempotency.
- `tests/unit/feature-delivery-completeness.test.ts` — registered Process Health in `featureSections`; incidentally fixed a pre-existing untracked section (`Cross-Machine Seamlessness`).

**Files changed (dependency):** `package.json` / `package-lock.json` — added `jsdom` as a devDependency (the spec's chosen DOM test harness; no runtime dependency added).

**Files changed (release):** `upgrades/NEXT.md` (NEW) — the upgrade-guide leg, `bump: minor`.

## Decision-point inventory

- **New runtime dependency?** No. `jsdom` is devDependencies only; the tab ships as browser-native ESM with no build step and no new server-side package.
- **New auth surface?** No. The tab is served behind the existing dashboard PIN; it adds no endpoint that wasn't already auth-gated.
- **Untrusted-data rendering** (commit messages, agent diagnoses, classifier output): **render, but only via the sanitize-and-cap helper** — textContent-only DOM writes, NFKC fold, control/bidi/chrome-glyph strip, grapheme-safe caps, same-origin `safeUrl`. Patterns cards are awareness-only with renderer-owned framing and NO action authority.
- **Behavior when loop disabled:** unchanged — routes still 503, tab renders pinned disabled copy (no config-key string, no monospace), never an error.

## Side-effects analysis

- **Behavioral:** Additive. The new route behaviors (ETag/304, `before=`) are backward-compatible — a client that ignores ETags gets a normal 200; omitting `before=` is unchanged. The `rollout` block is a new field on an existing response, not a breaking change.
- **Architectural:** The tab is one self-contained module, not a refactor of the dashboard SPA (explicitly out of scope per spec §10). `listInsights` moved from a ternary to the same where[]+LIMIT builder `list()` already uses — same shape, lower divergence.
- **Security:** The primary surface is rendering untrusted upstream prose on a read tab. Mitigated by the single sanitize path + textContent-only + element-ban (verified by the XSS negative fixture firing no canary and producing zero live elements). The `detail.full` redaction contract is depended upon and verified end-to-end (a seeded secret path never appears in the DOM). Accepted residual: a low-severity social-engineering surface inherent to showing untrusted text — any future *actionable* treatment is gated behind the deferred `InsightRecord.provenance` contract (spec §10).
- **Migration parity:** Covered all three legs — templates.ts (new agents), PostUpdateMigrator (existing agents + shadow markers for Codex/Gemini), and NEXT.md (upgrade guide). Enforced by the Feature Delivery Completeness test.
- **Performance:** ETag/304 + diff-aware rendering means identical ticks do zero DOM mutations and 304s skip body transfer; 304-backoff widens the poll to 5 min after 5 idle ticks. The new `discovered_at` index supports keyset pagination without a full scan.
- **Reversibility:** Fully reversible by reverting the commit. The feature is gated OFF by default via the existing `failureLearning.enabled` flag — no agent sees the tab change behavior until the loop is enabled, and even then it is a read surface.

## Deferred (tracked, not silently dropped)

- **LLM text-smoke (spec §6.4b):** implemented the *deterministic* glance gate (no-debug-vocabulary + plain-state assertion across all 3 fixtures), which is structurally stronger than an LLM judgment for this property and runs in CI. The soft LLM-judgment variant (a Haiku call over the text projection) is deferred as a manual reviewer-attested pre-flight rather than a forever-skipped CI harness — consistent with §6.4a's "honestly labeled soft" framing.
- **Visual dashboard polish / extra ingestion sources:** already tracked as fast-follows on the initiative board (spec §10).

## Evidence pointers

- Typecheck: `tsc --noEmit` — 0 errors.
- CI-mirror smoke suite (`npm run test:smoke`): **149 files, 3553 tests passed, 0 failed**.
- New tests run green in isolation: unit render (27), controller integration (12), failure-routes (11), FailureLedger (11), migrator (2), E2E lifecycle (4).
- Safety verified not asserted: XSS fixture fires no canary + 0 live elements; E2E confirms a seeded `detail.full` secret path is absent from the rendered DOM.
