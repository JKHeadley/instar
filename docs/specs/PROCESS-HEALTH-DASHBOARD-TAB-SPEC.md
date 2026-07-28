---
title: Process Health Dashboard Tab
slug: process-health-dashboard-tab
author: echo
created: 2026-05-27
owner: echo
status: converged
approved: true
eli16-overview: PROCESS-HEALTH-DASHBOARD-TAB-SPEC.eli16.md
topic: 13201
review-convergence: "3 rounds (5/5/4 reviewers); lessons+security declared R3, adversarial+integration declared on v4 recheck; zero open material findings"
---

# Process Health Dashboard Tab — a calm, visible read surface for the Failure-Learning Loop

**Status:** DRAFT v4 (post-round-3, CONVERGED). Author: echo · Created: 2026-05-27 · Topic: 13201
**Companion:** `PROCESS-HEALTH-DASHBOARD-TAB-SPEC.eli16.md`

> **Convergence changelog (v3 → v4 — round-3 tightenings, no scope change).** Round 3 (4 reviewers) declared lessons + security axes converged and narrowed to a small set of within-surface tightenings, all folded here: **(integration MAJOR)** §3 now specifies the real `listInsights` change — it has no named filter / no LIMIT / a ternary query today, so the change is a query-builder rewrite to the `where[]`+`@param`+`LIMIT` pattern `list()` uses, adding BOTH `beforeMs?` and a 50-default/1000-max `limit`. **(adversarial NEW-3, MEDIUM)** §4.1/§4.3 staleness is now tracked **per material section, keyed on the headline's own source endpoint**, with a max-304-age ceiling — a 304-pinned headline endpoint can no longer paint a stale count as fresh while siblings return 200. **(adversarial NEW-1, MEDIUM)** §4.6 rule 8 is now **structural, not an enumerated denylist**: NFKC-fold then strip by Unicode property class (symbols/arrows/box-drawing/dingbats/variation-selectors/bullets), AND all presentation chrome is renderer-owned static literals so no dynamic codepoint can sit where chrome is read. **(adversarial NEW-2)** §4.2b/§4.9 now state the Patterns cards are **awareness-only, carry no action authority**, with framing copy. **(adversarial NEW-4 + integration MINORs)** §2/§4.5/§6.3 reconciled — the operator enable-hint renders as **plain prose, no `<code>`** (no monospace anywhere); §3 clarifies `rollout` is assembled in the route (not `analyze()`) and the 4th maturation stage is a permanently-future `○` (no per-agent config flag). **(security MINOR)** changelog wording below scoped to the render path. **(lessons LOW)** §7 derives the migrate offset from the anchor length, not a magic `15`. Full round-1+2+3 ledger: §9.
>
> **Convergence changelog (v2 → v3 — scope reduction).** Round 2 (5 reviewers) showed v2 over-reached: several ambitions each opened their own attack surface or rested on an unsupported dependency. The disciplined fix is to **do less, safely, in this first slice**, and defer the ambitious bits as tracked fast-follows. **Dropped from v1 slice (→ §10 deferred):** <!-- tracked: process-health-dashboard-tab -->
> - **Tunnel-aware field-hiding (was §4.3.1)** — reused the localhost+XFF signal that the loop spec's round-3 (R3-sec-F12) already proved is a false boundary for cloudflared quick tunnels. → DROPPED. v3 simply **never renders commit OIDs / `specPath` / `prNumber` / `toolchainRef` / `buildSkill` / raw `filedBy` in this tab at all** (operator-safe subset only), so there is nothing to gate **in the tab's render path** — note the underlying `/failures*` routes still RETURN these fields to any PIN-holder; the real data-access boundary (a bearer-token route, not PIN) is deferred (§10). The tab omission is a render choice, not an access control. <!-- tracked: process-health-dashboard-tab -->
> - **Auto-"Attention" headline** (was §4.2 a) — drove a loud headline from `status==='discovered'` insights, which rest on a prose-only upstream diversity-gate guarantee (adversarial B3) and could be gamed by a direct status write. → v3 headline is **informational, not a verdict**: "Watching — N issues recorded." No automated alarm state in v1.
> - **In-product mixed-script warning glyph** (was §4.5) — the `⚠` glyph was itself spoofable (`filedBy="⚠ ledger-spine"`, adversarial B2). → DROPPED; v3 instead renders rows with mixed-script/reserved-glyph content inertly (the offending glyphs are stripped — see §4.6 rule 8).
> - **Screenshot-based LLM smoke** (was §6.4 b) — required a rasterizer (`dom-to-image`/PNG) not in deps; jsdom can't paint pixels (lessons N1, integration N4). → v3 LLM smoke reads the **text projection** of the rendered DOM (jsdom-deployable).
> - **Inline `<code>` of filepaths inside `summary` prose** — required HTML-tokenizing untrusted text (adversarial B5). → DROPPED; filepaths render as plain text.
>
> **Kept + sharpened:** the core rendering-safety contract (§4.6: `sanitizeForDisplay` + `textContent`/`escapeHtml`-only + caps + NFC/control/bidi/reserved-glyph strip + grapheme-safe truncation + `safeUrl` for URL-bearing attributes + no SVG/MathML/iframe/object/embed + static `id`/`name`); the visibility-gated, abort-safe, `Promise.all`-coordinated, diff-aware refresh + ETag/304 + clarified backoff (§4.3); a **staleness escalation** so the headline degrades to a neutral "Connection paused" instead of showing a stale state (§4.1, adversarial B4); explicit `before=<ts>` pagination prerequisite (scalability NEW-1); `/failures/insights` LIMIT+index; `rollout.stage` server-computed field for the maturation display; pinned plain-English copy with no config keys; corrected `migrateClaudeMd` precedent (File Viewer is a bold-paragraph, not H3; `PostUpdateMigrator.ts:3184-3222`); CapabilityIndex cross-ref via the `build()` return (not a nonexistent `notes` interface field). Full round-1+2 ledger: §9.

