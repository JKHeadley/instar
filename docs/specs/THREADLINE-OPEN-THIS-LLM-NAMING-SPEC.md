---
name: threadline-open-this-llm-naming
review-convergence: 2026-05-27T14:55:00Z
approved: true
eli16-overview: THREADLINE-OPEN-THIS-LLM-NAMING-ELI16.md
---

# THREADLINE-OPEN-THIS-LLM-NAMING-SPEC

**Status:** CONVERGED — awaiting operator approval (`approved: true`)
**Author:** Echo · **Date:** 2026-05-27 · **Base:** JKHeadley/main @ v1.3.27
**Tracks:** CMT-567 · topic 12304 · UX continuation of PR #399 (CMT-529)

> **Round-1 review folded in (2026-05-27):** lane → `interactive` (a `background` brief would be silently aborted by a PresenceProxy arrival — and the operator IS waiting); adopt the proven **PURPOSE-line** convention + exported `parsePurposeFromResponse` from `TopicSummarizer` instead of fragile JSON parsing; explicit hub-notice-only guard (`conversationStore.get == null` → fallback, no LLM call); **fallback is now a deterministic templated brief, NOT the generic tie-marker** — so the operator gets real context EVERY time and the LLM only polishes it; structured observability log line; plain-text summary with one bold header line. See §11 for the round-1 disposition.

---

## 1. Problem

PR #399 made "open this" deterministic — but the produced topic is unfriendly in two concrete ways the operator (Justin) hit on 2026-05-27 (screenshots in topic 12304):

- **D1 — name is a raw snippet.** `topicNameFor()` slugs the first ~6 words of `subject` / `lastInboundHash`. For a cold relay message that opens with "Hey echo, quick check on the…", the topic ends up named "Hey echo quick check on" — the literal lead, not what the conversation is *about*. The operator can't tell which conversation a topic is from glancing at the chat list.
- **D2 — new topic is empty of context.** The only message in the new topic is `🧵 This Threadline conversation is now tied to this topic — updates will land here.` — a generic tie-marker. The operator walks in with zero idea who they're talking to, what the thread is about, or where it currently stands; they have to manually go read the hub history (which they were trying to escape by opening it in the first place).

Both defects nullify the point of "open this": pulling a conversation into its own space is supposed to give the operator a *workable* topic. Right now it gives them an unlabelled empty room.

## 2. Goals / Non-goals

**Goals:** (1) Newly-opened topics are named by an LLM from the *actual* conversation gist (what it's about — not the first words). (2) The first message in a newly-opened topic is an LLM-written brief summary of the conversation so far (who's talking, what about, where it stands). (3) Both behaviors are *strictly additive* — they never block, slow, or break the deterministic "open this" intercept on LLM failure / timeout / cost-cap; existing `topicNameFor()` slug + the current generic tie-marker remain as fallbacks. (4) Privacy and cost guarantees from PR #399 are preserved (credential scrub, length cap, daily LLM spend cap honored).

