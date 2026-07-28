# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**The Correction & Preference Learning Sentinel now has a human read surface — a
calm "Preferences" dashboard tab — plus the scalability and closed-loop hardening
that lets it run unattended.** This is Slice 2 of the feature; it still ships dark
and is still signal-only (it never blocks, rewrites, or delays a message).

The new **Preferences tab** in the dashboard shows, in plain language, the
preferences the agent has picked up about how you like to work (the same block the
session-start hook injects on every boot) and the recent corrections it has
distilled, each with a short scrubbed summary and its status. The exact words you
used are never stored or shown — only a neutral summary. When the feature is off,
the tab shows a friendly "not turned on yet" state instead of an error.

Under the hood, the loop is now bounded so it can run on a schedule without ever
running away:

- The recurrence analyzer routes at most a handful of learnings per run; the rest
  stay open and route on the next run, so a backlog can never flood the agent in
  one pass.
- When auto-feedback is on, infra-gap proposals are sent one at a time with a delay
  between them and stop on the first rate-limit response, so a converged batch
  never trips the feedback route's limit or silently drops a learning.
- The drift canary that watches for changing phrasing gets its own small daily LLM
  budget, separate from the main one, so it can never starve the main path.
- The correction ledger gained a composite index backing its restart-proof
  distinct-calendar-days count.
- The closed-loop verify step now runs on the infra-gap path too: if the same
  friction recurs after a feedback proposal it reopens; if it goes quiet, the
  result is marked inconclusive rather than verified — because an infrastructure
  fix is the upstream project's to ship, so the agent never claims a result it
  cannot prove it caused.

The corrections list also gained pagination — a since lower-bound and a keyset
cursor — so a large ledger can be walked page by page.

## What to Tell Your User

There is a new Preferences tab in your dashboard. It is the calm, plain-language
place to see what the agent has learned about how you like to work, and the recent
moments it noticed you correcting it. The exact words you used are never kept —
only a short, scrubbed summary. It is read-only and never changes or blocks a
message; these are signals the agent applies by default, and a real instruction or
a safety rule always wins. The whole feature still ships turned off by default, so
until someone enables it the tab simply shows a friendly note that it is not turned
on yet. When the user asks what the agent has learned about them, point them to the
Preferences tab rather than reading raw output.

## Summary of New Capabilities

- New dashboard "Preferences" tab (`dashboard/preferences-learning.js` + the tab
  wiring in `dashboard/index.html`) — the human read surface for learned
  preferences + scrubbed corrections; pure renderers + a visibility-gated polling
  controller; textContent-only DOM writes so raw text can never reach the DOM;
  friendly disabled state in plain prose. Backed by the existing
  `/preferences/session-context` + `/corrections` endpoints (no new server route).
- `GET /corrections` pagination — `?since=<ISO>` lower-bound alongside the
  `?before=<ISO>` keyset cursor and `?limit`.
- `CorrectionLoopDriver` hardening — a per-tick add ceiling (`maxRoutesPerTick`,
  default 5) with overflow carried to the next run; batched, rate-limit-aware
  loopback feedback (`feedbackPostDelayMs`, default 7000; stops on 429, carries
  the rest); and an infra-gap closed-loop verify (reopen-on-recurrence with the
  14-day window; silence → inconclusive). `POST /corrections/analyze` now reports
  `routed.overflow` + `routed.rateLimited`.
- `CorrectionLedger` composite index `idx_corr_dedupe_day` backing the distinct-
  calendar-days recurrence count.
- New config `monitoring.correctionLearning.driftCanaryDailyCents` (5),
  `maxRoutesPerTick` (5), `feedbackPostDelayMs` (7000) — auto-migrated to existing
  agents via ConfigDefaults deep-merge. The drift canary gets its own dedicated
  LlmQueue sub-budget so it cannot starve the main 25-cent distill cap.

## Evidence

- `tests/unit/CorrectionLoopDriver.test.ts` (15) — per-tick ceiling caps + carries
  overflow; a second run routes the carried-over overflow; a 429 stops the batch
  and the remaining infra-gap records stay open; legacy-boolean feedback still
  honored; infra-gap recurrence → reopened (14-day window); infra-gap silence →
  inconclusive (never verified).
- `tests/unit/CorrectionLedger.test.ts` (13) — `idx_corr_dedupe_day` is created and
  `distinctCounts` still computes correct day counts with the composite index.
- `tests/unit/preferences-learning-render.test.ts` (20, jsdom) — every renderer +
  the polling controller against a real DOM; the disabled state; a record carrying
  an unexpected raw `learning` field is never rendered.
- `tests/integration/corrections-routes.test.ts` (12) — `?since` lower-bounds
  detected_at; the `?before` keyset cursor walks the full set without overlap; a
  malformed `?since`/`?before` is tolerated (never a 500).
- `tests/e2e/preferences-learning-tab-lifecycle.test.ts` (5) — the tab is alive on
  the production route path (200 enabled / 503 disabled); the SHIPPED controller
  renders the learned preference + scrubbed correction from a live server; the raw
  `learning` text never reaches the DOM; the disabled state shows no config-key
  string and no monospace element.
- `node scripts/docs-coverage.mjs --check` — exit 0 (class 55% / route 55% floors
  held).
