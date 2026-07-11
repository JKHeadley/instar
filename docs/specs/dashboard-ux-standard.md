---
title: "Dashboard UX Standard — Reachable, Self-Explanatory, Responsive"
slug: "dashboard-ux-standard"
author: "echo"
status: "approved"
parent-principle: "Structure beats Willpower — a quality bar that lives only in a style guide is a wish; a floor enforced in CI is a guarantee."
created: "2026-07-08"
topic: 29723
approved: true
approved-provenance: "F1–F9: operator (Justin), topic 29723, 2026-07-08 — 'Yes, please proceed as you see fit'. F10–F11 (glance floors): operator (Justin), topic 29836, 2026-07-10 18:10 PDT — 'Perfect, yes approved', reacting to the three-layer / two-floor / 4-phase proposal (APPROVED-PROPOSAL.md)."
decisions: "FD-1=grouped nav (operator); FD-2=viewport smoke test as a browser-gated CI job, SKIP-honest when no browser; FD-3=F7 soft-lint-first; FD-4=purpose line is the floor, inline help nice-to-have; FD-5=F10 glance floor = one headline + ≤5 tiles + ≤150 words + no insider vocab; FD-6=F11 universal drill-down = every tile/count/row/badge opens a detail layer (list → record), no dead-end summaries; FD-7=floors gate NEW/RETROFIT work, existing tabs grandfathered against the survey-scorecard baseline (ratchet: the grandfather list only shrinks)"
review-convergence: "2026-07-11T01:45:40.702Z"
review-iterations: 3
review-completed-at: "2026-07-11T01:45:40.702Z"
review-report: "docs/specs/reports/dashboard-ux-standard-convergence.md"
cross-model-review: "gemini-cli (degraded: cli-routing-retries; direct-invoked, 2 findings incorporated)"
cross-model-review-reason: "codex-not-installed; gemini-cli present but wrapper needs worktree dist build, so direct-invoked"
---

# Dashboard UX Standard — Reachable, Self-Explanatory, Responsive

## Problem statement

The operator directive (2026-07-08, topic 29723, verbatim): *"we DESPARATELY need to
improve the UI and user experience in the dashboard. At the very minimum make sure the
views/elements are properly responsive. Right now on desktop everything is squished to
the side. We should have a VERY STRONG/HIGH STANDARD for all the dashboard UI to be VERY
user friendly. All features should be VERY CLEARLY self explanatory and self contained
and EASY to navigate and use."*

The dashboard grew to **25 tabs** with no structural bar for layout, navigation, or
self-explanation. Each tab was hand-authored with inline styles; quality drifted tab by
tab because nothing enforced a floor. This standard turns the operator's bar into
**enforceable CI floors** so the quality cannot silently regress as tabs are added — the
same "structure over willpower" move that PR #1403 applied to panel placement.

## Audit evidence (2026-07-08, deployed dashboard v1.3.786)

Grounded three ways: source structure, the two live render viewports (reusing PR #1403's
headless captures), and per-panel markup inspection.

**Navigation (most severe).** At 1280px the top nav renders only ~8 of 25 tabs
(Sessions … Integrated-Being, the last already truncated) and then simply **cuts off with
no overflow affordance** — no scroll, no wrap, no "more" menu. The remaining ~17 tabs
(PR Pipeline, Projects, Initiatives, Commitments, Tokens, Resources, LLM Activity, Routing
Map, Spend, Threadline, Evidence, Process Health, Subscriptions, Preferences, Machines,
Mandates, Blockers) are **unreachable by pointer at desktop width**. In the very capture,
the *active* tab (Routing Map) is not present in the visible nav. This is the literal
opposite of "EASY to navigate."

**Responsiveness at mobile (390px).** Panel content overflows the viewport horizontally —
the description text and cards are clipped at the right edge; `document.body` scrolls
sideways. (The hamburger nav collapse itself works — the failure is panel width, not the
nav.) This is pre-existing and independent of #1403.

**Desktop layout.** PR #1403 fixed the "squished into the 280px sidebar column" bug
structurally (shared `.tab-panel` placement + a floor test). This standard **codifies**
that fix as a permanent floor rather than a one-off.

**Self-explanation.** 7 of 25 tab panels ship with **no plain-language purpose line**:
Files, Send Content (dropzone), Features, Subscriptions, Preferences, Mandates, and the
Sessions default view. A user landing on them must infer the tab's job from control labels
alone. Where descriptions DO exist they often lean on unglossed jargon ("lane", "door",
"metered", "money-gated", "must never take untrusted input").

