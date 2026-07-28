---
name: threadline-open-this-deterministic
review-convergence: 2026-05-26T20:10:00Z
approved: true
eli16-overview: THREADLINE-OPEN-THIS-DETERMINISTIC-ELI16.md
---

# THREADLINE-OPEN-THIS-DETERMINISTIC-SPEC

**Status:** DRAFT — pre-convergence
**Author:** Echo · **Date:** 2026-05-26 · **Base:** JKHeadley/main @ v1.3.0
**Tracks:** CMT-529 · topic 12304 · Layer-2 continuation of PR #392 (CMT-519)

---

## 1. Problem

PR #392 wired `POST /threadline/hub/bind` for "open this", and taught agents (via CLAUDE.md) to call it when the operator says "open this" in the Threadline hub topic. But that's **agent-interpreted** — and it failed in practice: the operator said "open this" and the agent RAMBLED a conversational reply inline in the hub instead of calling the endpoint (topic 12304, 2026-05-26). Per Structure > Willpower (instar's foundational principle), a behavior that matters must be enforced structurally, not left to an agent remembering a prompt instruction.

Three concrete defects:
- **D1 — "open this" is not deterministic.** It depends on the agent parsing intent + choosing to call the endpoint. The agent can (and did) just reply instead.
- **D2 — cryptic topic name.** `hub/bind action:open` names the new topic `<peer> · <threadId8>` (e.g. "instar-codey · 88fb4dd2") — opaque. It should reflect what the conversation is about.
- **D3 — legacy-migration ordering bug.** `CollaborationSurfacer.load()` stamps EVERY migrated legacy `surfacedThreads: string[]` entry with `new Date(0)` (epoch), so `mostRecentUnbound()` can't order them — a bare "open this" against legacy entries picks arbitrarily (and returns ambiguous-409 with >1, never resolving to the genuinely-most-recent).

## 2. Goals / Non-goals

**Goals:** (1) "open this" / "tie this to &lt;topic&gt;" in the hub topic deterministically create/bind a topic — intercepted structurally BEFORE the agent interprets the message. (2) created topics get a human-readable name from the conversation. (3) legacy-migrated hub entries preserve real ordering so "most recent" works.