---

## 1. Problem — live but invisible

The Failure-Learning Loop shipped + activated on Echo (v1.3.27, capture-only). Its `/failures*` data is reachable only via the API — the human has nothing to look at, so the loop's work is invisible and promotion decisions are blind. This adds a calm, visible **Process Health** tab.

## 2. The non-negotiable UX constraint (drives every decision)

Justin's direction ([[feedback_dashboard_human_friendly_not_debug]], a durable preference for ALL future dashboard work): **simple, large fonts, easy to digest, NOT looking like debug logs.** (1) large readable type, (2) plain-English summaries front and center, (3) zero debug-log aesthetic. **Glance-test gate (both halves required, §6.4):** a non-engineer answers "what's happening / what to look at" in <5s.

## 3. What already exists (extend, not reinvent)

- **Dashboard** (`dashboard/index.html`, single SPA served via `express.static`) with a tab framework (`.tab-bar .tab` / `.tab-content`). We add one tab.
- **Data sources** (live on Echo): `GET /failures`, `/failures/analysis`, `/failures/insights`. Server-side prerequisites this spec adds (small, additive):
  - **`?before=<ISO-ts>` on `/failures` + `/failures/insights`** — parsed via `Date.parse`, 400 on `NaN`. For `/failures`: `list()` already takes the named `ListFilter` interface (`FailureLedger.ts:176`) and the `where[]`+`@param` builder (`:432`) — add `beforeMs?: number` to `ListFilter` and one clause `detected_at < @before`, mirroring the existing `sinceMs`→`detected_at >= @since`.
  - **`listInsights` is a real refactor, not a one-line add (integration MAJOR).** `listInsights()` (`FailureLedger.ts:618`) currently takes an **inline anonymous `{ status?: InsightStatus }`** and builds SQL with a **ternary, no `LIMIT`, no params object**. This spec rewrites it to the same `where[]`+`@param`+`LIMIT` builder pattern `list()` uses (`:432-448`), taking `{ status?, beforeMs?, limit? }`: add `discovered_at < @before` when `beforeMs` set, and `LIMIT @limit` clamped **50 default / 1000 max** (the 1000-max mirrors `list()`'s clamp at `:441`; the 50-default is insight-specific — narrower than `list()`'s 200 default, so do NOT copy 200). `/failures/insights` route gains `?limit=50` (default) + `?before=`. New index `CREATE INDEX IF NOT EXISTS idx_insights_discovered ON failure_insights(discovered_at)` (no index on `failure_insights` exists today).
  - **`rollout` on `/failures/analysis`** — `analyze()` (`FailureLedger.ts:515`) returns a fixed literal and has NO config access, so `rollout` is assembled **in the route handler** by spreading: `res.json({ ...ledger.analyze({sinceMs}), rollout })`. `rollout = { stage, enabled, insightTelegramEscalation }` from `config.monitoring.failureLearning.*`. **Stage derivation (exact):** `!enabled`→`'dark'`; `enabled && !insightTelegramEscalation`→`'capture-only'`; `enabled && insightTelegramEscalation`→`'insight-push'`. The 4th maturation stage ("Default for all agents") is a **fleet-wide decision with no per-agent config flag** — it is NEVER returned by `stage` and renders as a permanently-future `○` step (never "you're here").
  - **ETag on all three GETs** — `sha256(JSON.stringify(body)).slice(0,16)`, computed after the full body (incl. `rollout`) is assembled; cache keyed by URL+query; rely on V8 insertion-order, do NOT sort keys.