**Assets / polish.** The header logo `<img src="/dashboard/logo.png">` renders broken
(alt "Inst" + broken-image glyph) **in the headless captures** — but this is a
STATIC-RENDER ARTIFACT, not a live defect: `logo.png` exists (601KB) and is served by
`express.static('/dashboard')` on the real server, so it resolves live; only the `file://`
scratch render (no asset serving) shows it broken. Corrected 2026-07-08 against the deployed
serving path. F8 (assets resolve) remains a valid floor, but the specific logo finding was a
false positive of the verification method.

**Root structural cause.** No shared component vocabulary. ~300 inline `font-size`/color
declarations, per-panel bespoke markup, and the placement bug all trace to the same thing:
there was no enforced contract a new tab had to satisfy.

## The bar as enforceable floors

Each floor is objective (a machine can check it) and cites the evidence that motivates it.
Floors are **additive and reversible** — they gate NEW regressions and are brought in tab
by tab; a floor never blocks an unrelated change.

- **F1 — Panel placement (SHIPPED in #1403; codified here).** Every tab panel spans the
  content column, never auto-places into the sidebar. Enforced by the existing
  `dashboard-panel-placement.test.ts`.

- **F2 — Every tab is reachable at every supported viewport (NEW, top priority).** The tab
  navigation must present a reachable affordance for *every* registered tab at ≥1280px,
  768px, and ≤390px — via horizontal scroll, wrap, a grouped/overflow menu, or a
  restructured nav. Enforced by: a static test asserting the nav container is scrollable or
  wrapping (not a fixed-width clip), plus a registry-completeness check that every
  `TAB_REGISTRY` id has a corresponding reachable nav control.

- **F3 — Every tab carries a plain-language purpose line.** The first child of every panel
  after its header is a one-sentence, jargon-glossed description of what the tab is for and
  what the user can do there. Enforced by a static test: every panel id in `TAB_REGISTRY`
  has a designated description element (shared `.tab-purpose` class).

- **F4 — The body never scrolls horizontally.** At each supported viewport, `document.body`
  has no horizontal overflow; wide content (tables, wide cards, code) scrolls inside its own
  `overflow-x:auto` container, not the page. Enforced by a viewport smoke test (see
  Enforcement).

- **F5 — Every control is labeled.** Every interactive control (button, `select`, `input`)
  has a visible text label or an `aria-label`. No icon-only or bare controls whose function
  a user must guess. Enforced by a static test over control elements in panel markup.

- **F6 — Empty / loading / error states are self-explanatory.** No panel shows a bare
  "Loading..." as its resting state or a blank area. Every data region states what will fill
  it and the action to populate it (or an honest "nothing yet, here's how"). Enforced by a
  static check that data containers declare a non-bare empty-state template.

- **F7 — Shared component vocabulary (guideline → floor).** Cards, purpose lines, stat
  tiles, and controls use shared classes, not per-tab inline styles, so one style change
  moves the whole dashboard. Ships first as a lint-warning (soft), promoted to a hard floor
  once the tabs are migrated (avoids a big-bang rewrite).

- **F8 — No broken assets.** Referenced images/icons resolve. Enforced by a static check
  that asset references have a real target (or are inlined).

- **F9 — A background refresh never clobbers an open interaction (added 2026-07-10, topic
  29836 case study).** Any dashboard surface that polls/re-renders MUST NOT replace an
  element holding an open interaction: an in-progress multi-step episode (marked
  `data-interaction-open`), a focused text-entry element, or a dirty (partially-typed)
  field. While an interaction is open the poll MERGES server state into the view
  (targeted patches — e.g. live countdowns via `data-ttl-expires`) instead of rebuilding
  the interacting DOM; the hold releases when the flow reaches a terminal state
  (verified / failed / cancelled / expired) or the user backs out. Evidence: the
  Subscriptions matrix "Set up" flow reverted the PIN input to a button mid-typing and
  swapped the code-paste step for "◷ Signing in…" before the code could be pasted
  (screenshot-proven, 2026-07-10). Shared primitives: `hasOpenInteraction` +
  `updateCountdowns` in `dashboard/subscriptions.js`. Enforced by
  `tests/unit/dashboard-refresh-interaction-hold.test.ts` (semantics + a negative
  control proving a naive rebuild WOULD clobber) and the Subscriptions controller
  integration tests (a poll mid-interaction leaves the typed state intact). Migrating
  the other polling tabs (mandates, process-health, preferences) onto the shared
  primitives — and promoting F9 to a static lint over `dashboard/*.js` — is a tracked
  follow-up <!-- tracked: topic-29836 --> ; until then F9 is a hard floor for the
  Subscriptions tab and the rule of record for every NEW polling surface.

## The glance floors — readable at a glance, details one click down (added 2026-07-10, topic 29836)

The nine floors above make the dashboard reachable, labeled, and stable. They do
not make a view *digestible*: a tab can pass every floor above and still dump 972
words of raw internal records (IDs, `cadence: 1800s`, `atRisk`) on its front page.
The operator directive that motivates F10/F11 (2026-07-10, topic 29836, paraphrased
from the approved proposal): *every main view should be simple and digestible at a
glance with almost no jargon, and every element should be clickable to drill into
detail.* These two floors are the whole-view structural application of the
constitution's **Operator-Surface Quality** standard (lead with the answer, expose
zero raw internals as primary content, plain language) — extended from
authorization surfaces to every standing dashboard view.