**Non-goals:** changing the `POST /threadline/hub/bind` API (keep it — the intercept reuses its logic); the parent-or-hub routing itself (shipped in #392); SessionReaper / other topics.

## 3. Design

### Fix 1 — deterministic hub-command intercept (D1)

> **CONVERGED v2:** the intercept goes in **`telegram.onTopicMessage` (`src/commands/server.ts` ~1158)** — the SINGLE convergence point BOTH inbound paths reach (lifeline-forward AND server-polling `TelegramAdapter.processUpdate`), where deterministic slash-command/`/new`/fix-command interception ALREADY lives (~1174-1206). Placing it ONLY in `/internal/telegram-forward` (the original draft) would be DEAD CODE for server-polling agents — the recurring dual-path trap (sentinel + warrants-reply both had to be duplicated). One intercept at `onTopicMessage` covers both modes. §8 has the evidence.

Add the hub-command intercept in `telegram.onTopicMessage` alongside the existing command interception — same proven short-circuit pattern (match → act → return before session injection; FAIL-OPEN on any error so a hiccup never blocks delivery).

Logic:
```
if collaborationSurfacer exists AND Number(topicId) === collaborationSurfacer.getHubTopicId():
    cmd = parseHubCommand(text)   // deterministic
    if cmd:
        result = await bindHubConversation(ctx, cmd)   // extracted shared helper (Fix 1b)
        telegram.sendToTopic(topicId, <plain confirmation or the 409/404 ask>)
        res.json({ ok:true, hubCommand: cmd.action, ... }); return   // skip agent injection
```

`parseHubCommand(text)` (deterministic, in a small testable module):
- `/^\s*open(?:\s+this)?\s*[.!]?\s*$/i` → `{ action:'open' }`
- `/^\s*(?:tie|bind)\s+this\s+to\s+(.+?)\s*$/i` → `{ action:'tie', targetTopicName: <captured> }` (also accept a trailing `#<id>` / numeric → targetTopicId)
- else → null (NOT a command → fall through to normal agent injection; the operator can still chat in the hub).

**Fix 1b — extract the bind logic.** The body of `POST /threadline/hub/bind` becomes a shared `async bindHubConversation(ctx, { action, threadId?, targetTopicId?, targetTopicName? })` that BOTH the route and the intercept call. Same authoritative bind (boundTopicId + commitment topicId), same 404/409 semantics — when the intercept hits 409 (ambiguous) it posts a plain hub message asking which conversation (lists the unbound ones), rather than erroring.

### Fix 2 — readable topic name (D2)

In `bindHubConversation` `open`, derive the name from the conversation: prefer a short slug of the conversation gist / first inbound (e.g. first ~5 words of `lastInboundHash` or the surfaced subject), fall back to `<peer> · <threadId8>` only when no gist exists. Still made unique (append ` · <threadId8>` when a same-named topic already exists, via `findOrCreateForumTopic` semantics) so two conversations never cross-bind onto one topic.

### Fix 3 — preserve legacy ordering (D3)

In `CollaborationSurfacer.load()`, when migrating legacy `surfacedThreads: string[]`, assign `surfacedAt` by ARRAY INDEX (the array is append-ordered, so later index = more recent) instead of a constant epoch — e.g. `new Date(index + 1).toISOString()`. Then `mostRecentUnbound()` orders legacy entries by their original surfacing order (last appended = most recent). Idempotent; new-shape files unaffected.

## 4. Test strategy (3-tier + test-as-self)

**Unit:** `parseHubCommand` — "open this"/"open"/"Open This." → open; "tie this to my GrowthBook topic" → tie+name; "tie this to #1234" → tie+id; ordinary prose ("open the door for me") → null (both sides of the boundary). `CollaborationSurfacer.load()` legacy migration assigns increasing surfacedAt by index; `mostRecentUnbound()` returns the LAST-appended legacy entry. `bindHubConversation` open/tie/404/409 (refactor-parity with the existing route tests).
**Integration:** `/internal/telegram-forward` with topicId=hub + "open this" → binds (boundTopicId set) + posts confirmation + does NOT inject to a session; with topicId=hub + ordinary prose → falls through (no bind); with topicId≠hub + "open this" → falls through (only the hub topic intercepts). `POST /threadline/hub/bind` still works (shared helper parity).
**E2E (wiring):** intercept wired in the forward path with `collaborationSurfacer` non-null; readable-name path constructed.
**Test-as-self:** deploy to live Codey; surface a parentless conversation into its hub; send the literal text "open this" into the hub topic; assert a new readable-named topic is created + bound + NO agent ramble; send "tie this to &lt;existing&gt;"; assert bind. Restore Codey, then merge.

## 5. Migration parity

Pure `src/`. The CLAUDE.md hub-guidance from #392 still applies (agents may also call the endpoint), but the intercept makes it deterministic regardless — update the template/`migrateClaudeMd` note to say "open this" is handled structurally (no agent action needed). `CollaborationSurfacer` state migration is read-time + idempotent (already shipped; this only changes the timestamp assignment).

## 6. Side-effects (expand in artifact)

- **Over-intercept:** only fires when topicId === hub AND text matches the strict command regex; ordinary hub chat falls through (parseHubCommand returns null). FAIL-OPEN.
- **Under-intercept:** a creatively-phrased "open it please" might not match → falls through to the agent (who still has the #392 guidance as backstop). Acceptable; the common forms are covered.
- **Interaction:** sits after the sentinel intercept (emergency-stop wins), before normal injection — mirrors the established order. No double-action (returns on hit).
- **Rollback:** localized to the forward handler + the extracted helper + load() timestamp + naming; clean revert.

## 8. Convergence findings (2 reviewers, 2026-05-26) — folded into v2

**C1 — DUAL-PATH (critical, correctness reviewer).** The draft's `/internal/telegram-forward` location is DEAD CODE for server-polling agents: lifeline agents arrive via the forward route → `telegram.onTopicMessage` (routes.ts:8638), but polling agents go `TelegramAdapter.processUpdate` (TelegramAdapter.ts:3432) → fires `onTopicMessage` directly (3590), never touching the forward route. **Resolution: intercept at `telegram.onTopicMessage` (server.ts:1158), the convergence both paths reach** (it already does `/new`/slash/fix-command interception at ~1174-1206). Single location, both modes. Integration tests must cover BOTH the polling and forward paths (or assert at the `onTopicMessage` seam).

**C2 — discriminated `bindHubConversation` result (correctness).** The route body (routes.ts:13164-13201) interleaves `res.status().json(); return` for 404/409/400/500. The extracted `bindHubConversation(ctx, args)` MUST return a discriminated result (`{ ok:true, topicId, topicName } | { ok:false, status, error }`) and STOP writing to `res` — each caller (route vs intercept) owns its own response + telegram messaging.

**C3 — AUTO-PICK on bare "open this" (UX reviewer, adopted).** Do NOT ask "which one?" on a bare "open this" — the operator is looking at the feed and means the conversation in front of them (most-recent). With D3 fixing ordering, `mostRecentUnbound().record` is reliable. The intercept passes an `autoPick:true` flag so `bindHubConversation` resolves to the most-recent unbound EVEN when `ambiguous`, and the hub confirmation names what was opened ("Opened 'X' — say 'open the &lt;other&gt; one' if you meant another"). The 409-ambiguous behavior is RESERVED for the `POST /threadline/hub/bind` API path (no human watching).

**C4 — no double-post (UX).** `bindHubConversation` already posts to the new topic (routes.ts:13196) AND `noteInHub` (13197). The intercept must NOT add a third hub message — reuse `noteInHub` as the single hub confirmation.

**C5 — topic-name privacy (UX, medium).** The gist becomes a topic NAME visible in the chat list + persisted. Hard-cap ~40 chars (Telegram limit 128), apply the same `[^\w-]`-class charset scrub the `peer` path uses, and fall back to `&lt;peer&gt; · &lt;threadId8&gt;` when the gist is empty or looks credential-like. 

**C6 — fail-open `getHubTopicId()`.** It does a synchronous `load()` (file read) per call — correct + fresh, but wrap the intercept in try/catch so a corrupt state file can't break the inbound path. Pre-creation it returns `undefined` → `Number(topicId) === undefined` is always false → all topics fall through (non-hub topics safe). ✓

**C7 — `tie ... to (.+)` greedy tail (low).** "tie this to the X topic and summarize" captures the trailing clause. Acceptable (operator owns phrasing); `open` is the 99% path. Optionally strip a trailing " and ..." clause.

**D3 confirmed:** `new Date(index+1).toISOString()` string-sorts correctly + is older than any real `new Date()` surfacing (legacy = older). Idempotent read-time. ✓ And `migrateClaudeMd` (not just `generateClaudeMd`) must get the content-sniffed "open this is structural now" note (Agent Awareness + Migration Parity).