**Non-goals:** changing the deterministic intercept (PR #399); renaming or re-summarizing *existing* opened topics (one-shot at open time); the "tie this to &lt;topic&gt;" path (binds to an existing topic — no name to generate, no first-message to write); any retroactive backfill on already-bound conversations.

## 3. Design

### Fix 1 — LLM-generated topic name + summary, with a deterministic templated fallback (D1 + D2)

A new module `src/threadline/openConversationBrief.ts` exports:

```ts
export interface ConversationBrief {
  topicName: string;       // ≤ 40 chars, scrubbed, NEVER empty
  summary: string;         // ≤ 600 chars, scrubbed, NEVER empty
  source: 'llm' | 'template' | 'slug';   // observability: where each field came from
}

export interface BriefDeps {
  observability: { getThread(threadId: string): { messages: { direction: 'in'|'out'; text: string; remoteAgentName: string; timestamp: string }[] } | null } | null;
  llmQueue: LlmQueue | null;                    // shared cross-monitor queue; null → no LLM
  intelligence: Pick<IntelligenceProvider, 'evaluate'> | null;   // tighten to the real provider so wiring typechecks without `as` (round-2 fix)
  topicNameFallback: (conv: unknown, threadId: string) => string;   // existing topicNameFor()
  now?: () => number;                           // injectable for tests
}

export async function generateConversationBrief(
  threadId: string,
  conv: { subject?: string; participants?: { peers?: string[] }; lastInboundHash?: string; messageCount?: number } | null,
  deps: BriefDeps,
  opts?: { timeoutMs?: number },
): Promise<ConversationBrief>;
```

`bindHubConversation` (in `hubCommands.ts`) calls this in the `open` branch **before** `findOrCreateForumTopic`, uses `brief.topicName` for the topic, and posts `brief.summary` as the first message. **Because `summary` is never empty (template fallback), the operator always lands in a topic with real context — the generic tie-marker is retired from the `open` path entirely.** (It survives only on the `tie` path — see Fix 2.)

### Fix 1a — three-tier brief generation (LLM → template → slug)

The brief is built defensively, best-quality-first, each tier degrading without ever failing the bind:

**Tier A — LLM (best).** Invoked only when there's a *real* conversation worth summarizing: `conv != null` AND `observability?.getThread(threadId)?.messages.length >= 2`. Uses the **proven PURPOSE-line convention** from `TopicSummarizer` (NOT JSON — JSON-from-free-text with no schema enforcement is the fragility we're avoiding; `IntelligenceOptions` has no `responseFormat` field). Reuse the exported `parsePurposeFromResponse` helper (`TopicSummarizer.ts:227`).

> **Round-2 edge (`body || text`):** `parsePurposeFromResponse` returns `body: body || text` — so a response that is a PURPOSE line with NO body returns the whole `PURPOSE: …` string as `body`. We must NOT post that as the summary. Rule: take `purpose` → name; take `body` → summary ONLY when `body` is non-empty AND does not start with `PURPOSE:` (case-insensitive). Otherwise summary degrades to the Tier-B template (name can still come from a clean PURPOSE line). This keeps name + summary independently sourced.

Prompt (`intelligence.evaluate(prompt, { model: 'fast', maxTokens: 320 })` — Haiku):

```
You are preparing a forum topic for an operator who is about to open an ongoing
agent-to-agent conversation into its own space. Write a short topic title and a brief
orientation summary.

Conversation (last N messages, oldest → newest, each side labelled):
<<<
{{ messages }}
>>>

FORMAT — your response MUST be:
PURPOSE: <a 4–6 word title naming what this conversation is ABOUT — not who spoke,
         no IDs, no emoji, no quotes>

<2–4 plain sentences: who the other agent is, what this is about, and where it
 currently stands (open question / decision pending / waiting on X). No markdown.>
```