The shape is three layers, and nothing is lost — the IDs and raw detail still
exist, they just move one or two clicks down instead of living on the front page:

- **Layer 1 — glance.** One plain-English headline sentence answering "what's the
  state of this?", then at most 5 big labeled tiles (counts / states / trends) in
  everyday words.
- **Layer 2 — list.** Click a tile/count → the rows behind that number, each in
  plain words ("Promised Justin a code — waiting on the vendor since June 2").
- **Layer 3 — record.** Click a row → the full record, where the IDs, timestamps,
  cadences, and raw JSON belong.

**The load-bearing invariant (added after spec-converge round 1): Layer 1 is 100%
component-authored.** The glance layer contains ONLY strings the component itself
composes — the headline (assembled from counts) and each tile's label + value
(a count, or a short component-authored state word). **No agent-authored or
user-authored free text ever appears at Layer 1.** That free text (a commitment's
summary, a promise's wording) lives at Layer 2/3, where it is *displayed* through
the shared sanitizer, never *vocab-gated*. This invariant is what makes F10's
jargon check safe: it scans component-authored text only, so a user phrasing a
promise as "fix the atRisk cadence: 1800s" can never blank the operator's glance
(it is Layer-2 content, sanitized-displayed) — and it is what makes the check
*complete*: because Layer 1 is entirely component copy, scanning all of it (headline
+ every tile label + every tile value) leaves no free-text hole to hide jargon in.

- **F10 — Glance floor (NEW, topic 29836).** Every main view's pre-interaction
  front page is: **one plain-English headline sentence** + **at most 5 big labeled
  tiles** in everyday words, **≤ 150 words total before user interaction**.
  **Insider vocabulary may not appear anywhere at the glance layer** — the check
  scans the concatenation of the headline + every tile label + every tile value,
  after NFKC-normalising and tokenising (splitting on hyphen / underscore /
  whitespace / punctuation, with a per-token max length so a glued
  `carrying-664-open-cmt953` string can neither dodge the word count nor the ID
  matcher). Banned, case-insensitively: **internal IDs** (a letter-run adjacent to
  3+ digits — `CMT-953`, `CMT_953`, `cmt953`, `machine-4f3a`, `m_<hex>` — a
  separator-agnostic heuristic, not a per-prefix literal); **machine-duration
  cadences** (a bare number glued/spaced to a time unit — `1800s`, `1800 s`,
  `1800sec`, `1800000ms`, `PT30M` — excluding 4-digit-year/decade prose like "the
  1800s"); **config keys** (camelCase / snake_case identifiers); and a curated
  **insider-TERM denylist** for concept-jargon the form heuristics miss (`atRisk` /
  "at risk" / "at-risk", `suppressed`, `beacon`, `cadence`, `heartbeat`, `lane`,
  `door`, `reflow`, `TTL`, `SLO`, and peers — extended as new jargon is found).
  Enforced by `validateGlanceSpec` in `dashboard/glance.js` — the shared component
  **refuses to build** an over-budget or jargon-carrying glance and renders an
  **honest degraded glance** (the headline truncated to budget + a "See details"
  drill), **never a raw-record fallback** — and by the F10 word-budget test
  `tests/unit/dashboard-glance-word-budget.test.ts`, which (a) proves the validator
  flags >5 tiles, >150 words, and every insider-vocab class *and its bypass
  variants* (spaced / glued / snake / NFKC look-alike) with a negative control on
  each side of the boundary; and (b) renders every glance-adopted tab's real builder
  with **adversarial fixtures** (large N, null/empty/error states, a commitment
  whose free text contains banned tokens) and asserts the produced glance conforms —
  proving the jargon can't leak up from the data.

- **F11 — Universal drill-down (NEW, topic 29836).** Every tile, count, row, and
  status badge at the glance layer is clickable and opens the next layer of
  detail — **no dead-end summaries**. Opening a tile must reveal a Layer-2 container
  that is **non-empty and textually distinct from the glance** (≥1 receipt row for a
  non-zero count), or — for a zero-count tile — an **honest F6 empty-state**
  ("nothing here right now"), never a re-render of the same summary. Tapping a
  receipt opens the full record (Layer 3). Enforced by the per-view conformance
  checklist (the baseline table below) + the F11 walk-every-tile test
  `tests/unit/dashboard-glance-drilldown.test.ts`, a jsdom test that activates
  *every* tile of every glance-adopted tab and asserts the opened layer is
  non-empty-and-distinct (or an honest empty-state), with negative controls proving
  BOTH a dead-end tile (no drill handler) AND a "drill re-renders the same summary"
  tile fail the walk. F11 composes with **F9**: the glance component holds an open
  drill interaction (a focused field / in-progress episode marked
  `data-interaction-open`, or a dirty field) across a background refresh, reusing the
  shipped `hasOpenInteraction`; while held it patches the live tile counts via a
  targeted `data-*` merge (mirroring `updateCountdowns`) instead of rebuilding over
  the interaction. The drill container is a single **replaced** node (never appended
  per open), so repeated open/close cannot leak detached DOM or listeners.

- **XSS / display-safety (mandatory for the component, added round 1).** The glance
  component renders agent- and user-authored text at Layer 2/3. It MUST reuse the
  Subscriptions tab's load-bearing safety contract: all dynamic values through the
  shared `sanitizeForDisplay` (NFKC-fold + strip control / bidi / confusable-chrome
  glyphs + grapheme cap), **all DOM writes via `textContent`, never `innerHTML`**,
  and any styled/attribute value from a fixed literal allowlist or a clamped number
  only (tile state → literal colour; any id in an attribute or URL via
  `encodeURIComponent`). `sanitizeForDisplay` is extracted from `subscriptions.js`
  into a shared module so both surfaces share one bar. The F11 test carries an
  XSS/attribute-injection negative control: a commitment summary / tile label
  containing `<img onerror=...>`, a `"`-style-breakout, and an RLO bidi character
  must render inert. (The jargon check is a readability floor, **not** a
  secret-redaction boundary — secret handling stays at the API/data layer, which
  this change does not touch.)

### Conformance baseline — the survey scorecard (grandfathered, ratchet-style)

F10/F11 gate **NEW and RETROFIT** work; they do not retroactively fail the 26
existing tabs on the day they land. The initial conformance baseline is the live
survey from the approved proposal (driven through the real dashboard, 2026-07-10).
Existing tabs are **grandfathered with a tracked gap**; each retrofit
<!-- tracked: topic-29836 --> happens in a later phase (2–4) and removes that tab
from the grandfather list. **The grandfather list only ever shrinks** — removing a
tab requires it to actually pass the F10/F11 tests; adding a tab back (or shipping a
NEW tab grandfathered) requires a written justification and operator sign-off, the
same ratchet discipline as the F3 purpose-line exempt list. A population floor in
each test fails loudly if the registry sweep goes blind.

This phased grandfathering is **not** a *No Deferrals* violation. That standard forbids
shipping a partial fix with *untracked* deferrals <!-- tracked: topic-29836 --> that silently regress; here the FLOORS
ship **complete** in Phase 1 (the component, both F10/F11 tests across all three tiers,
and a live reference implementation), every grandfathered tab's retrofit is tracked
<!-- tracked: topic-29836 -->, and the ratchet structurally guarantees the grandfather
list only shrinks — so nothing regresses and no work is lost. Retrofitting 26 tabs in one
PR is the big-bang the whole standard exists to avoid; the operator approved the four-phase
order for exactly this reason.

| View | Front-page words | Glance (F10) today | Drill-down (F11) today | Baseline |
|---|---|---|---|---|
| Insights | 86 | ✅ the model to copy | ✅ button per takeaway | conforming (reference pattern) |
| Commitments | 972 → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (full rebuild, Phase 2 — folds #1435: Overdue tile, plural grammar, overdue≠due-soon)** |
| Tokens | 28 → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 4 — Text-processed / Recent-conversations / Idle tiles; session ids + counts at Layer 3)** |
| Secrets | 36 → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 4 — Waiting / Expired tiles; the open/copy/cancel actions preserved on the Layer-3 record)** |
| Resource Usage | 40 → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 4 — CPU-now / Memory-now / Processes tiles; per-process averages + peaks at Layer 3)** |
| Mandates | 49 | ✅ plain | ✅ adequate | grandfathered — **exception** (issue/revoke/approve console w/ inline PIN inputs + issuance form) |
| Jobs | 51 | ✅ lean | ✅ select-a-job works | grandfathered — **exception** (master-detail job console: run / toggle / filter / SSE) |
| Sessions | 76 | ✅ lean | ✅ click-to-stream works | grandfathered — **exception** (the live WS chat SPA + composer) |
| LLM Activity | 88 (366 loaded) → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 4 — Components / AI-calls / Acted / Errors tiles; providers + latencies at Layer 3)** |
| Process Health | 101 (386 loaded) | ✅ plain | ⚠️ detail drawer only | grandfathered — **exception** (bespoke ETag/visibility-gated polling module) |
| Preferences | 120 | ✅ plain, first person | ✅ adequate | grandfathered — **exception** (bespoke polling module) |
| Threadline | 156 (1,993 loaded) | ⚠️ over budget | ✅ adequate | grandfathered — **exception** (bridge settings form + thread browser + search) |
| Machines | ~200 → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 3 — Online / Attention needed / Dispatcher / Safety-checks tiles; the insider guards line became named checks with plain explanations at Layer 2/3; folds issue #1429 nickname-edit + F9 hold)** |
| Health | 390 → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 3 — Subsystems / Need attention / Recent events tiles; the 390-word subsystem prose moved to the Layer-3 records)** |
| Spend | 400 → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 3 — "metered / paid door / reflows" became plain "pay-per-use" at the glance; per-model math + caps at Layer 2/3)** |
| Routing Map | (dense) → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 3 — "lane / nature / door" became plain per-lane tiles + a headline naming the primary model + backup; ordered door+model lists + full config at Layer 2/3)** |
| Blockers | 7,035 → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 2 — headline + Truly stuck / Being worked / Resolved tiles; the raw table moved to Layer 3)** |
| PR Pipeline | (list) → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 4 — Ready-to-merge / Not-ready tiles; commit sha + gate reason at Layer 3)** |
| Initiatives | (digest+list) → **glance** | ✅ **on the floor** | ✅ **on the floor** | **on the floor (rebuilt Phase 4 — In-progress / Needs-you / Ready / Check-in / Idle tiles; the digest reasons became plain words)** |

