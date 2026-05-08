---
title: "Initiative Dashboard Write-Surface — Comments + Inline Reply Box + Telegram Relay"
slug: "initiative-dashboard-write-surface"
author: "echo"
review-convergence: true
convergence-iterations: 1
convergence-date: "2026-05-08"
convergence-note: "Follow-up to INITIATIVE-TRACKER-SPEC.md, which deferred 'Edit-in-dashboard' to a later phase. This spec covers the narrow write-surface that landed alongside the plain-English explainer: per-initiative comments, the inline reply box on Needs-you cards, and the Telegram relay path. Single-iteration convergence is acceptable here because (a) implementation is already running locally, (b) rollback is trivial — two optional fields plus three additive endpoints, no schema break — and (c) the surface is narrowly scoped (no phase transitions, no needsUser flips, no status mutations)."
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-07"
approval-note: "Approved via Telegram topic 5348 — Justin asked for 'an input for me to ask questions or provide feedback/input' on every Needs-you card, with the input going to the dashboard AND to his Telegram conversation with the agent. That is exactly the write-surface this spec governs. Re-confirmed 2026-05-08 with 'please proceed as you best see fit. you have my approval'."
---

# Initiative Dashboard Write-Surface

> The Initiative Tracker spec (INITIATIVE-TRACKER-SPEC.md) deliberately deferred "Edit-in-dashboard" to a follow-up. This spec is that follow-up. It approves a narrow write-surface — one input box per Needs-you card — and explicitly does **not** approve dashboard mutation of phase status, blockers, or needsUser flags. Those remain agent-only writes.

## ELI16 version

The Initiatives tab on the dashboard used to be read-only. To answer one of the agent's "Needs you" questions, you had to leave the dashboard and find the Telegram thread. That was a friction tax on the most common interaction.

This spec adds one thing: a small reply box on each "Needs you" card. Whatever you type lands as a comment on that initiative AND shows up in your Telegram conversation with the agent, so the live agent picks it up the same way it picks up any other message from you.

That is the entire write-surface. No buttons that secretly transition phases. No silent acknowledgments. The existing "Acknowledge", "Mark touched", "Start [next phase]" buttons keep doing what they do.

## Problem statement

The original tracker spec calls out the asymmetry: the agent writes, the user reads. That works for the structured fields (phases, blockers, status). It does not work for free-form input — the question "what does this initiative actually need from me?" almost always wants a sentence, not a button.

Without a write-surface, every "Needs you" prompt forces a context switch: open Telegram, find the right topic, type a reply, hope the agent connects it back to the right initiative. The agent has no per-initiative thread of comments to reference; the user has no per-initiative trail of their own input.

## Solution

Two additive pieces, both narrowly scoped:

### 1. Per-initiative comments

A new optional `comments[]` array on `Initiative`:

```ts
interface InitiativeComment {
  id: string;             // ULID
  text: string;           // <= 4000 chars after trim
  author: 'user' | 'agent';
  source: 'dashboard' | 'telegram' | 'cli';
  createdAt: string;      // ISO8601
}
```

Append-only from the agent's perspective. Bounded to 100 comments per initiative; the oldest are dropped when the cap is hit (Telegram remains the durable record for human conversation; the in-initiative array is a compact mirror).

Adding a comment intentionally does NOT bump `lastTouchedAt`. Comments are conversation, not work progress; making them advance the touched-time would corrupt staleness signals.

### 2. Inline reply box on Needs-you cards

A textarea + "Send" button at the bottom of every `signals[]`-bearing initiative card on the dashboard. Cmd/Ctrl+Enter submits.

Submissions hit `POST /initiatives/:id/comment` with `{text, author: 'user', source: 'dashboard'}`. The endpoint:

1. Validates and stores the comment.
2. If `author === 'user'` AND a Telegram adapter is wired, attempts a best-effort relay to the routed topic (see Routing below). Relay failure is silently swallowed — the durable comment is the source of truth.
3. Returns the stored comment record.

### 3. Telegram relay routing

When relaying a `user`-authored comment to Telegram, the target topic is resolved in this order:

1. The initiative's first `links[]` entry where `type === 'topic'` and `ref` is a numeric topic id.
2. Topic id `1` (the universal "general" topic) as the fallback.

This keeps relay scope tight: an initiative that already has a topic link routes its comments to that thread; one without a topic link drops to the general topic where the user expects all-purpose conversation. There is no path where a comment posts to a topic the relay didn't explicitly resolve.

## API

| Method | Path                              | Purpose                                  |
|--------|-----------------------------------|------------------------------------------|
| POST   | `/initiatives/:id/comment`        | Append a comment + relay if user-author. |

Request body: `{text: string, author?: 'user'|'agent', source?: 'dashboard'|'telegram'|'cli'}`.

Defaults: `author = 'user'`, `source = 'dashboard'`. Returns 404 on unknown initiative, 400 on empty/oversized text, 200 with the stored comment record otherwise.

## What this spec does NOT approve

The following remain out of scope for the dashboard write-surface and require their own approval before they can ship:

- **Dashboard-driven phase transitions** beyond what's already exposed via `POST /initiatives/:id/phase/:phaseId`. (The existing `▶ Start`, `✓ Mark done` buttons are on the read-spec; they don't change here.)
- **Editing the title or description** of an initiative from the dashboard.
- **Reordering, archiving, or deleting** initiatives from the dashboard.
- **Toggling `needsUser`** from anywhere other than the explicit "Acknowledge" button on a `needs-user` signal.
- **Posting comments authored as `agent`** from the dashboard. The dashboard is a user-input surface; agent-authored comments come from the agent itself.

## Risks and rollback

- **Comment-channel abuse**: the endpoint is auth-gated like every other `/initiatives/*` route. Same caller surface as `POST /initiatives` (creating an initiative). The 100-comment cap and 4000-char per-comment cap bound storage. No per-endpoint rate limit beyond the global one — same as every other tracker `POST`.
- **Wrong-topic relay**: the fallback target is the user's general topic (`topicId === 1`), not a private one. Initiatives that carry sensitive material should set a topic link that routes their comments to a private topic — same pattern as existing initiative links. There is no path where a comment posts to a topic the relay didn't explicitly resolve.
- **Storage rollback**: `comments` is an optional field. Older code reading the JSON state file ignores it. No migration in either direction.
- **Endpoint rollback**: net-new endpoint. Removing it returns 404, which the dashboard handles via try/catch in the submit path.

## Verification

- Comment validation tests: empty/oversized text rejected, append+cap behavior verified.
- Relay path verified by code review: gated to `author === 'user'`, errors swallowed, comment storage independent of relay outcome.
- Live smoke against the running server: `POST /initiatives/:id/comment` returns a stable comment id, comment renders on the Needs-you card, Telegram relay observed in topic 5348.

## Relationship to INITIATIVE-TRACKER-SPEC.md

This spec is a Phase-1.5 addendum: it lifts the narrowest possible "Edit-in-dashboard" subset out of the deferred-list and approves it. The deferred list in the original spec is otherwise unchanged; the broader edit surface (description editing, phase editing-by-form, title rename) remains deferred and out-of-scope.