- **Input bound:** last 10 messages, each truncated to 800 chars.
- **PURPOSE line → `topicName`** (scrubbed + capped, see Fix 1c). **Body → `summary`** (scrubbed + capped). If the PURPOSE line is missing/empty after parse, the topic name degrades to Tier B/C while the body can still serve as summary (if non-empty + clean).
- **Queue lane:** `interactive` via `llmQueue.enqueue('interactive', fn, costCents=2)` (signature confirmed `LlmQueue.ts:82`). The operator typed "open this" and is watching Telegram for the topic to appear — textbook interactive-latency contract (same as a PresenceProxy tier reply). `background` would let a PresenceProxy arrival abort the in-flight brief (`LlmQueue.ts:128-138` preempts only `background` victims; interactive is never aborted), silently dropping the operator back to a worse name. `costCents=2` (Haiku ~1k in + ~320 out ≈ <1 cent).
- **Timeout / abort:** `intelligence.evaluate` does NOT accept an `AbortSignal` (`ClaudeCliIntelligenceProvider` runs `execFile` and honors only its own `timeoutMs`). So the `fn` manually `Promise.race`s `evaluate` against (a) a `setTimeout(timeoutMs)` reject and (b) the queue's `signal.addEventListener('abort', …)` reject — exactly the PresenceProxy pattern (`PresenceProxy.ts:1700-1709`). On either → degrade to Tier B. **Default `timeoutMs` = 15000** (see test-as-self note below).
  > **TEST-AS-SELF DEVIATION (2026-05-27):** the draft used a 3.5s ceiling on the assumption that a Haiku call is sub-second. Running the BUILT module against real Claude (and then a real Codex agent) measured **~8-10s end-to-end** for a ~10-message thread — CLI cold-start dominates. A 3.5s budget would have timed out the LLM tier on nearly every real "open this" and silently fallen to the template, defeating the feature's happy path. Raised the default to **15s**. It's a one-shot operator action, the call is non-blocking (next bullet), and the deterministic template still covers any overrun — so the wait cost is bounded and acceptable.
- **No inbound back-pressure.** The intercept lives in `telegram.onTopicMessage`, which the lifeline-forward path invokes WITHOUT `await` (`routes.ts` returns 200 immediately) and which is NOT serialized across messages — each invocation is an independent async. So the (≤15s) await inside the hub-command branch delays only THAT handler, never inbound message throughput.

**Tier B — deterministic templated brief (no LLM, always available when a conversation exists).** When the LLM tier is skipped (deps null / <2 messages) or fails (timeout / abort / cap / scrub-rejected / empty), build a brief from data already on hand — zero cost, zero latency, perfectly deterministic:
- `topicName` ← `topicNameFallback(conv, threadId)` (existing `topicNameFor()` slug).
- `summary` ← templated:
  `💬 Conversation with <peerName> · <messageCount> messages · last activity <relative time>.\nLatest: "<last inbound text, truncated 200 chars, scrubbed>"`
  For a single-message thread this reads `💬 Conversation with <peer> · 1 message. Opening message: "<truncated>"`. This is strictly more useful than the old empty tie-marker and needs no model.
- `source: 'template'`.

**Tier C — slug only (no conversation at all).** When `conversationStore.get(threadId) == null` (a hub-notice-only entry with no backing `Conversation`) OR `observability.getThread` is null/zero-message: `topicName ← topicNameFallback`, `summary ← '💬 This Threadline conversation is now tied to this topic — updates will land here.'` (the legacy marker, retained ONLY for this genuinely-context-free case). `source: 'slug'`. **No LLM call is attempted** — the precondition guard catches this before dispatch.

### Fix 1b — fallback causes (all → Tier B or C, never bind failure)