**Phase-4 sweep result.** The six **data-summary views** above (Tokens, Secrets,
Resource Usage, LLM Activity, PR Pipeline, Initiatives) left the grandfather list
(ceiling 20 → 14). The remaining fourteen tabs are **operator-ratified exceptions** —
interactive consoles / forms / browsers / bespoke-polling modules where a read-only
glance would strip the tab's actions and change what it *does* (a non-goal):

- **Consoles (inline actions):** Jobs (run/toggle/filter/SSE), Features (toggle + detail
  modal + autonomy card), Projects (halt/ack + per-round progress), Mandates
  (issue/revoke/approve + PIN inputs), Subscriptions (the F9 account×machine
  provisioning matrix with per-cell PIN + code inputs).
- **Forms / browsers / lookups:** Files (file-tree browser + editor), Send Content
  (compose-and-send form), Evidence (two lookup forms, no ambient population),
  Threadline (bridge settings form + thread browser + search), Sessions (the live
  WebSocket chat SPA + composer).
- **Bespoke polling modules:** Process Health and Preferences-Learning are their own
  ETag/visibility-gated controllers; a glance rebuild that preserves their poll
  lifecycle is a tracked follow-up <!-- tracked: topic-29836 -->.
- **Reference pattern:** Insights already satisfies the glance shape by hand (it is the
  original pattern the shared component was extracted from); rewriting the reference
  onto its own generalization is churn with regression risk and no user benefit.