- **PIN-gated access** (existing). No new auth surface. **No browser test infra today** → this spec adds `jsdom` (devDep) + per-file `@vitest-environment jsdom`; Playwright/screenshot rasterizers explicitly OUT OF SCOPE.

## 4. Design

### 4.1 Layout — top-to-bottom, large-to-small

```
┌─────────────────────────────────────────────────────────────┐
│  Process Health                                              │  ← 22+px
│                                                              │
│   Watching — 4 issues recorded so far                       │  ← BIG headline ≥24px, INFORMATIONAL
│   all linked to a known cause · capture-only mode            │  ← plain-English subline 17-18px
│                                                              │
│  Patterns to know about                                      │  ← 20-22px
│     (Nothing flagged yet. The monitor needs to see a wider   │  ← warm empty state
│      variety of issues before it surfaces a pattern.)        │
│                                                              │
│  What's been captured                                        │
│     A concurrency issue in src/core/Foo.ts, attributed to    │  ← sentence, plain text path
│     the ledger spine, about two days ago.                    │
│     A config-parse problem in the analyzer job, five days    │
│     ago.                                                     │
│     [Show more]                                              │  ← paginates +50 via ?before=<ts>
│                                                              │
│  Maturation                                                  │
│     ● Dark              done                                 │
│     ● Capture-only   ← you're here                           │  ← from /analysis.rollout.stage
│     ○ Insight push                                           │
│     ○ Default for all agents                                 │
│                                                              │
│  [Detail ▾]   collapsed; same UX rules inside                │
│                                              updated 1m ago  │  ← subtle stamp
└─────────────────────────────────────────────────────────────┘
```

**Measurable visual bars:** body ≥17px; section headers ≥20px; headline ≥24px; line-height 1.5–1.6; sans-serif only (no monospace anywhere in this tab — paths render as plain prose text, not `<code>`); spacious padding; no `<table>`/row-banding anywhere (incl. Detail); color palette = the dashboard's existing default text color ONLY, plus at most one neutral accent token (`--ph-accent`) for the maturation "you're here" marker. **No status-alarm colors** (no red/amber headline) — v1 has no verdict state to color. **No spinner/skeleton/flicker**; diff-aware render keyed on id; subtle "updated Ns ago" stamp at the corner.