Each cause is recorded in the observability log (Fix 1d):
- `intelligence` or `llmQueue` is `null` → Tier B (conversation exists) / Tier C (none).
- `< 2` messages → skip LLM (Tier B if `>=1` message, Tier C if `0`).
- LLM rejects: `LlmAbortedError`, `LLM daily spend cap exceeded`, generic timeout/error → Tier B.
- PURPOSE-line missing AND body empty → Tier B.
- Credential regex (`CREDENTIAL_RE`) hits the PURPOSE line → name degrades to slug (Tier B name); hits the body → summary degrades to template body. (Per-field degrade, not whole-brief discard — a clean title shouldn't be thrown away because the body tripped, and vice-versa.)

### Fix 1c — scrub + cap (applied to every tier's output before it leaves the module)

- `topicName`: strip newlines; collapse internal whitespace; `CREDENTIAL_RE` hit → use slug; enforce `NAME_MAX = 40` (slice + trim); empty / < 4 chars → slug.
- `summary`: `CREDENTIAL_RE` hit → use the Tier-B template body (which is itself scrubbed); enforce 600-char cap (slice on a word boundary); empty → Tier-B/C body.

### Fix 1d — observability (silent fallback is otherwise an invisible regression)

`bindHubConversation` logs ONE structured line per open:
`[hub/bind] open threadId=<8> topic=<id> nameSource=<llm|template|slug> summarySource=<llm|template|slug> latencyMs=<n> reason=<ok|no-conversation|too-few-messages|llm-timeout|llm-abort|llm-capped|credential-scrub|parse-empty>`
This makes "what % of opens silently fell back, and why" answerable from `logs/server.log` without new infra.

### Fix 1e — wiring in `bindHubConversation`

```ts
// In the action:'open' branch, BEFORE findOrCreateForumTopic:
const existing = conversationStore.get(threadId);
const brief = await generateConversationBrief(threadId, existing ?? null, deps.brief); // default timeoutMs = 15000
const t = await telegram.findOrCreateForumTopic(brief.topicName);
topicId = t.topicId; topicName = t.name;
// …authoritative bind unchanged…
await telegram.sendToTopic(topicId, brief.summary).catch(() => { });   // never empty — see Fix 1a
```

**`HubBindDeps` gets a new field `brief: BriefDeps`. Round-2 fix — there are THREE assembly sites, not two:**
1. `server.ts` getHubDeps closure (send-only path, ~3120)
2. `server.ts` getHubDeps closure (full-poll path, ~3308)
3. `POST /threadline/hub/bind` route (`routes.ts` ~13424)

Sites 1+2 are inside the same outer server function where `sharedLlmQueue` (~5881), `threadlineObservability`, and `sharedIntelligence` (~2571/2667) are all in lexical scope; the closures fire at message-time (after those `const`s are initialized — no TDZ), so they can build `BriefDeps` directly. **Site 3 cannot** — `RouteContext` / `AgentServerContext` exposes `threadlineObservability` but NOT `sharedLlmQueue` (it isn't in the `AgentServer` constructor arg list).

**Resolution — build `BriefDeps` ONCE at server startup and share it.** Assemble a single `briefDeps: BriefDeps` object where all three deps are in scope (server.ts, after `sharedLlmQueue` is constructed), then: (a) pass it into both getHubDeps closures, and (b) add `briefDeps` to `AgentServerContext` so the route handler reads `ctx.briefDeps`. One construction, three consumers, no per-site reachability puzzle. If any underlying dep is unavailable in a given build/env, the single `briefDeps` carries the corresponding null → Tier B/C automatically (the API path then degrades gracefully rather than silently always-degrading because the route couldn't see the queue).

### Fix 2 — keep the `tie` branch as-is

`action:'tie'` binds to a topic the operator already named — no LLM naming needed (the operator chose the name). The existing tie-marker first-message is posted (its job there is to mark the bind point in an *existing*, populated topic — a generated summary would be redundant and could collide with content already in that topic).

### Why sync, not async (rejected alternative)

The "create topic with a placeholder name, fire the LLM in the background, then `editForumTopic` + post the summary when it returns" pattern decouples bind latency from LLM latency — but it produces a visible name-flicker in the operator's chat list (placeholder → real name seconds later) and a topic that's briefly empty then suddenly populated. The sync path keeps the topic correct from first render; for a one-shot operator-initiated action the ~8-10s wait (measured, see the timeout note) is acceptable, and the Tier-B template guarantees the summary is instant whenever the LLM overruns the 15s window.

## 4. Privacy / Safety / Cost

- **Credential leak prevention.** The cold first message of a conversation can be anything — including a pasted token. `CREDENTIAL_RE` is applied to every field BEFORE it leaves the module (LLM output, the Tier-B template's `Latest: "<inbound>"` snippet, and the slug). A hit degrades that field to the next tier (per-field, not whole-brief). The LLM *input* necessarily contains the raw messages — acceptable because (a) it goes through the same intelligence provider already used for in-conversation work, same trust boundary; (b) the output lands ONLY in the *new operator topic* the operator just asked to open — never the chat-list-visible title beyond the 40-char scrubbed name, never to peers.
- **Length caps.** `topicName ≤ 40 chars` (Telegram allows 128; keep it scannable + chat-list-safe). `summary ≤ 600 chars` (~3–4 short sentences; longer = the operator just reads the hub history anyway).
- **Daily LLM spend cap.** Honored via `LlmQueue` — `interactive` lane, `costCents=2` per call. The daily cap is a single total across both lanes (`LlmQueue.ts:90`); the 40% reserve only *blocks the background lane* from pushing total spend into the reserved slice (`:97-102`) — there is no separate interactive sub-budget. The practical effect: interactive "open this" briefs are never reserve-blocked, and once the total cap is hit the call rejects → transparent Tier-B degrade. "open this" is an infrequent explicit operator action (a handful/day), so its draw on the shared cap is negligible.
- **No side-effects on cap-exceeded / preemption.** A capped or aborted "open this" produces a slug-named topic + the deterministic Tier-B template summary — the operator still gets a *contextful* topic, just without LLM polish. The bind always succeeds.

## 5. Implementation steps (atomic commits)

1. `feat(threadline): generateConversationBrief (LLM→template→slug) + unit tests`
   - New file `src/threadline/openConversationBrief.ts` — the 3-tier generator; reuses `parsePurposeFromResponse` from `TopicSummarizer` (export it if not already module-public — it is, per `TopicSummarizer.ts:227`).
   - New file `tests/unit/threadline/openConversationBrief.test.ts` — cases per §6.
2. `feat(threadline): wire conversation brief into bindHubConversation 'open' path`
   - `src/threadline/hubCommands.ts`: add `brief: BriefDeps` to `HubBindDeps`; call `generateConversationBrief` in the `open` branch; post `brief.summary` (never empty); add the Fix-1d log line.
   - Update `tests/unit/hubCommands.test.ts` — LLM / template / slug paths (mock the brief generator).
3. `feat(server): construct shared briefDeps + thread to all three bind sites`
   - `src/commands/server.ts`: build ONE `briefDeps: BriefDeps` after `sharedLlmQueue` is constructed; pass into both getHubDeps closures (~3120, ~3308).
   - `src/server/AgentServer.ts` (`AgentServerContext`) + `src/server/routes.ts`: add `briefDeps` to the context; the `POST /threadline/hub/bind` handler (~13424) reads `ctx.briefDeps`. (This is the round-2 fix: the route had no path to `sharedLlmQueue`.)
   - Update `tests/integration/threadline/hub-bind-routes.test.ts` — happy path (LLM), throwing-stub (template), null-intelligence (template/slug); bind always succeeds.

Each commit ships green tests for the surface it touches. Full suite green at the end.

## 6. Test plan (3-tier)

**Unit — `tests/unit/threadline/openConversationBrief.test.ts`** (new):
- Happy path: stub-intelligence returns `PURPOSE: …\n\n<body>` → `{ source:'llm' }`, PURPOSE → name, body → summary.
- LLM returns body with NO PURPOSE line but non-empty body → name degrades to slug, summary = body (mixed-source recorded).
- LLM throws timeout → Tier B (template summary, slug name, `source:'template'`).
- LLM throws `LlmAbortedError` → Tier B.
- LLM throws `LLM daily spend cap exceeded` → Tier B.
- LLM returns empty/whitespace → Tier B.
- PURPOSE line > 40 chars → trimmed to 40, accepted as name.
- PURPOSE line contains credential pattern (`sk-…`) → name degrades to slug; body still used if clean.
- Body contains credential pattern → name kept; summary degrades to the Tier-B template body.
- `intelligence` null → Tier B without any call (assert evaluate never invoked).
- `llmQueue` null → Tier B without any call.
- `< 2` messages (single "hi") → Tier B template `… 1 message. Opening message: "hi"`, NO LLM call.
- `conv == null` (hub-notice-only) → Tier C slug + legacy marker, NO LLM call.
- Input truncation: 50-message thread → last 10 in prompt, each ≤ 800 chars (captured-prompt assertion).
- PURPOSE line present, body empty (response is just `PURPOSE: …`) → name from PURPOSE, summary = Tier-B template (NOT the echoed `PURPOSE:` string). (Round-2 `body || text` edge.)
- Every tier: `topicName` and `summary` are BOTH non-empty (the never-empty invariant) — assert with valid input AND with `threadId = ''`/whitespace (the slug fallback `topicNameFor` still returns ≥ 4 chars).

**Unit — `tests/unit/hubCommands.test.ts`** (extend):
- open-with-LLM-success → `findOrCreateForumTopic` gets the LLM name, `sendToTopic` gets the LLM summary (NOT the legacy marker).
- open-with-template-fallback → `findOrCreateForumTopic` gets the slug, `sendToTopic` gets the template brief.
- open-with-no-conversation (Tier C) → slug name + legacy marker.
- tie-branch → operator-supplied name, legacy marker posted, brief generator NOT called.

**Integration — `tests/integration/threadline/hub-bind-routes.test.ts`** (extend):
- `POST /threadline/hub/bind action:open` vs a populated thread + stub-intelligence returning a PURPOSE+body → `response.topicName` matches the PURPOSE-derived name; Telegram mock saw the summary as the first `sendToTopic`.
- Same with stub-intelligence throwing → `response.topicName` is the slug; Telegram mock saw the template brief (NOT empty, NOT the legacy marker, since the thread has messages).
- `BriefDeps` with `intelligence:null` → template/slug path; **bind still 200** (regression guard: LLM problems NEVER fail the bind).

**E2E:** none new — the deterministic intercept's E2E alive-test (PR #399) still covers the path; this change is additive within `bindHubConversation`.

## 7. Migration parity

- **No agent-installed file changes.** Pure `src/` change inside the threadline module + tests + one new internal module. No `.claude/settings.json` hooks, no `.instar/config.json` defaults, no CLAUDE.md template, no hook scripts, no built-in skills. `PostUpdateMigrator` needs no entry. (Verified against the round-1 review item.)
- **Backwards-compatible for "tie".** The `tie` branch is unchanged — operators who name their own topic still get the legacy tie-marker.

## 8. Open product calls

None. Justin's request is concrete and direct ("an LLM should create the topic name and the first message should be a summary of the underlying conversation"). The implementation calls the spec resolves (lane, single-call-PURPOSE-convention, sync-vs-async, the templated-fallback floor) are operator-invisible engineering choices, documented in §3 with their round-1 review rationale — not decisions the operator needs to weigh in on.

## 9. Rollback

Single revert of the three commits (or of the merge commit) restores the slug-name + legacy-marker behavior verbatim. No state file changes (the new module is pure compute; no persisted artifacts).

## 10. Conformance to instar standards

- **Structure > Willpower.** The brief is generated deterministically inside `bindHubConversation`, not "agent should remember to summarize." Tier degradation is structural (not "agent decides whether the brief is good enough").
- **Testing Integrity (3-tier).** Unit + integration per §6. E2E coverage inherited from PR #399 (the deterministic intercept itself).
- **Migration parity.** None needed (§7).
- **Agent Awareness.** Operator-facing behavior inside an operator-invoked flow ("open this") — no new agent API to surface in CLAUDE.md. The agent doesn't call this.
- **Near-silent notifications.** Strictly improves the existing operator-initiated topic — no new pings, no new spam surfaces.
- **No-manual-work.** No new operator actions; no new flags to flip.
- **Signal vs authority.** The LLM is a *generator*, not a gate — worst case is a template-quality brief, never a blocked bind. The bind authority (deterministic intercept) is untouched.
- **Self-hosting / dogfood-to-ship.** Test-as-self on live Codey is the merge gate, same as PR #390 / #392 / #399.

## 11. Round-1 review disposition

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| 1 | BLOCKER | Wrong lane — `background` would be aborted by a PresenceProxy arrival; operator IS waiting | **Fixed** — lane=`interactive` (§3a, §4) |
| 2 | MAJOR | Should reuse `TopicSummarizer`, not a parallel module | **Partially adopted** — TopicSummarizer is coupled to `TopicMemory`/Telegram (wrong data source: this reads `ThreadlineObservability`/threadline). Reuse its **PURPOSE-line convention + exported `parsePurposeFromResponse`**; keep a thin threadline-specific module. Rationale documented (§3a, §5). |
| 3 | MAJOR | JSON-from-text with no schema is fragile | **Fixed** — switched to the proven PURPOSE-line convention; no JSON parsing (§3a) |
| 4 | MAJOR | Hub-notice-only entries: missing precondition guard | **Fixed** — Tier C: `conv == null` → fallback, no LLM call (§3a, test in §6) |
| 5 | MAJOR | Deterministic templated brief is competitive; LLM may not be needed | **Adopted as the floor** — Tier-B template is the fallback (not the empty marker), so the operator gets context every time; LLM polishes when available. Honors Justin's explicit "use an LLM" ask AND the robustness concern (§3a) |
| 6 | MINOR | Telegram markdown unspecified | **Resolved** — plain text; prompt forbids markdown; scrub strips backticks (§3a, §3c) |
| 7 | MINOR | Zero observability = silent-regression vector | **Fixed** — structured log line per open (§3d) |
| 8 | MINOR | One-cold-message should template, not fall to empty | **Fixed** — Tier B handles 1-message case explicitly (§3a) |
| 9 | NIT | Async pattern dismissed without a sentence | **Resolved** — explicit rejection with rationale (§3, "Why sync, not async") |
| 10 | NIT | §8 "no open calls" overclaimed | **Reworded** (§8) |

### Round-2 review disposition

Two independent reviewers re-checked the revised spec against the real code; both converged. Findings folded in:

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| R2-1 | MAJOR | THREE bind call sites, not two — `POST /threadline/hub/bind` (`routes.ts:13424`) has no path to `sharedLlmQueue` (not in `AgentServerContext`) | **Fixed** — build ONE shared `briefDeps` at startup, add to `AgentServerContext`, thread to all three sites (§1e, §5-step-3) |
| R2-2 | MAJOR | `BriefDeps.intelligence` typed `{model?: string}` is wider than `IntelligenceOptions.model` union → won't structurally match without a cast | **Fixed** — tightened to `Pick<IntelligenceProvider,'evaluate'>` (§3 interface) |
| R2-3 | MINOR | `parsePurposeFromResponse` returns `body: body||text` → a PURPOSE-only response echoes `PURPOSE:` as the summary | **Fixed** — summary uses `body` only when non-empty AND not starting `PURPOSE:`; else Tier-B template (§3a edge note + §6 test) |
| R2-4 | MINOR | Back-pressure rationale wrong — `onTopicMessage` is non-await + non-serial, so 3.5s never blocks inbound | **Fixed** — §3a now states the no-await/non-serial fact as the reason it's safe |
| R2-5 | MINOR | §4 "draws from reserved interactive budget" misdescribes the cap mechanism | **Reworded** — single total cap; reserve only blocks background (§4) |
| R2-6 | NIT | never-empty test should include empty/whitespace `threadId` | **Added** to §6 |
| R2-7 | NIT | `getThread` full-rescans inbox+outbox JSONL per call | **Acknowledged** — acceptable for a rare operator-initiated action; do NOT reuse `generateConversationBrief` on a hot path |

**Convergence:** both round-2 reviewers concluded the spec is buildable once R2-1/R2-2/R2-3 are folded in (done). Marking converged.