A future glance rebuild that re-homes each console's actions to Layer-3 records (the
proven Machines-nickname / Secrets-cancel pattern) can retire more of these; until then
the ratchet holds them at ceiling 14 and no NEW tab may ship below the floor.

**Worked example — Commitments (the reference implementation in this PR).** Today the
glance layer is 23 raw records: *"I will send the code as soon as I get it —
suppressed: quiet-hours — id: CMT-953 — cadence: 1800s — heartbeats: 1…"*. On the
floor it becomes a headline — *"I'm carrying N open promises; K need attention soon,
none are overdue."* — over ≤5 tiles. Tapping a tile drills into the existing list,
filtered to that tile (Layer 2); tapping a row opens the full record with every
timestamp and ID (Layer 3). Its full rebuild is Phase 2; this PR ships the glance
layer + the drill into the existing list/record.

**One population, honest counts (frontloaded after spec-converge round 1).** The
glance number must be *true*, not merely well-formed — a wrong headline count is the
exact defect the floor exists to prevent. So the reference impl derives every tile
and the headline from the **same single population** the drill-down shows: the
beacon-watched open promises (`beaconEnabled && status === 'pending'`) — the identical
set `loadCommitments` already renders. The headline count therefore equals the
Layer-2 list length by construction (a test asserts this equality), so tapping
"Open N" always drills into exactly N rows. Each tile maps to an **existing server
field** on the `Commitment` record (no client-side re-derivation of state, no new
endpoint), so the glance can never diverge from the server's own notion of at-risk:

| Tile | Plain label | Server-field predicate (over the open-promises population) |
|---|---|---|
| Open | "Open" | the population itself: `beaconEnabled && status==='pending'` |
| Due soon | "Due soon" | `atRisk === true` (the server's own at-risk flag) |
| Waiting on you | "Waiting on you" | `blockedOn ∈ {'user-input','user-authorization'}` |
| Quiet (paused) | "Quiet" | `beaconSuppressed === true` |
| Overdue | (headline only) | `hardDeadlineAt` present and `< now` |

The headline reads "none are overdue" when the overdue count is 0, "K need attention
soon" from the Due-soon count. A zero-count tile is still rendered and clickable — it
opens an honest F6 empty-state, composing F11 + F6. (These predicates are the
reference impl's contract; the labels/shape were operator-approved, and pinning the
exact field mapping is an implementation decision made here, not a deviation from the
approved shape — the proposal's "664 / 3 / 2 / 12" were illustrative.)

## Multi-machine posture (Cross-Machine Coherence)

`dashboard/glance.js` is a **stateless client-side renderer** (posture: `unified` by
construction). It persists nothing, reads no config, and holds no server state; it
renders whatever data the adopting tab already fetches and inherits that endpoint's
existing posture (the Commitments reference drills into `GET /commitments`, whose
pool-scope posture is unchanged by this PR). It introduces **no new machine-divergent
state**, so it needs no `machine-local-justification` marker — there is no
machine-local surface to justify.

## Migration Parity + Agent Awareness

**Migration Parity — met by construction, no migration needed.** The dashboard is
served wholesale via `express.static(dashboardDir)` from the installed package
directory (`package.json` `files` includes `dashboard/`; `AgentServer.resolveDashboardDir`
resolves to the package root, not the agent home). A package update replaces
`dashboard/glance.js` + `dashboard/index.html` on the normal update path, exactly as
`dashboard/subscriptions.js` shipped — so already-deployed agents receive the glance
with no `PostUpdateMigrator` entry and no `init`-only templating. The Commitments tab
loads `glance.js` through the same `try/catch` dynamic-import guard the other tabs use
(`await import('/dashboard/glance.js')` — a missing/failed module degrades the tab
gracefully instead of white-screening during a rolling update). **Agent Awareness —
n/a:** this is an internal dashboard UX/dev standard (how a view *renders*), not a new
operator-invocable capability, route, config, or hook — the awareness surface is
`STANDARDS-REGISTRY.md` (bumped nine → eleven floors), not the CLAUDE.md template.

## Enforcement design

Two tiers, mirroring the money-increment "static floor + smoke test" pattern:

1. **Static floors (F1, F2-registry, F3, F5, F6, F7, F8)** — pure parse/grep tests over
   `dashboard/index.html`, no browser. Fast, deterministic, run in the normal unit shard.
   They extend the exact pattern PR #1403 proved (`dashboard-panel-placement.test.ts`): a
   negative-control proves the test actually fails when the floor is violated, and a
   population floor prevents the test going silently blind if the registry parsing breaks.

2. **Viewport smoke test (F2-reachability, F4)** — the one piece that needs a real render:
   load the dashboard at 1280 / 768 / 390 px in headless Chromium (the harness already used
   for #1403 verification), assert (a) every registered tab is clickable/reachable and (b)
   `document.body.scrollWidth <= clientWidth` at each width. Gated behind a CI job that has a
   browser; if the browser is unavailable the job reports SKIPPED-honestly rather than
   passing blind. **Open decision for the operator (FD-2): run this smoke test in CI on every
   PR (needs a browser in CI) or as a pre-merge manual gate?**

3. **Glance floors (F10, F11) — a shared component + two jsdom tests, no browser.** The
   glance floors are enforced at the **component boundary**, not by scanning bespoke
   per-tab markup (the glance content is JS-rendered from live data, so a static grep of
   `index.html` cannot see it). One shared component `dashboard/glance.js` renders the
   three-layer template (headline + ≤5 labeled tiles + a drill-down container) and exports
   the pure validator `validateGlanceSpec`. A tab adopts the floor by building its glance
   through this component; the component refuses to render an over-budget or
   jargon-carrying glance (*structure over willpower*). Two tests, both in the normal unit
   shard (jsdom, no browser, auto-discovered — no CI-config change):
   - **F10 word-budget** — `tests/unit/dashboard-glance-word-budget.test.ts`: proves
     `validateGlanceSpec` flags >5 tiles, >150 words, and every insider-vocab class *and its
     bypass variants* (spaced / glued / snake_case / NFKC look-alike / space-or-unit cadence)
     with a negative control on each side of the boundary; then renders each glance-adopted
     tab's real builder with **adversarial fixtures** (large N, null / empty / error states,
     free text carrying banned tokens) and asserts the produced glance conforms — including
     the **headline-count-equals-list-length** truthfulness assertion.
   - **F11 walk-every-tile** — `tests/unit/dashboard-glance-drilldown.test.ts`: renders the
     component, activates *every* tile, and asserts each opens a Layer-2 container that is
     non-empty-and-distinct from the glance (or an honest empty-state for a zero-count tile).
     The fixture is **non-vacuous**: it must produce ≥1 tile with a non-zero count, and the
     test asserts at least one activated drill opened a real (non-empty) Layer-2 list — so a
     walk over an all-zero fixture can't pass by doing nothing. The walk then continues one
     layer deeper: it activates a representative Layer-2 row and asserts a **Layer-3 record**
     opens (no dead-end lists — the full tile → list → record path is exercised, not just
     1→2). Negative controls prove BOTH a dead-end tile (no handler) AND a "drill re-renders
     the same summary" tile fail the walk; an F9 case proves a background re-render holds an
     open drill interaction (patching counts via `data-*` merge) instead of clobbering it; and
     an XSS negative control (`<img onerror>` / `"`-breakout / RLO bidi in commitment text)
     must render inert. Then walks the real Commitments glance end-to-end.

   The floor is proven across **all three test tiers** (Testing Integrity), all jsdom /
   in-process, no browser, auto-discovered — no CI-config change: Tier 1 (unit) is the two
   tests above; **Tier 2 (integration) — `tests/integration/glance-commitments-tab.test.ts`**
   drives the shipped Commitments glance builder + `renderGlance` against a **real
   `GET /commitments` HTTP response** (Express + `createRoutes` + a live `CommitmentTracker`),
   asserting the glance renders, conforms to F10, and every tile drills into the real filtered
   list; **Tier 3 (e2e) — `tests/e2e/glance-commitments-tab-lifecycle.test.ts`** is the
   feature-is-alive proof (boots the production route path; `/commitments` returns 200 never
   503 with the feature ON *and* OFF → the friendly empty glance, not a crash; the full glance
   renders end-to-end from live data; no injected `<script>` survives).

   All tiers read the **glance-adopted registry** (`GLANCE_ADOPTED_TABS`, initially
   `['commitments']`) and skip the grandfathered tabs from the baseline table. The ratchet is
   structural, not prose: the F10/F11 tests assert (a) **completeness** — every `TAB_REGISTRY`
   id is in exactly one of adopted ∪ grandfathered, so a NEW tab in neither set fails the
   build (reusing the F2 registry-completeness pattern); and (b) **monotonicity** — the
   grandfather set's size is asserted `≤` a committed `GLANCE_GRANDFATHERED_CEILING` constant
   that can only be *lowered*, so the list can never silently grow. The population floor is
   derived from `GLANCE_ADOPTED_TABS.length` (every adopted tab must actually be walked), not
   a magic lower bound. Layer-2 plainness (a jargon scan one click down) is a deliberate
   later-phase tightening, not guaranteed in Phase 1 <!-- tracked: topic-29836 -->.

4. **Constitution registry** — extend the "Dashboard UX Standard" entry in
   `docs/STANDARDS-REGISTRY.md` (nine → eleven floors) with F10/F11's enforcing guards
   named, so the Standards-Enforcement-Coverage audit tracks them and flags if a guard ever
   goes missing (dangling-ref detection).

## Implementation sequencing (Increment 2b, after this is approved)

### Glance floors — the four glance phases (topic 29836, approved 2026-07-10)

The glance-floor rollout ships in four phases, each usable on its own; **this PR is
Phase 1** and nothing more:

1. **Phase 1 (THIS PR) — the standard + the shared component + the reference tab.** F10/F11
   written into this standard with the two enforcement tests; the shared `dashboard/glance.js`
   component; and ONE view (Commitments) wired onto it as the living example (glance layer +
   drill into the existing list as Layer 2, full record as Layer 3).
2. **Phase 2 (SHIPPED) — the two worst offenders.** Commitments' full rebuild (folding
   issue #1435) + Blockers, rebuilt on the template; both left the grandfather list
   (ceiling 25 → 24) and the subscriptions optimistic-cancel fix (issue #1428) rode along.
3. **Phase 3 (SHIPPED) — the jargon belt.** Machines, Health, Spend, Routing Map,
   rebuilt on the template; all four left the grandfather list (ceiling 24 → 20) and
   issue #1429 (Machines nickname commit-on-input + focus-steal) rode along, fixed by
   committing the nickname only on Enter/blur with an optimistic echo and the F9
   interaction-hold across the poll.
4. **Phase 4 (SHIPPED) — the sweep.** Every remaining grandfathered **data-summary
   view** brought to conformance: PR Pipeline, Tokens, LLM Activity, Secrets, Resource
   Usage, and Initiatives, rebuilt on the template; all six left the grandfather list
   (ceiling 20 → 14). Two operator issues rode along: **#1441** (dashboard statics now
   serve `Cache-Control: no-cache` + ETag so a deploy can't pair a fresh index.html
   with a stale glance.js) and **#1442** (the selected tab now survives a page refresh
   via `?tab=<id>`, validated against `TAB_REGISTRY`). The remaining 14 tabs are
   interactive **consoles / forms / browsers / bespoke-polling modules**, not
   read-only summary views — the glance model (a read-at-a-glance headline + count
   tiles) would strip their inline actions (run a job, toggle a feature, approve a
   mandate, provision a subscription, browse/edit files) and change what the tab
   *does*, which this standard's non-goals forbid. They stay grandfathered as
   **operator-ratified exceptions** (enumerated in the Phase-4 PR body); a future
   glance rebuild that re-homes each surface's actions to Layer-3 records is a tracked
   follow-up. <!-- tracked: topic-29836 -->

### Reachability / clarity floors (F1–F8)

The standard is approved first (defines the bar); then the improvement pass applies it. To
avoid a 9,600-line-file big-bang and keep each step reviewable:

The standard is approved first (defines the bar); then the improvement pass applies it. To
avoid a 9,600-line-file big-bang and keep each step reviewable:

1. **Nav reachability (F2)** — highest user impact; make all 25 tabs reachable at every
   width (recommend: grouped nav or an overflow "More" menu — see FD-1). Land F1+F2 floors.
2. **Purpose lines + labels + empty states (F3, F5, F6)** — a pass adding the missing 7
   purpose lines, auditing controls, and fixing bare empty states. Land those floors.
3. **Mobile width (F4)** — constrain panels to the viewport; land the smoke test.
4. **Shared vocabulary (F7) + assets (F8)** — extract shared classes, fix the logo.

Each step is its own PR with browser-verified before/after screenshots at all three widths.

## Frontloaded decisions (operator input)

- **FD-1 — Nav model for 25 tabs.** Options: (a) grouped sidebar with sections
  (Sessions/Work/Money/Machines/…), (b) a horizontal scroll strip, (c) a "More ▾" overflow
  menu after the top N. Recommendation: **(a) grouped** — 25 flat tabs is too many to scan
  even if reachable; grouping also serves "EASY to navigate." Needs the operator's taste.
- **FD-2 — Viewport smoke test placement.** CI-on-every-PR (needs a browser in the CI image)
  vs a pre-merge manual gate. Recommendation: CI, if a browser is already available;
  otherwise start as a documented manual gate and add CI when the image supports it.
- **FD-3 — F7 timing.** Soft lint now / hard floor after migration (recommended) vs hard
  floor immediately (bigger up-front rewrite).
- **FD-4 — Scope of "self-contained."** Does every tab need an inline help/"?" affordance, or
  is a strong purpose line sufficient? Recommendation: purpose line is the floor; an inline
  help affordance is a nice-to-have, not a gate.

## Non-goals

- A visual redesign / re-theme (colors, brand). This standard is about reachability,
  clarity, and responsiveness — not a new look.
- Changing what any tab DOES. Behavior is untouched; only its presentation and reachability.