**Staleness escalation (adversarial B4 + NEW-3 — per-section, keyed on the headline's own endpoint):** the headline NEVER shows a stale data-claim loudly, and freshness is tracked **per material section, not per whole tick** — because a tick can "succeed" (no hard-fail) while one endpoint serves stale snapshot. The headline's count is sourced from ONE endpoint (`/failures`); the headline degrades to `Connection paused — showing the last view from Nm ago` (neutral, no count claim) when EITHER (a) **2 consecutive failed ticks** (any hard-fail), OR (b) **the headline's source endpoint has not returned a fresh 200 within the staleness ceiling** — `headlineEndpointLast200Age > 3 × cadence` — even if sibling endpoints (`/insights`, `/analysis`) keep returning 200 or 304. This closes the "304-pinned headline endpoint while siblings 200" hole: each section stamps the timestamp of ITS OWN last 200, and the corner "updated Ns ago" stamp reflects the headline endpoint's last 200, never the freshest sibling's. A fresh 200 on the headline endpoint restores the normal "Watching — N recorded" headline. The corner stamp is a supplement, never the only staleness signal.

### 4.2 Sections (most-important first)

**(a) Headline (informational, NOT a verdict).** "Watching — N issues recorded so far" + a plain subline ("all linked to a known cause · capture-only mode" / "N still being traced"). **No automated Healthy/Attention alarm state in v1** — that (and the upstream provenance contract it needs) is deferred (§10). <!-- tracked: process-health-dashboard-tab --> This removes the headline-gameability + "loud stale lie" classes entirely.

**(b) Patterns to know about (awareness-only, NO action authority — adversarial NEW-2).** When the loop has surfaced insights, each is a plain-English card: the pattern summary (sanitized + capped, §4.6), the recommendation, and a one-sentence evidence line ("seen across N changes"). **Both `summary` and `recommendation` are untrusted upstream prose** — the recommendation card carries a fixed, renderer-owned framing line *"A pattern the monitor noticed — verify before acting."* (static literal, not from the data) and is rendered calmly and informationally. The card grants **no action authority**: it is never wired to a button, never auto-acted-on, and the "verify before acting" framing is structural copy (not a prefix the data can restate around). This accepts that showing untrusted text is an inherent low-severity social-engineering surface for a capture-only read tab; any *actionable* treatment of a recommendation is gated behind the deferred `InsightRecord.provenance` contract (§10). <!-- tracked: process-health-dashboard-tab --> Empty state: the warm copy in §4.5. The cards never change the headline in v1.

**(c) What's been captured (operator-safe subset only).** Up to 10 most-recent records, each as ONE plain-English sentence. **Rendered fields are limited to the operator-safe subset:** the sanitized `summary`, the `category` (as a friendly word), a DERIVED human attribution label (from an `initiativeId → label` map; falls back to a generic "a tracked feature" if unmapped — NEVER the raw `initiativeId`), and relative time. **NEVER rendered in this tab:** `causeCommitOid`, `fixCommitOid`, `specPath`, `prNumber`, `toolchainRef`, `buildSkill`, raw `filedBy`, `detail.full` (the last is already server-stripped). `[Show more]` paginates in chunks of 50 via `?limit=50&before=<oldest-ts-of-prior-page>`; never an unbounded fetch. Severity is NOT rendered (it's caller-set and gameable; omitting it removes the surface).

**(d) Maturation track.** Four stages (Dark / Capture-only / Insight push / Default-on) as a vertical visual list with a "← you're here" marker. Current stage read from `/failures/analysis.rollout.stage` (server-computed from config, NOT inferred from counts). Read-only; no promote action in this tab.

**(e) `[Detail ▾]` — collapsed; SAME UX rules apply inside.** ≥17px, no monospace blocks, no JSON dumps, no tables. Shows the analyzer's aggregate counts as labeled list items (category distribution, coverage fraction, `unknown`-toolchain bucket size). Renders once on open from the latest analysis payload; refreshes in place only while open.

### 4.3 Data wiring (visibility-gated, abort-safe, coordinated, diff-aware)

