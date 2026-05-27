---
title: Process Health Dashboard Tab
slug: process-health-dashboard-tab
author: echo
created: 2026-05-27
owner: echo
status: draft
eli16-overview: PROCESS-HEALTH-DASHBOARD-TAB-SPEC.eli16.md
topic: 13201
---

# Process Health Dashboard Tab — visible, calm read surface for the Failure-Learning Loop

**Status:** DRAFT (pre-convergence). Author: echo · Created: 2026-05-27 · Topic: 13201
**Companion:** `PROCESS-HEALTH-DASHBOARD-TAB-SPEC.eli16.md`

> Follow-up to the just-shipped **Failure-Learning Loop** (`docs/specs/FAILURE-LEARNING-LOOP-SPEC.md`, merged in v1.3.27, currently live in capture-only on Echo). The loop's `/failures*` data is fully reachable via the API but **invisible in the dashboard**. This adds the **Process Health** tab so the data is observable at a glance — and it does so under one **load-bearing, non-negotiable** UX constraint: **simple, large fonts, easy to digest, NOT looking like debug logs** (Justin, topic 13201, 2026-05-27 — captured in `[[feedback_dashboard_human_friendly_not_debug]]`).

---

## 1. Problem — live but invisible

The Failure-Learning Loop shipped + activated on Echo (2026-05-27). It captures attributed failures, classifies them, and (once enough diverse evidence accumulates) the analyzer surfaces process-gap insights with their verify-it-worked status. All of that is reachable via `GET /failures`, `/failures/analysis`, `/failures/insights` — **but the human has nothing to look at.** Without a visible surface:

- The data accumulates silently; the human can't notice whether the loop is doing what we hoped.
- Promotion decisions (capture-only → insight-push → default-on, driven by the twice-weekly board check) need *visibility* to be informed, not blind.
- The whole "we built a system to notice patterns" pitch is invisible without a place to see those patterns.

## 2. The non-negotiable UX constraint (this drives every design decision)

Justin's explicit, repeated direction: **simple, large fonts, easy to digest, NOT looking like some debug logs.** Three rules ([[feedback_dashboard_human_friendly_not_debug]]):

1. **Large, readable type** — sized for a glance from across the room and from a phone. No 12-px developer-console text.
2. **Plain-English summaries front and center** — what's happening, what to look at, what to decide. Counts/tables/raw records go *deeper* in the view, not at the top.
3. **No debug-log aesthetic** — no monospace walls, no terminal-style output, no JSON dumps as the primary surface. Calm, readable, designed for the human glance.

**Acceptance test (the "glance test")**: a non-engineer opens the page and within 5 seconds can answer "what's happening? what should I look at?" — *not* "what am I looking at?". If the page reads as a debug log, the spec has failed regardless of what counts are correct.

## 3. What already exists (extend, not reinvent)

