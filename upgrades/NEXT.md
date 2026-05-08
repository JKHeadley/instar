# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Threadline conversations now have human-readable agent names everywhere
on the dashboard. Before this release, every counterparty showed up as
an 8-character hex fingerprint (e.g. "8c7928aa") in both the conversation
list and individual message rows, which made the Threadline tab feel
like a debug log rather than a chat app.

Three layers, each of which can be the source of truth:

1. **User-set nicknames.** A pencil icon on every conversation header
   opens an inline modal where you can name (or rename) the agent
   yourself. Names are persisted to
   `.instar/threadline/nicknames.json`, keyed by fingerprint, and
   ALWAYS win over the other two layers.

2. **Registry / inline names.** When the agent has a declared name in
   `.instar/threadline/known-agents.json` or the message itself carries
   a `senderName`/`recipientName`, that name is used.

3. **Haiku-suggested nicknames.** A new `ThreadlineNicknameSuggester`
   reads the most recent thread for any agent that resolves only to a
   fingerprint, sends the last 10 messages to a "fast"
   IntelligenceProvider (Haiku), and asks for a 1–2 word nickname.
   Bounded to 5 agents per run, idempotent, skipped on agents that
   already have any name. Triggered both by the new ✨ button in the
   Threadline header and by a 15-minute periodic sweep.

## Endpoints

| Method | Path                                          | Purpose                          |
|--------|-----------------------------------------------|----------------------------------|
| GET    | `/threadline/nicknames`                       | List all nicknames               |
| PUT    | `/threadline/nicknames/:fingerprint`          | Set/clear (always source: user)  |
| DELETE | `/threadline/nicknames/:fingerprint`          | Clear                            |
| POST   | `/threadline/nicknames/suggest`               | Run Haiku sweep on demand        |

`POST /threadline/nicknames/suggest` accepts `?dryRun=1` for preview and
`?max=N` to cap how many agents are named. The response surfaces both
applied nicknames and skipped fingerprints with reasons, so a dashboard
or operator can see why a candidate was passed over.

## Privacy / cost note

The Haiku suggester sends excerpts of inbox/outbox messages to whichever
IntelligenceProvider you have wired (Anthropic API or Claude CLI). The
content sent is at most the last 10 messages of the most recent thread,
each truncated to 240 chars, with direction labels but no fingerprints,
trust levels, or message ids.

If you don't want this — for example, if your threadline carries
sensitive material — leave `intelligenceProvider` unset (the default).
The suggester becomes a no-op: the existing UI continues to work, the
✨ button returns a 503 ("no intelligence provider configured"), and
nicknames remain user-only.

## Initiatives tab — two-zone rebuild

The Initiatives tab is no longer a flat list of equally-weighted cards.
It now opens with a clear answer to "what should I do right now?":

- **Top zone — "Needs you".** Each digest signal renders as a callout
  card with the question/detail front and center, plus action buttons
  wired to real endpoints:
  - `ready-to-advance` → **Start [next phase]** (POST phase to
    `in-progress`)
  - `needs-user`        → **Acknowledge** (PATCH `needsUser=false`)
  - `next-check-due` / `stale` → **Mark touched**
  - PR / topic / spec links from the initiative are rendered inline
    so you can jump straight to the relevant external surface.
- **Bottom zone — "In flight".** Calm cards: title, relative
  last-touched time, one-line summary (first sentence of the
  description, truncated), and a thin progress bar showing
  `done/total phases · current phase`. Blockers show as a small red dot
  with count.
- **Click to expand.** Phase pills, full description, links, and
  inline phase actions (`▶ Start`, `✓ Mark done`, `⏸ Block`,
  `▶ Resume`) appear on expand — they don't clutter the calm view.
- **Filter chips** replace the dropdown. Active / All / Completed /
  Archived / Abandoned switchable in one click.
- **Smart sort.** When viewing Active, items with `needs-user` signals
  float to the top; everything else is by recency.

No new endpoints; the rebuild uses existing
`PATCH /initiatives/:id` and `POST /initiatives/:id/phase/:phaseId`.

## Initiatives — plain-English rewriter + inline reply box

Initiatives are usually authored in developer shorthand by the building
agent. Phrases like "Phase B scope call: gate handlers vs validate
Phase A in production first" are fine for the agent but unreadable for
a non-technical reader glancing at the dashboard. Two new pieces close
that gap:

- **`InitiativeExplainer`** — a Haiku-backed re-renderer that produces a
  plain-English `summary` (what the initiative IS) and `signalText`
  (what's pending and why your input matters) for each initiative + its
  active digest signal. Output is cached on the initiative as
  `userExplanation`, keyed by a content hash of the inputs (title,
  description, current phase, signal). When any input changes, the next
  sweep recomputes; otherwise calls are skipped.
- **Per-initiative reply box.** Every "Needs you" card now ends with a
  textarea + Send button. Submissions append to `Initiative.comments`
  AND, for `author === 'user'` from the dashboard, are relayed to
  Telegram so the live agent sees the input as a normal message.
  Telegram routing best-effort: any failure is silently swallowed, the
  comment remains durably stored on the initiative.

### New endpoints

| Method | Path                                  | Purpose                                       |
|--------|---------------------------------------|-----------------------------------------------|
| POST   | `/initiatives/:id/comment`            | Append a comment + relay to Telegram if user  |
| POST   | `/initiatives/:id/explain`            | Refresh the plain-English explanation         |
| POST   | `/initiatives/explain-sweep`          | Sweep all initiatives (max=5 default)         |

`?force=1` on `/explain` and `/explain-sweep` bypasses the source-hash
freshness check and always recomputes.

### Background sweep

Same shape as the threadline nickname suggester: 90s initial delay,
15-minute periodic sweep, capped at 5 initiatives per run, in-flight
guard so overlapping intervals can't double-bill the LLM. No-op when no
intelligence provider is wired.

### Privacy / cost note

The explainer sends each initiative's title, description, phase list,
blockers, and digest signal detail to whichever IntelligenceProvider you
have wired. If your initiatives carry sensitive material, leave
`intelligenceProvider` unset — the explainer becomes a no-op
(`/explain*` endpoints return 503), and the dashboard falls back to the
first sentence of the raw description with a "Translating to plain
English…" hint.

### Telegram relay routing

The per-initiative comment relay picks its target topic in this order:

1. The initiative's first `links[]` entry where `type === 'topic'` and
   `ref` is a numeric topic id.
2. Topic id `1` (the general topic) as the universal fallback.

This keeps relay scope tight while letting initiatives that already
carry a topic link route their comments to the right thread.

## Migration

No migration. The nicknames file is created on first write. Existing
threadline state, registry, and bindings are unchanged. The Initiatives
rebuild is purely client-side and uses existing tracker routes.

The new `Initiative.userExplanation` and `Initiative.comments` fields
are optional — existing initiatives load and serialize fine without
them. The first sweep after upgrade populates explanations
automatically when an intelligence provider is wired.

## What to Tell Your User

The Initiatives tab on your dashboard is now readable.

Before this release, every "Needs you" card showed the agent's
internal shorthand — phrases like "Phase B scope call: gate handlers
vs validate Phase A in production first" — which is fine if you wrote
the code yourself but unhelpful if you didn't. The dashboard now
re-renders each initiative + its current question into plain English,
so you can tell what an initiative is about and what the agent needs
from you in one glance.

Every "Needs you" card also has a reply box at the bottom now.
Whatever you type lands as a comment on that initiative AND shows up
in your Telegram conversation with the agent, so you can ask a
question or leave input without leaving the page.

If you don't want the agent to send your initiatives to an
intelligence model for re-rendering, leave `intelligenceProvider`
unset in your config. The dashboard falls back to the first sentence
of the raw description with a small "Translating to plain English…"
hint, and the explainer endpoints return 503.

## Summary of New Capabilities

| Capability                          | Endpoint / surface                       |
|-------------------------------------|------------------------------------------|
| Plain-English initiative summary    | `Initiative.userExplanation` (cached)    |
| Refresh one initiative's summary    | `POST /initiatives/:id/explain`          |
| Sweep all initiatives' summaries    | `POST /initiatives/explain-sweep`        |
| Comment on a specific initiative    | `POST /initiatives/:id/comment`          |
| Inline reply box on Needs-you cards | Dashboard "Initiatives" tab              |
| Telegram relay of dashboard replies | Auto, on `author === 'user'` comments    |
| Background rewrite sweep            | 15-min interval, capped at 5 per run     |