**Lifecycle:** one module-level state `{ intervalId, inFlightController, lastSnapshot, consecutiveFailedTicks, consecutive304Ticks, last200At: { failures, insights, analysis } }` (per-endpoint last-fresh-200 timestamps drive the §4.1 per-section staleness ceiling; the headline reads `last200At.failures`).
- **Start** polling when `switchTab('process-health')` is active AND `document.visibilityState==='visible'` (both required).
- **Stop** (`clearInterval` + null + `abort()` in-flight) on tab-switch-away OR `visibilitychange→hidden`.
- **Resume** on `visibilitychange→visible` while active: one immediate refresh + re-arm.
- **Per tick:** new `AbortController` (abort the prior in-flight first); `Promise.all([analysis, insights?limit=50, failures?limit=10])` with `If-None-Match` from the last ETags; **single coordinated render**. A 304 on an endpoint → render that section from `lastSnapshot[endpoint]` (so first-paint-after-reactivation isn't blank; a mixed 200/304 tick renders 304 sections from snapshot + 200 sections fresh — always one consistent paint). If ANY endpoint hard-fails → drop the whole tick, keep prior render, increment `consecutiveFailedTicks` (drives §4.1 staleness escalation).
- **Per-endpoint freshness:** on each 200 for an endpoint, stamp `last200At[endpoint] = Date.now()`. A 304 does NOT advance it (304 ≡ "unchanged since the ETag", not "freshly confirmed now"). The headline's staleness ceiling (§4.1) reads `last200At.failures`; an endpoint that 304s forever crosses `3 × cadence` and is treated as stale even with no hard-fail.
- **Backoff:** a single tick-level `consecutive304Ticks` increments only when ALL THREE return 304; ANY 200 (≡ material change, given deterministic SHA ETags) resets it to 0. At `≥5`, the next `setTimeout` is 300_000ms; a 200 resets to the 60_000ms cadence. The "updated Ns ago" stamp reflects `last200At.failures` (the headline endpoint), never the freshest sibling's.
- **Diff-aware render:** changes detected by record-id / insight-id; mutate only changed nodes (no full `innerHTML` wipe); collapse handlers persist across ticks.

### 4.4 Integration

- Tab button in `.tab-bar` ("Process Health"); `.tab-content#process-health-tab` hidden by default; CSS appended under `/* process-health tab */` with `.ph-*` class names; one `<script>` block. Splitting `index.html` is explicitly out of scope.

### 4.5 Copy (PINNED — plain English, no config keys)

- **Empty (loop on, no patterns):** "Nothing flagged yet. The monitor needs to see a wider variety of issues before it surfaces a pattern — that's expected this early."
- **Empty (no records):** "No issues recorded yet — that just means nothing has come through since this was turned on."
- **Disabled (503):** "Process Health isn't turned on for this agent yet. Once it is, this page will show what it's noticing." + a `[for operators ▾]` collapse with the enable hint rendered as **plain prose, NO `<code>`** (consistent with §2's no-monospace-anywhere rule — e.g. "An operator can enable it by setting the failure-learning monitor to on in the agent config."). No config-key string, no monospace, in any state.
- **Refresh paused:** the §4.1 staleness headline + subtle subline "Couldn't refresh just now — showing the last good view. Will retry."

### 4.6 Rendering safety contract (load-bearing — security + adversarial)

All dynamic values flow through `sanitizeForDisplay(value, fieldKind)` before the DOM:
1. null-coerce; 2. **NFKC-normalize** (folds full-width/variant forms so confusables collapse BEFORE stripping — e.g. `＞`→`>`, `★️`→`★`); 3. strip C0/C1 controls (keep `\n`,`\t`); 4. strip bidi-control (U+202A–202E, U+2066–2069); 5. collapse `>1` `\n` → one, cap whitespace runs at 4; 6. length cap per kind (`summary` 240, `recommendation` 320, derived-label 64, Detail text 2KB), **grapheme-safe** (`Intl.Segmenter`), `…` suffix on truncation; 7. mixed-script (Latin + confusable Cyrillic/Greek) → render the row inertly (no special glyph); 8. **structural presentation-glyph strip (NOT an enumerated denylist):** after the NFKC fold, strip every codepoint in the presentation-symbol classes the tab's own chrome draws from — Unicode `\p{So}` (other-symbol) + arrows/geometric (U+2190–21FF, U+25A0–25FF) + box-drawing (U+2500–257F) + dingbats (U+2700–27BF) + variation selectors (U+FE00–FE0F) + the bullet/middot set (U+2022, U+00B7, U+2027, U+2043). This is a closed structural class, not a hand-listed set, so a confusable variant (`✔` U+2714 vs `✓` U+2713, `⇒` vs `→`, `●︎`) cannot slip past. **Belt-and-suspenders (the real guarantee): all presentation chrome the tab paints — the maturation `← you're here` marker, the record-sentence `·` separator, the `▾` drawer caret, any badge glyph — are emitted as renderer-OWNED static literal nodes, with every dynamic value confined to its own `textContent` node.** No dynamic codepoint can ever occupy a position where chrome is read, regardless of what survives the strip.

**DOM insertion (mandatory):**
- Dynamic values → `element.textContent` ONLY, or `escapeHtml()` if assembled into a structural `innerHTML` template. No naked `innerHTML` interpolation of dynamic values.
- Allowed DOM destinations for dynamic values: `textContent`, `setAttribute('class', LITERAL)`, `setAttribute('aria-*', LITERAL)`. URL-bearing attributes (`href`, `src`, `style`, `srcset`, `data-*`, `formaction`) are FORBIDDEN for dynamic values unless passed through `safeUrl()` (must start `http:`/`https:`/`/`/`#`; reject `javascript:`/`data:`/`vbscript:`/`file:`; reject off-allowlist hosts; empty string on reject). Inline `style=` interpolation of dynamic values is forbidden outright.
- `id`/`name` attributes are static literals (no DOM-clobbering).
- **No `<svg>`, `<math>`, `<iframe>`, `<object>`, `<embed>` elements appear in the tab DOM at any time.**

**Server-side hardening (flagged follow-up, §10):** apply equivalent caps + sanitization at the `POST /failures` boundary in `FailureLedger`. The dashboard caps are defense-in-depth. <!-- tracked: process-health-dashboard-tab -->
<!-- Every such item in this spec is catalogued in §10 (a tracked fast-follow list) and auto-registers on the graduated-rollout board under initiative `process-health-dashboard-tab` on merge. -->

### 4.9 Upstream trust dependencies

This tab trusts that `FailureLedger.toApiView` strips `detail.full` (loop spec §4.8; §6 asserts the rendered DOM never contains a `detail.full`-class field). Because v3 drops the auto-Attention headline, the tab no longer depends on the analyzer's diversity-gate for any *verdict* — insights are shown informationally only. The Patterns cards (§4.2b) render untrusted upstream `summary`/`recommendation` prose **for awareness only, with no action authority** — calmly, with a renderer-owned "verify before acting" framing, never wired to an action. This is an accepted low-severity social-engineering surface inherent to displaying untrusted text on a read tab. If a future iteration re-introduces an alarm headline OR makes a recommendation actionable, it MUST first add a structural provenance field to `InsightRecord` (deferred, §10) — prose trust is insufficient for a verdict or an action. <!-- tracked: process-health-dashboard-tab -->

## 5. Open questions — none material (all resolved/deferred; §10). <!-- tracked: process-health-dashboard-tab -->

## 6. Testing (3-tier + glance test, NON-NEGOTIABLE)

**Infra:** jsdom (devDep) + per-file `@vitest-environment jsdom`. No Playwright/screenshots.

- **6.1 Unit** (`tests/unit/process-health-renderers.test.ts`): pure `data→DOM` renderers in 3 states (empty / patterns-present / high-volume). `sanitizeForDisplay` rules 1–8 each with both-side fixtures (incl. `<script>`, 100k chars, U+202E, U+200D spam, mixed Cyrillic/Latin, mid-surrogate truncation guard). **Rule 8 structural-strip fixtures (NEW-1):** the enumerated chrome glyphs AND their confusable variants must ALL be stripped — `✓`(U+2713) AND `✔`(U+2714), `→` AND `⇒`/`➜`, `●` AND `●︎`(+VS U+FE0E), `★️`(+VS U+FE0F), full-width `＞`/`：` (must fold to `>`/`:` via NFKC then be harmless), bullet/middot `•`/`·`, box-drawing `│┌└`; assert a `summary` of `"done ✔ ← you're here"` renders with NO `✔` and NO `←` surviving. **Chrome-isolation fixture:** assert the maturation marker / separator / caret nodes are static literals NOT derived from any record field (a record whose every field = `"← you're here"` must not produce a second "you're here" marker). `safeUrl` accept/reject table. Operator-safe-subset assertion: rendering a full record produces NO commit OID / specPath / raw filedBy substring.
- **6.2 Integration** (jsdom): all 3 fixtures render; CSS bars (`getComputedStyle` font-size ≥17/≥24, line-height 1.5–1.6, no monospace); **XSS negative** (`summary`/`recommendation`/`filedBy` with `<img onerror>`, `<script>`, `<svg onload>`, `<math href=javascript:>`, `javascript:` URL, `<form id=document.body>` → assert `tabRoot.querySelectorAll('img,script,svg,math,iframe,object,embed').length===0`, `window.__xssCanary===undefined`, no `javascript:` in any attribute); **layout-bomb** (100k-char summary → serialized DOM byte-length < 8× empty baseline); **race** (out-of-order conflicting fetches → one consistent paint or skip, never hybrid); **visibility-gating** (hidden → interval cleared + in-flight aborted; visible → one fetch + re-arm); **staleness — hard-fail** (3 consecutive 5xx → headline contains "Connection paused", NOT a stale count claim); **staleness — 304-pinned headline endpoint (NEW-3)** (`/failures` returns 304 for the whole run while `/insights` + `/analysis` keep returning 200 → once `last200At.failures` age crosses `3 × cadence`, the headline must reach "Connection paused" and the corner stamp must reflect `last200At.failures`, NOT the freshest sibling's 200); **backoff** (5 all-304 ticks → next `setTimeout` arg 300_000; then a 200 → 60_000); **diff-aware** (3 identical ticks → 0 DOM mutations after first paint); **detail.full** never in DOM.
- **6.3 E2E** (`tests/e2e/process-health-tab-lifecycle.test.ts`): boot in-memory `createRoutes` with the feature ON, mount tab in jsdom, assert loads/renders/refreshes/never-leaks; with feature OFF, assert the pinned 503 copy (no config-key string AND no monospace/`<code>` element anywhere in the tab DOM, incl. the expanded operator hint — NEW-4). Also assert `/failures/analysis.rollout.stage` is one of `dark`/`capture-only`/`insight-push` (never a 4th value) and the maturation track's 4th step renders as `○` (never "you're here").
- **6.4 Glance test (mandatory, AND — both required):**
  - **(a) Human (PR review):** a non-engineer opens the rendered tab against all 3 fixtures on a phone-size viewport, answers "what's happening / what to look at" in <5s. Recorded as a PR-description checkbox + a reviewer comment by a GitHub login ≠ the PR author. (Soft gate, reviewer-attested — honestly labeled as such, not claimed as CI-enforced.)
  - **(b) LLM text-smoke (CI, pre-flight):** for each fixture, jsdom renders the tab; the **visible-text projection** (a `textContent` walker emitting block breaks) is passed to a Haiku call (via the existing `IntelligenceProvider.evaluate()` surface) with the EXACT rubric: *"You are a non-engineer glancing at this page. In ONE sentence, without reading carefully: what is this page telling me, and what state is it in?"* Assert: response ≤30 words; contains NO {log, json, table, raw, stack, console, endpoint, API}; mentions a plain state word; mentions implied action or explicitly none. All 3 fixtures must pass.

## 7. Migration parity

- `dashboard/index.html` ships with the server bundle (`package.json files` includes `dashboard`); AutoUpdater apply lands it; no migration for the HTML.
- Server prereqs (§3) ship in the same `src/` change; `CREATE INDEX IF NOT EXISTS` is idempotent (runs in `FailureLedger` constructor on boot — AutoUpdater restarts re-instantiate it); `rollout` field + `before=` param + ETag are additive.
- **CLAUDE.md awareness (Agent Awareness + Migration Parity):**
  - `generateClaudeMd` (`src/scaffold/templates.ts:546`): add a new **`**Process Health (Dashboard Tab)**` bold-paragraph section** (NOT H3 — matches the File Viewer precedent style) immediately after the File Viewer block, incl. the proactive trigger ("when user asks 'is the loop noticing anything? / how's the rollout going?' → point to the Process Health tab, don't paraphrase `/failures*` curl").
  - `migrateClaudeMd` (`src/core/PostUpdateMigrator.ts`): add `migrateProcessHealthTabSection()` modeled on the File Viewer migration at **lines 3184–3222**. Anchor on `const anchor = '**File Viewer'; const anchorIdx = content.indexOf(anchor)`, then find the next section break with `content.indexOf('\n\n**', anchorIdx + anchor.length)` (derive the offset from `anchor.length` — do NOT copy the `+ 15` magic constant from the `'**Dashboard**'` precedent, which is anchor-specific), insert there; idempotency guard `!content.includes('**Process Health (Dashboard Tab)**')`.
- **CapabilityIndex** (`src/server/CapabilityIndex.ts:503-518`): extend the `failureLearning` entry's `build()` RETURN with `dashboardTab: 'Surfaced as the Process Health tab in the dashboard when enabled.'` (a new key in the response body — NOT a `CapabilityEntry` interface field, which nothing reads). The new `/failures/visibility-mode`... — N/A, dropped with §4.3.1. No new route prefix → no capabilities-lint entry needed (the `rollout` field + `before=` are response/param changes to existing routes).
- No `migrateConfig` change.

## 8. Success criteria

A user opens the dashboard, taps **Process Health**, and within 5s knows: what's the loop watching, what's been captured, where are we in the rollout — without a developer-console feel. **Post-ship verification (within 7 days):** Justin (or a non-engineer delegate) glances on a phone ≤5s, answers the two glance questions; recorded as a `learn` (this is the bar for future dashboard work) or a `feedback` (reopen, don't patch in flight).

## 9. Findings ledger (rounds 1 + 2 + 3)

**Round 3 (resolved by v4 tightenings; lessons + security axes declared converged):** `listInsights` change understated — no named filter/LIMIT/ternary today (integ MAJOR) → §3 specifies the `where[]`+`LIMIT` rewrite + 50/1000 clamp. Per-tick staleness lets a 304-pinned headline endpoint show stale count as fresh (adv NEW-3, MEDIUM) → §4.1/§4.3 per-section freshness keyed on `last200At.failures` + `3×cadence` ceiling. Enumerated glyph denylist misses confusables `✔`/`⇒` (adv NEW-1, MEDIUM) → §4.6 r8 NFKC-fold + Unicode-property-class strip + renderer-owned static chrome. Patterns cards still a social-eng surface (adv NEW-2) → §4.2b/§4.9 awareness-only, no action authority, "verify before acting" framing. `<code>` operator hint contradicts no-monospace (adv NEW-4) → §4.5 plain prose. `rollout` assembled in `analyze()`? + 4th stage unmappable (integ MINORs) → §3 route-assembled + 4th stage permanently-future `○`. "nothing to gate" over-claims (sec MINOR) → changelog scoped to render path + §10 acknowledges PIN-holder data access. `+15` magic offset (lessons LOW) → §7 derives from `anchor.length`.

**Round 2 (resolved by v3 scope reduction):** tunnel-mode false boundary (sec B1) → DROPPED §4.3.1, render operator-safe subset only. Mixed-script glyph spoof (adv B2) → DROPPED glyph + reserved-glyph strip (§4.6 r8). Auto-Attention headline gameable + no provenance (adv B3) → headline is informational only (§4.2 a); provenance deferred (§10) <!-- tracked: process-health-dashboard-tab -->. Stale-loud-headline (adv B4) → staleness escalation (§4.1). Screenshot smoke undeployable (lessons N1 / integ N4) → text-projection smoke (§6.4 b). Human-gate policy-not-structure (lessons N2) → honestly labeled soft/reviewer-attested (§6.4 a). `<code>` summary tokenizing (adv B5) → plain-text paths. URL/attribute/SVG/MathML/clobber gaps (sec M1/M2) → §4.6 safeUrl + destination allow-list + element ban + static ids. `before=` unsupported (scale NEW-1) → §3 prereq. ETag/304 + backoff edge cases (scale NEW-2/3/4) → §4.3 clarified. friendly-name map undefined (lessons N3) → §4.2 c + map seeded in same PR. migrateClaudeMd citation wrong (integ N1) → §7 corrected (bold not H3, lines 3184-3222). `notes` field nonexistent (integ N2) → §7 via `build()` return. trust-deps prose-only (adv M1) → moot for v1 (no verdict); §4.9 + deferred provenance. <!-- tracked: process-health-dashboard-tab -->

**Round 1 (resolved in v2, carried):** glance test AND + 3 fixtures + rubric (lessons F1/F6 → §6.4); Detail-drawer same rules (F2 → §4.2e); XSS contract (sec/adv B1 → §4.6); length/Unicode caps (adv B2 → §4.6); copy pinned no config keys (F3/sec M2 → §4.5); refresh visuals (F4 → §4.1); sentence records (F5 → §4.2c); visibility-gating + lifecycle (scale M1/M3 → §4.3); pagination (scale M2 → §4.2c); listInsights LIMIT+index (scale B1 → §3); coordinated render (adv M1 → §4.3); severity not visual (adv M2 → omitted entirely §4.2c); jsdom not Playwright (integ F2 → §6).

## 10. Deferred (tracked fast-follows — own future specs when warranted) <!-- tracked: process-health-dashboard-tab -->

- **Auto-"Attention" alarm headline** + the structural **`InsightRecord.provenance`** contract (diversity-gate proof) it requires — when the loop reaches insight-push maturity.
- **Tunnel-aware exposure of repo internals** (commit OIDs, paths) — needs a real second-factor (bearer-token route, not PIN), not a localhost+XFF guess.
- **Server-side `POST /failures` input caps + sanitization** — the real fix; this spec's caps are defense-in-depth.
- **`contract.version` enforcement** between this tab and the loop's API shape — when the loop API stabilizes post-1.0.
- **Real-browser visual smoke** (puppeteer) — if the text-projection smoke proves insufficient.
- **Dashboard SPA modularization** (split `index.html`) — separate spec.
