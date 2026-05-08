# Side-Effects Review — Initiative Plain-English Explainer + Per-Initiative Reply Box

**Version / slug:** `initiative-plain-english-and-comments`
**Date:** `2026-05-07`
**Author:** `echo`
**Second-pass reviewer:** `not required` — additive feature (new fields are
optional, new endpoints are net-new, no existing route signature changes).

## Summary of the change

Initiatives are usually authored in developer shorthand by the building
agent ("Phase B scope call: gate handlers vs validate Phase A in
production first"). That's fine for the agent but unreadable for the
non-technical user looking at the dashboard. Two additive pieces:

1. **`InitiativeExplainer`** — a new Haiku-backed re-renderer. Reads
   each initiative + active digest signal, asks the configured
   `IntelligenceProvider` for a plain-English summary + signal text,
   caches the result on the initiative record (`userExplanation`),
   keyed by a content hash. Same shape as
   `ThreadlineNicknameSuggester`: periodic 15-minute sweep + on-demand
   trigger. No-op when no `IntelligenceProvider` is wired.
2. **Per-initiative reply box.** Inline textarea on every "Needs you"
   card. Submissions append a comment (`Initiative.comments[]`) AND,
   for `author === 'user'` posted from the dashboard, are relayed to
   Telegram so the live agent picks them up like an ordinary message.
   Routing target: the initiative's first `links[]` entry of type
   `'topic'` with a numeric `ref`, falling back to the universal
   general topic (`topicId === 1`). Relay is best-effort and never
   blocks comment storage.

Files touched:

- `src/core/InitiativeTracker.ts` — adds optional `userExplanation` and
  `comments[]` to `Initiative`; adds `setUserExplanation` and
  `addComment` methods. Both methods explicitly do **not** bump
  `lastTouchedAt` (derived view + conversation, not work progress).
- `src/core/InitiativeExplainer.ts` — NEW. Class with `explainOne`,
  `run`, static `computeHash`, static `pickSignal`. `maxPerRun`
  bounding (default 5, hard cap 50). Source-hash skip on freshness.
- `src/server/routes.ts` — adds three endpoints:
  - `POST /initiatives/:id/comment`
  - `POST /initiatives/:id/explain`
  - `POST /initiatives/explain-sweep`
  Adds `initiativeExplainer` to `RouteContext`. The comment endpoint
  also relays `user`-authored comments to Telegram via
  `ctx.telegram.sendToTopic`.
- `src/server/AgentServer.ts` — adds `initiativeExplainer` to the
  constructor options and threads it into the route context.
- `src/commands/server.ts` — instantiates `InitiativeExplainer` when
  `sharedIntelligence` is wired; sets up the periodic sweep with the
  same in-flight guard / 90s initial delay / 15-min interval as
  `ThreadlineNicknameSuggester`.
- `dashboard/index.html` — renders `userExplanation.summary` +
  `signalText` when present, falls back to a truncated
  description-sentence with a "Translating to plain English…" hint.
  Renders `comments[]` as an inline thread on each Needs-you card,
  adds the reply textarea + Send button. Throttled fire-and-forget
  kick of `/explain-sweep` when any visible initiative is missing an
  explanation.
- `tests/unit/InitiativeExplainer.test.ts` — NEW (13 tests).
- `upgrades/NEXT.md` — release note added.

Decision-point surfaces touched:

- **`POST /initiatives/:id/comment`** — net-new endpoint. Validates
  `text`, length-caps at 4000 chars, normalises `author` to `user` |
  `agent`. The Telegram relay is conditioned on `author === 'user'`
  (so agent-authored back-replies never echo out as user input).
- **`POST /initiatives/:id/explain` / `/initiatives/explain-sweep`**
  — net-new. Both 503 when the explainer is unavailable.

## Decision-point inventory

- **Telegram relay target**: priority order is (1) the initiative's
  first `links[].type === 'topic'` entry with a numeric `ref`, (2)
  topic id `1` (general). No relay is attempted if no Telegram
  adapter is wired.
- **Cache freshness**: source-hash includes `title`, `description`,
  current phase id/name/status, and the active signal `reason|detail`.
  Anything else (lastTouchedAt, blockers list, link list, comments)
  intentionally does NOT invalidate the cache, because it would force
  recomputation on routine bookkeeping.
- **`maxPerRun` bound**: default 5, hard cap 50. Prevents an agent
  with 50 active initiatives from being charged 50 Haiku calls in one
  sweep on the periodic schedule.

## 1. Over-block

- **Could the explainer block a legitimate user action?** No. The
  explainer never gates anything — it only writes the cached
  `userExplanation` on the initiative. The dashboard falls back to a
  raw-description sentence when the cache is empty, with a small
  "Translating…" hint. No path through the explainer can prevent the
  user from acting on an initiative.
- **Could the comment endpoint block a comment?** Only on validation
  failure (empty text, >4000 chars, missing initiative). The error
  body identifies the precise failure so retry is trivial.
- **Could the Telegram relay block comment storage?** No — relay is
  inside a `try/catch` that swallows all errors. The endpoint always
  returns the durable comment record on success.

Over-block risk: low. No new gates on existing flows.

## 2. Under-block

- **Could a malicious caller use the comment endpoint to flood
  Telegram?** The endpoint is auth-gated like all `/initiatives/*`
  routes. Same caller surface as `POST /initiatives` (creating an
  initiative). No rate limit specific to this endpoint, but the same
  is true of every existing `POST` on the tracker. Abuse vector is
  bounded to authenticated callers and the per-initiative comment cap
  is 100 (older comments drop off).
- **Could the relay leak comments to the wrong topic?** The fallback
  is the general topic (`topicId === 1`), which is the visible
  user-channel. Initiatives with sensitive material should set a
  topic link to route to a private topic — same pattern as existing
  initiative links. There is no path where a comment posts to a topic
  the relay didn't explicitly resolve.
- **Could the explainer leak initiative content?** It sends each
  initiative's title, description, phase list, blockers, and digest
  signal detail to the configured `IntelligenceProvider`. The
  release-note privacy section calls this out and offers the no-op
  path: leave `intelligenceProvider` unset.

Under-block risk: low. Two small follow-ups noted (rate limit, topic
opt-in) — neither blocks ship of this PR.

## 3. Level-of-abstraction fit

- `InitiativeExplainer` belongs at `src/core/` next to
  `InitiativeTracker.ts`, mirroring the
  `ThreadlineNicknames` / `ThreadlineNicknameSuggester` split. The
  tracker owns persistence + invariants; the explainer owns the
  derived view.
- `setUserExplanation` and `addComment` belong on the tracker because
  they mutate persisted state. Both intentionally avoid bumping
  `lastTouchedAt` so a sweep doesn't make every initiative look
  recently-edited.
- The Telegram relay belongs in the route handler, not in the tracker
  — the tracker is the single-writer surface for persisted state and
  shouldn't know about messaging adapters. Putting the relay in the
  handler keeps the tracker testable without messaging stubs and
  matches how other tracker-adjacent relays work.
- The dashboard's `maybeKickInitiativeExplainSweep` is purely
  client-side throttle (60s); there is no server-side dedup. This is
  acceptable for fire-and-forget — duplicate sweeps overlap with the
  in-flight guard inside `InitiativeExplainer.run`.

Level-of-abstraction fit: right layers. No new responsibilities
forced onto modules outside their existing scope.

## 4. Signal vs authority compliance

- **Signal**: the explainer emits `userExplanation` (cached prose) and
  the dashboard renders it. The summary and signalText are
  presentational — they never gate any agent action or block any
  outbound message.
- **Authority**: the only mutations the new code performs are
  - writing `userExplanation` on an initiative (cosmetic),
  - appending to `comments[]` (bounded to 100, additive),
  - sending a Telegram message (best-effort, swallowed on failure).
  None of these can transition an initiative status, phase, or
  `needsUser` flag. The MessagingToneGate continues to be the
  authority on outbound user messages — the relay routes through
  `ctx.telegram.sendToTopic`, which already gates through the
  existing send pipeline.
- The reply box is a **signal-input** surface, not authority: the
  user's text is recorded and routed to Telegram. It does not
  automatically advance phases, mark a signal as acknowledged, or
  resolve a `needs-user` flag. Those remain explicit user actions
  via the existing buttons.

Compliance: clean.

## 5. Interactions

- **`ThreadlineNicknameSuggester` co-existence**: same intelligence
  provider, same sweep cadence (15 min). Both run as independent
  in-flight-guarded sweeps; even if both happen to fire concurrently,
  they target different state and don't share locks.
- **Periodic-sweep backpressure**: the explainer's `maxPerRun=5`
  limits cost per sweep. With 50 initiatives, full coverage takes
  10 sweep cycles (~2.5 hours at 15-min cadence) — acceptable for a
  derived-view layer.
- **Source-hash invalidation chain**: a phase status change or
  description edit on an initiative will be picked up on the NEXT
  sweep, which can be up to 15 minutes later. The dashboard kicks an
  on-demand sweep when any visible initiative is missing a cached
  explanation, so the user-visible lag for never-explained
  initiatives is bounded to one HTTP round-trip + Haiku call.
- **Comment storage cap (100)** and **Telegram relay** interaction:
  if a sweep deletes comments older than 100, those comments still
  reached Telegram at the time they were posted. Telegram is the
  durable record for human conversation; the in-initiative `comments`
  array is a compact mirror.

Interaction risk: low.

## 6. Rollback cost

- **Code rollback**: revert the commit. New methods on the tracker
  read optional fields with a default — older code reading the JSON
  state file will simply ignore `userExplanation` and `comments`.
- **State rollback**: existing `.instar/initiatives.json` files
  written under the new code remain readable by the old code: both
  `userExplanation` and `comments` are optional and unknown-field
  tolerant. No migration needed in either direction.
- **Endpoint removal**: net-new endpoints. Removing them returns 404,
  which the dashboard already handles via try/catch in the kick.
- **Periodic sweep**: stops on server restart with old code.
- **Telegram relay**: reverting removes the inline relay; comments
  remain in `Initiative.comments[]`. No leftover side-effects on
  Telegram (messages sent before rollback stay sent — same as any
  other Telegram-facing change).

Rollback cost: trivial. No state migration, no schema break.

## Verification

- 13 new unit tests in `tests/unit/InitiativeExplainer.test.ts`
  cover: cache persistence, comment validation, comment cap, hash
  determinism + change-detection, force-recompute, no-op without
  intelligence, maxPerRun bounding.
- Existing 28 `InitiativeTracker.test.ts` tests still pass — no
  regression on `lastTouchedAt` semantics or persistence.
- `tsc --noEmit` clean.
- Live smoke-test against the running server populated
  `userExplanation` for all 3 active initiatives; `POST /comment`
  returned a stable comment id; relay path verified offline by code
  review (gated to `author === 'user'`).