- **Dashboard frontend** (`dashboard/index.html`, single SPA file) with an established **tab framework**: `.tab-bar .tab` (with `.active` class), `.tab-content` (with `.hidden` class). Existing tabs: Sessions, Secrets, Threadline, Files. We add one more.
- **Data sources** (live, verified on Echo): `GET /failures` (list, filterable), `GET /failures/:id` (one record), `GET /failures/analysis` (aggregates), `GET /failures/insights` (the loop's insights board), `POST /failures` (one-tap diagnosis — not surfaced in this tab).
- **PIN-gated access** (the dashboard's existing auth) — no new auth surface.

## 4. Design

### 4.1 Layout — top-to-bottom, large-to-small (the calm-read principle)

```
┌─────────────────────────────────────────────────────────────┐
│  Process Health                                              │  ← tab title, big
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│   ★  Healthy — no patterns flagged this week                │  ← BIG status line (24px+)
│      4 failures recorded · all attributed                    │  ← one-line plain-English
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│   Patterns to know about                                     │  ← section header (20px)
│                                                              │
│     (nothing yet — the analyzer needs more diverse           │  ← plain-English empty state
│      evidence before it surfaces a pattern)                  │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│   What's been captured                                       │
│                                                              │
│     • concurrency bug in src/core/Foo.ts                    │  ← human-readable rows,
│       attributed to "ledger spine"  ·  2 days ago             │     NOT a dense table
│                                                              │
│     • config-parse failure in failure-analyzer.md           │
│       attributed to "analyzer job"  ·  5 days ago             │
│                                                              │
│   [Show all 4 records]                                       │  ← collapse-into for the dense view
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│   Maturation                                                 │
│                                                              │
│     ● Dark           ✓ done                                  │
│     ● Capture-only   ← you're here                           │  ← rollout status, visual
│     ○ Insight push   pending watch period                   │
│     ○ Default for all agents                                 │
│                                                              │
│  [Detail ▾]                                                  │  ← collapsible "show the raw"
└─────────────────────────────────────────────────────────────┘
```

**Visual rules (CSS-binding to UX):**
- Body type: **17–18 px minimum**; section headers **20–22 px**; the headline status line **24+ px**.
- Line-height generous (1.5–1.6).
- Sans-serif (the existing dashboard font), **not** monospace anywhere outside literal code/path strings.
- Spacious padding between sections (NOT compact tables jammed together).
- Color: calm. **Status colors only on the headline badge** (green=healthy, amber=attention, never alarming red for capture-only observations). Body text uses neutral tones.
- No background colors on rows. No alternating-row "table" feel. Rows are typographic, not gridded.

### 4.2 Sections (top to bottom — most-important first)

**(a) Headline status (the glance answer).** One line: `★ Healthy — no patterns flagged this week` OR `▲ Attention — 1 pattern crossed threshold; awaiting your decision`. Secondary one-liner: "N failures recorded · all attributed" (or "N recorded · M unattributed — that's normal early on").

**(b) Patterns to know about (the insights board).** Each thresholded insight shown as a **plain-English card**: the pattern summary, the recommendation, the current loop-status (discovered / acted-on via X / verified-effective / verified-ineffective / inconclusive), and the supporting-evidence count *as a sentence*, not a table. Empty state explained warmly ("nothing yet — the analyzer needs more diverse evidence before it surfaces a pattern").

**(c) What's been captured (recent failures, redacted).** Up to ~10 most-recent records as **human-readable lines**, NOT a dense table — `<short summary>` + `<attributed-to>` + `<when>`. A `[Show all N records]` link reveals the full filterable list (still typographic, still NOT a debug dump). `detail.full` NEVER served (already enforced server-side — §4.8 of the loop spec).

**(d) Maturation track (where the rollout is).** The four stages (Dark / Capture-only / Insight push / Default-on) as **a vertical visual list** with checkmarks and an explicit "← you're here" marker. Each stage has a one-line plain description of what it means. Promotion decisions surface here when ready (plain "ready to promote → review evidence", linking to the Patterns section).

**(e) `[Detail ▾]` — the only place for dense info.** Collapsible. When opened, shows the raw analysis breakdown (rate by build skill, category distribution, the `unknown`-toolchain bucket size, the `no-feature-link` bucket). Even here, typographic, with plain captions — but it's allowed to be more data-dense. **Closed by default.**

### 4.3 Data wiring (lightweight)

The tab fetches three endpoints on mount + on a soft refresh (every ~60s while visible):
- `GET /failures/analysis` → headline status + maturation track inputs + Detail counts.
- `GET /failures/insights` → Patterns to know about (cards).
- `GET /failures?limit=10` → What's been captured (recent rows; uses the `toApiView` redacted shape — `detail.full` is already structurally absent).

503 fallback (feature disabled): a calm "the failure-learning loop is not enabled on this agent — turn it on with `monitoring.failureLearning.enabled`" message. Not an error block; not an exception trace.

### 4.4 Integration into `dashboard/index.html`

- **Tab button** added to `.tab-bar` — label: "Process Health". Position: after "Threadline" or "Files" (consistent with existing ordering).
- **`.tab-content`** section with `id="process-health-tab"`, hidden by default until the tab is selected.
- **CSS** appended to the existing `<style>` block under a `/* process-health tab */` comment. New CSS uses semantic class names (`.ph-headline`, `.ph-section-title`, `.ph-pattern-card`, `.ph-record-row`, `.ph-maturation`, `.ph-detail-collapse`) so the styling can evolve without affecting other tabs.
- **JS** (`<script>` block) — a small module-style block that wires the fetches + render + soft refresh. No framework dependency added (the dashboard is plain HTML/CSS/JS).
- **No new server route, no new ctx field** — this is pure frontend on top of the existing `/failures*` routes.

## 5. Open questions (for convergence + user)

1. **Refresh cadence** — 60s soft refresh while visible (lean; not 5s — that's debug-pulse feel).
2. **Empty-state copy** — exact wording for early-state ("nothing yet, that's normal") matters a lot for the calm-read feel. Convergence to pin.
3. **Maturation promotion UI** — does the tab include the actual *promote* action (button to flip `insightTelegramEscalation: true`), or just *surface* the recommendation? Lean: surface only (the rollout board's twice-weekly driver is the canonical promoter; the dashboard is read-mostly here).

## 6. Testing (3-tier, NON-NEGOTIABLE)

- **Unit:** the renderer functions (pure: data → DOM strings) for each section — empty state, populated state, 503-disabled state. Both sides of every boundary.
- **Integration:** a Playwright/JSDOM rendering of the tab against fixture `/failures*` responses — confirms headline + cards + rows + maturation render without monospace blocks, font-size meets the ≥17px floor for body and ≥24px for headline.
- **E2E:** in a real browser against a real (in-memory) `createRoutes` server with the feature enabled — tab loads, renders, soft-refreshes, never shows `detail.full` substring in any rendered DOM.
- **The "glance test" (mandatory acceptance):** a non-engineer reviewer (or a Tier-1 LLM acting as one with explicit "what does this say at a glance?" prompt) confirms the page communicates the state in ≤5 seconds of glance. Failing this gate means the page reads as a debug log → spec failed regardless of test counts.

## 7. Migration parity

- `dashboard/index.html` ships with the server bundle (the dashboard route serves it via `express.static`). Update lands automatically on the next AutoUpdater apply — no agent-side migration step.
- No config change required (the tab simply gates on what `/failures*` returns; 503 → calm disabled message).
- CLAUDE.md template: add the Process Health tab to the Dashboard Features description (`generateClaudeMd`) so agents mention it when sharing dashboard access (Agent Awareness Standard).

## 8. Success criteria

A user opens the dashboard, taps the Process Health tab, and within 5 seconds knows: is anything flagged for my attention? what's been captured? where are we in the rollout? — **without** feeling like they're reading a developer console. The visible surface makes promotion decisions informed instead of blind, and the feature is no longer "live but invisible." The dashboard reads as a calm, human surface for the loop's data — not a debug log.
