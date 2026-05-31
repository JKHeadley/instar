# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**New preferences read-surface (Correction & Preference Learning Sentinel —
Slice 1a).** This is the structural application surface for auto-learned user
preferences, modeled exactly on the existing ORG-INTENT session-start pattern.
It adds three pieces that work together:

- A new in-process primitive, `recordPreference()`, that is the ONLY writer to
  a new structured file at `.instar/preferences.json`. Writes are atomic (temp
  file + rename), schema-versioned, and upsert by `dedupeKey` — so a recurring
  preference collapses to one entry whose observation count grows rather than
  piling up duplicates. An absent file simply means "no preferences" (it is
  never required to exist).
- A new HTTP route, `GET /preferences/session-context`, gated on
  `monitoring.correctionLearning.enabled`. When the feature is off it returns
  503; when on, it serves the active preferences as a structured block, bounded
  by `maxInjectedPreferencesBytes` (4000) and priority-ordered by recency ×
  confidence × dedupe-count. It serves only the learning text plus metadata —
  never any raw internal fields.
- A session-start hook patch: the hook now fetches that route on every boot and
  injects the returned block, wrapped in an `<auto-learned-preference
  src='correction-loop'>` envelope so a learned preference can never be mistaken
  for an authoritative instruction.

This is **signal-only**. It stores, serves, and injects preferences so the agent
always SEES them — it NEVER blocks or rewrites an outbound message. The whole
feature ships OFF by default (`monitoring.correctionLearning.enabled: false`),
so on this update nothing changes behaviorally until you turn it on. Slice 1b
(the capture → distill → ledger → recurrence-gate loop that writes through
`recordPreference()`) lands in a later change and consumes this surface.

## What to Tell Your User

Nothing changes unless you turn it on. This update adds the plumbing for me to
learn your preferences over time — the repeated corrections you make, like
asking me to be plainer or to lead with the action. When that learning loop is
switched on in a later release, anything I learn about how you like to work gets
injected into my context at the start of every session, so I carry it forward
instead of forgetting it when a conversation ends. These learned preferences are
always treated as gentle signals, never as commands, and a real instruction or a
safety rule always wins. For now the feature is off by default and there is
nothing for you to do.

## Summary of New Capabilities

- New primitive: `recordPreference()` — the single, atomic, schema-versioned
  writer to `.instar/preferences.json` (upsert by `dedupeKey`).
- New route: `GET /preferences/session-context` — serves the byte-bounded,
  priority-ordered learned-preference block (503 when disabled; `{ present:
  false }` when none). Bearer-authed like sibling routes; classified in the
  CapabilityIndex so it is discoverable via `GET /capabilities`.
- Session-start hook now injects the `<auto-learned-preference>` block on every
  boot when the feature is enabled and preferences exist (fail-open: 503 /
  unreachable / empty → injects nothing).
- New config block `monitoring.correctionLearning` (ships OFF), backfilled into
  existing agents automatically via `applyDefaults` deep-merge.
- CLAUDE.md template + migrator backfill so existing agents learn about the
  surface and honor injected preferences.

## Evidence

- `tests/unit/PreferencesManager.test.ts` (13) — atomic write + schema version,
  dedupe-upsert (count increments, learning/recordedAt refresh, confidence max),
  absent-file ≡ empty, malformed-file tolerance, bounded-bytes + priority order,
  serves only learning + metadata.
- `tests/unit/preferences-wiring-integrity.test.ts` (7) — `recordPreference()`
  is the only writer (read path never creates/mutates the file; atomic
  no-partial under repeated upsert); route gate keyed strictly on
  `correctionLearning.enabled === true`.
- `tests/integration/preferences-routes.test.ts` (5) — 401 without bearer, 503
  when disabled, 200 `{ present: false }` when enabled+empty, 200 structured
  block when enabled+exists, no raw-extra leak.
- `tests/e2e/preferences-session-context-lifecycle.test.ts` (6) — feature-alive
  200/503 on the production AgentServer boot path; the generated session-start
  hook emits the `<auto-learned-preference>` block when enabled+present and
  nothing when off.
- `tests/unit/capabilities-discoverability.test.ts` (100) — `/preferences`
  classified; lint green.
- Side-effects review:
  `upgrades/side-effects/correction-preference-learning-sentinel-slice1a.md`.
