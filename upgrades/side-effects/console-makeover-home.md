# Side-Effects Review — a new console beside the dashboard

**Version / slug:** `console-makeover-home`
**Date:** `2026-10-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** GPT-6 Astra (codex CLI) and Gemini 4 Argon (gemini CLI), four rounds: two on the plan and code, two on live screenshots (`docs/specs/reports/console-makeover-review-r*`).
**Tier:** `1` — new static files under `dashboard/console/`, one link in the legacy header, one CLAUDE.md bullet. No server routes, no state, no config; a revert removes it completely.

## Summary of the change

A read-only console at `/dashboard/console/` (static files served by the existing dashboard static route, with the same security headers and revalidation). Home is one headline sentence and six cards built from existing routes: held replies (`/health`), what needs the operator (`/attention?scope=pool`), open promises (`/commitments?scope=mesh`), live sessions (`/sessions?scope=pool`), machine states (`/pool`) and safety checks (`/guards`, `/mandate`). Navigation groups the 29 legacy tabs by question (Work, Capacity, People, Settings); each tile opens the unchanged legacy tab as an ordinary link. The legacy dashboard is the default and gains one "Try the new console" link. Spec: `docs/specs/console-makeover.md`.

## Decision-point inventory

None with authority. The console only decides how to display what existing routes return (`dashboard/console/home-model.js`: deterministic, pure, unit-tested on both sides of every boundary). It gates, blocks and changes nothing.

## 1. Over-block

Nothing is blocked. The legacy dashboard is unchanged except for one link; every write action, PIN gate and deep link behaves exactly as before.

## 2. Under-block

No gate exists to under-block. The security-relevant choices were made conservative on review: no embedding (dashboard framing stays `X-Frame-Options: DENY`), no operator proof stored anywhere, no write actions, the token check is a protected route (`/sessions`), never the public `/health`.

## 3. Level-of-abstraction fit

Presentation only, inside the dashboard's static directory, reusing the existing static route, security headers, stored token and `POST /dashboard/unlock`. No server code changes; nothing below or above it needed to move.

## 4. Signal vs authority compliance

Signal only: it reports state and never acts. It carries no blocking authority and makes no judgment calls beyond display mapping.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point. All mappings are deterministic rules written in the spec (machine-state precedence, needs-the-operator categories, coverage labels) and pinned by tests. No LLM is called.

## 5. Interactions

- Home issues about seven authenticated GETs every 30 s while the page is visible (two are pool fan-outs the legacy dashboard already makes and that use the shared pool cache when it is on). Refresh stops when the tab is hidden or a group page is open.
- Shares `localStorage.instar_token` with the legacy dashboard (same origin, same behaviour as legacy). Unlocking in one unlocks the other for viewing; PIN-gated actions in legacy still ask for the PIN, because its in-memory operator proof is not shared.
- `PostUpdateMigrator.migrateClaudeMd` adds one content-sniffed bullet (idempotent, tested).

## 6. External surfaces

- New URL `/dashboard/console/` (and its assets) on the agent server and therefore on the tunnel, behind the same auth as the dashboard. Fonts (Inter, JetBrains Mono, SIL OFL) are self-hosted; no third-party requests.
- No new API routes, no outbound messages, no Telegram output.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The operator comes to learn whether anything needs them: the first thing on screen is that sentence ("79 things need you." / "All quiet."), then the "What needs you" card with the newest urgent items. Every card's detail is one tap away ("See all", or a row that expands to its full text).
2. **Zero raw internals as primary content?** Yes. Headlines, values and row titles are plain language ("No replies held", "3 of 4 live", "struggling", "waiting on your authorization"). Identifiers appear only as muted secondary lines (a safety check's config key beneath its plain name, in the mono face). No JSON, hashes or UUIDs are shown.
3. **Destructive actions de-emphasized?** There are no destructive actions: the console is read-only. Every write action stays in the legacy tab.
4. **Plain language + phone width?** Yes, verified at 390 px against live data: no sideways scroll (`scrollWidth` 390 checked after a fix for a decorative glow that overflowed), 44 px card actions, 13 px minimum for row metadata, a five-item bottom bar, rows wrapping to two lines and expanding to full text. Reviewed at phone and desktop width by both models in two screenshot rounds.

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read.** The console holds no state. Its pool-wide cards read the existing merged views (`/attention?scope=pool`, `/sessions?scope=pool`, `/commitments?scope=mesh`, `/pool`), and it names any machine that did not answer instead of dropping it. It emits no notices. The URL is served by whichever machine fronts the tunnel, with the same machine-local auth as the dashboard; `/health` and `/guards` are this machine's view, and the cards say "on this machine" where that matters.

## 8. Rollback cost

Pure static change: revert the PR and ship a patch. No persistent state, no migration, no user-visible regression in the legacy dashboard. Existing agents keep a CLAUDE.md bullet naming a URL that would 404 until a later template change removes it, which is harmless.

## Conclusion

The review rounds changed the design substantially: the original plan embedded legacy tabs in an iframe and relaxed framing headers; both reviewers showed that broke the operator-proof boundary and opened a same-origin framing exposure, so tabs now open as ordinary links and the headers are unchanged. Later rounds tightened the honesty rules (a zero only counts when observed, coverage stated beside a count, "All quiet." only when everything is observed) and the visual detail. Clear to ship beside the legacy dashboard; the switch to make it the default waits for the operator's MVP call.

## Second-pass review (if required)

**Reviewer:** GPT-6 Astra and Gemini 4 Argon
**Independent read of the artifact: concur** — round 2: Argon "ready", Astra "ready with changes"; rounds 3–4 on screenshots; every finding and its handling is tabled in the spec's "Review changes" section.

## Evidence pointers

Unit: `tests/unit/console-home-model.test.ts`, `tests/unit/console-nav-model.test.ts`, `tests/unit/console-claude-md-awareness.test.ts`. Integration: `tests/integration/console-static-serving.test.ts`. E2E: `tests/e2e/console-home-lifecycle.test.ts`. Live screenshots at 390 and 1440 px against the Mac Studio (kept out of the public repo because they show live operator data).
