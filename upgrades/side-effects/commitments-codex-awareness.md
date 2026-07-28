# Side-Effects Review — Commitments & Follow-Through awareness (Codex + all frameworks)

**Change:** Surface the CommitmentTracker (`/commitments` + PromiseBeacon) as an
agent-facing capability so agents register durable commitments for promises to
the user instead of improvising a raw `sleep`/timer that does not survive
session turnover. Reaches Codex via the shadow-capability mirror.

**Files:** `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`
(+ tests, NEXT.md). **Spec basis:** Agent Awareness Standard + the
portability-shadow-capabilities mirror (same mechanism as the Secret Drop fix).

## What changed (mirror of the Secret Drop recipe)

1. **templates.ts** — new `**Commitments & Follow-Through**` agent-facing
   capability section in `generateClaudeMd()`, placed right after Secret Drop
   (before Cloudflare Tunnel). Proactive trigger: the moment you promise the
   user a future action, open a commitment via `POST /commitments`; NEVER
   improvise with a raw `sleep`/timer or "remembering" (those die with the
   session). Explicitly distinguished from the Evolution Action Queue
   (`/commit-action`), which tracks self-improvement items, not user promises.
2. **PostUpdateMigrator.migrateClaudeMd** — ensure-section block: inject the
   section when `**Commitments & Follow-Through**` is absent (before the
   Cloudflare Tunnel marker). Idempotent.
3. **PostUpdateMigrator.migrateFrameworkShadowCapabilities** — add
   `**Commitments & Follow-Through**` to the markers allowlist (after Secret
   Drop), so it propagates to AGENTS.md/GEMINI.md. Slice-bound (added in the
   Secret Drop fix) keeps it from over-grabbing Cloudflare Tunnel.

## Why this is a real gap, not a missing feature

CommitmentTracker + PromiseBeacon have always been wired (codey had 13 prior
commitments, full open→delivered lifecycle). But the capability was documented
ONLY in the dev/architecture section of CLAUDE.md — never in the agent-facing
"here's what you can do" region, on ANY framework. So no agent was told to use
it. Codex made the gap visible (no session-start hook to compensate): codey
improvised `( sleep 180; report )`, which silently dies on session turnover.

## Over-block / under-block

- migrateClaudeMd ensure-section fires only when the marker is absent →
  idempotent (re-run is a no-op; unit-tested). Won't touch agents that have it.
- Shadow slice-bound (unchanged from the Secret Drop fix) keeps each section
  precise; the new marker is between Secret Drop and Cloudflare Tunnel, both
  markers, so its slice is tightly bounded. Verified by the "propagates without
  over-grab" test (Cloudflare Tunnel count stays 1).

## Level-of-abstraction / signal-vs-authority / interactions

- Correct layers: template (new agents) + migrator (existing agents). No
  runtime/gate logic. Same proven mechanism as Secret Drop.
- Does NOT touch the CommitmentTracker server, PromiseBeacon, or `/commitments`
  routes — purely an awareness-delivery change.
- Distinct from `/commit-action` (Evolution Action Queue) — the section text
  calls this out to prevent agents conflating the two.

## Rollback cost

Low. Revert the templates.ts section, the migrateClaudeMd ensure-block, and the
markers entry. No schema/state/migration-data. Idempotent migration so a revert
simply stops adding the section to not-yet-migrated agents.

## Evidence (live, test-as-self over Telegram; codey on Codex)

- BEFORE (Test2): "report back in 3 min" → codey ran `( sleep 180; ... )`;
  GET /commitments stayed flat; CommitmentTracker unused.
- Migration applied to codey → CLAUDE.md +section, AGENTS.md mirrored, no dup.
- AFTER (fresh Test2 session, migrated AGENTS.md): codey ran
  `POST /commitments {type:"follow-up", topicId:80}` → CMT-014 created
  (status pending); ACK'd "I'll check ... in about 3 minutes and report back."
  Used the durable tracker, not a sleep.
- Tests: 65 affected green (3 new: shadow propagation no-dup, ensure-section,
  awareness-parity tracking).
