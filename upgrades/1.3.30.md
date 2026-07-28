# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Adds the **Process Health dashboard tab** — a calm, human-readable window into the Failure-Learning Loop (spec `docs/specs/PROCESS-HEALTH-DASHBOARD-TAB-SPEC.md`, converged v4, approved). Until now the loop's findings were API-only (reachable via `/failures*` curl); this tab surfaces them in the dashboard you actually look at.

The tab opens with one plain-English headline ("Watching — N issues recorded"), then surfaced patterns as readable cards (awareness-only — never auto-acted-on), recent captures as plain sentences, and a maturation track with a "← you're here" marker. The dense aggregate counts live in a collapsed "Detail" drawer at the bottom. When the Failure-Learning Loop is off, the tab shows a friendly "not turned on yet" message rather than an error.

UX is the centerpiece, not an afterthought: measurable type bars (headline ≥24px, section headers ≥20px, body ≥17px, line-height 1.5–1.6, zero monospace) are enforced by tests, and a glance check asserts the visible text never reads like a debug log. Every dynamic value (commit messages, agent diagnoses, the classifier's output) flows through a single sanitize-and-cap helper before the DOM — textContent-only writes, NFKC fold, control/bidi/chrome-glyph strip, grapheme-safe length caps, and a same-origin `safeUrl` — so untrusted upstream text can't inject markup, fake-authority glyphs, or invisible/right-to-left trickery. The redaction contract (`detail.full` never crosses the wire) is verified end-to-end against a live HTTP server.

Server-side this adds ETag/304 diff-aware polling on `/failures*`, a `before=` keyset-pagination parameter (rejects a non-ISO value with 400), and a `rollout` block on `/failures/analysis` (the maturation stage the tab draws). No behavioral change when the loop is disabled — every route still 503s and the tab renders its disabled copy.

## What to Tell Your User

- There's a new **Process Health** tab in your dashboard. It's a calm, plain-English view of what the failure-watching system is noticing — big readable type, short sentences, no wall of logs.
- Think of it like a dashboard light in a car, not the mechanic's diagnostic printout: one line tells you whether anything needs a look; the raw numbers are tucked away in a drawer you only open if you want them.
- If the failure-watching system isn't switched on for an agent, the tab just says so politely instead of looking broken.
- Nothing to run and nothing to babysit — it refreshes itself quietly while the tab is open and pauses when it isn't.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Process Health dashboard tab | Open the "Process Health" tab in the dashboard (give the user the dashboard URL + PIN) |
| Diff-aware polling (ETag/304) | Automatic — `GET /failures*` now return an `ETag`; a matching `If-None-Match` gets a 304 |
| Keyset pagination | `GET /failures?before=<ISO-ts>&limit=N` and `GET /failures/insights?before=<ISO-ts>&limit=N` |
| Rollout-stage readout | `GET /failures/analysis` now includes `rollout: { stage, enabled, insightTelegramEscalation }` |

## Evidence

- **3-tier + jsdom tests, all green:** unit (sanitize/safeUrl/wording + renderers against a real jsdom DOM + ledger pagination), integration (the polling controller — XSS negative, layout-bomb, out-of-order race, visibility-gating, staleness hard-fail AND the 304-pinned-headline case, 304 backoff/recovery, diff-aware zero-mutation; plus the route ETag/304/`before=`/rollout behaviors), and an E2E lifecycle test that boots a real HTTP server and drives the shipped controller through a jsdom-mounted tab with the feature ON and OFF.
- **Safety verified, not asserted:** the XSS negative fixture feeds `<img onerror>`/`<script>`/`<svg onload>` through the full controller path and asserts zero live elements + no canary fired; the E2E seeds a failure whose `detail.full` is a secret path and confirms it never appears in the rendered DOM.
- **Migration parity:** the CLAUDE.md "Process Health (Dashboard Tab)" section ships to existing agents via `PostUpdateMigrator.migrateClaudeMd`, and a shadow-capability marker carries it to Codex/Gemini agents — both enforced by the Feature Delivery Completeness test.
