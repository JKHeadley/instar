---
slug: topic-intent-briefing-injection
title: Topic-intent briefing — wire the migrator hook to actually inject it (drift fix + anti-drift guard)
author: echo
project: continuous-working-awareness
review-convergence: ""
review-iterations: 0
review-completed-at: ""
review-report: ""
approved: false
approved-by: ""
approved-at: ""
eli16-overview: topic-intent-briefing-injection.eli16.md
---

# Topic-intent briefing — actually inject it

## Problem statement

The topic-intent system has three layers. Layer 1 (capture) is live since
2026-05-25. Layer 3 (ArcCheck) was just wired in PR #474 (v1.3.60). **Layer 2
— the briefing that puts the captured frame into the agent's context — is the
remaining dead spot, and not for the reason it looked from the outside.**

The briefing endpoint (`GET /topic-intent/:topicId/briefing`) is live and
returns a clean, rendered ACTIVE-TASK-FRAME / SETTLED / TENTATIVE block. The
canonical UserPromptSubmit hook at
`src/templates/hooks/telegram-topic-context.sh` correctly fetches that
endpoint and prepends the briefing to the per-prompt context block.

But the **PostUpdateMigrator carries an inline copy of the same hook** in
`getTelegramTopicContextHook()` (`src/core/PostUpdateMigrator.ts:5360`), and
**that inline copy never had the briefing-fetch added** — it only fetches
recent message history. Per the Migration Parity Standard, the migrator's
`migrateHooks()` runs on every PostUpdateMigrator pass and **always
overwrites** built-in `instar/` hooks. So existing agents, on every update,
have their installed hook silently replaced with the drifted inline version
that does not inject the briefing.

**Live evidence:**

- On the canonical main as of 2026-05-28 (v1.3.71): `src/templates/hooks/telegram-topic-context.sh`
  contains 2 `topic-intent` references (the two curl branches that fetch the
  briefing); `src/core/PostUpdateMigrator.ts` contains **zero**.
- On a real long-running agent (topic 13481): the briefing-served counter
  was 3 across 254 turns — the briefing was almost never being injected
  because the installed hook is the migrator's drifted copy. The mac-mini
  SETTLED ref was in the store but never reached the agent's context. That
  is precisely why the agent drafted "we need a second machine" while the
  store said the mini was configured. ArcCheck (PR #474) is a fallback that
  fires on draft-vs-store contradiction; **the briefing is the upstream
  surfacing layer that should keep the agent on-frame in the first place**.

**Why this happened (the deeper class):** the canonical hook content has two
sources of truth — the `src/templates/hooks/` file used by `init`, and the
inline string returned by `PostUpdateMigrator.getTelegramTopicContextHook()`
used by migration. Without a structural guard, edits to one silently drift
from the other. This bit us here; without a guard it can bite us again on
any other hook that has this dual-source-of-truth shape. The fix is a
narrow content sync now PLUS a structural drift guard so it cannot recur on
this hook.

## Proposed design

### 1. Sync the migrator hook content with the canonical template

Update `getTelegramTopicContextHook()` in `src/core/PostUpdateMigrator.ts`
so its returned string contains the same briefing-fetch block already
present in `src/templates/hooks/telegram-topic-context.sh`:

```bash
# Layer 2: prepend the topic intent briefing if anything has accumulated.
# Returns empty body when nothing tracked yet — silently skip injection.
# Degrades open: any failure (server down, route 503'd, network blip)
# leaves recent-history-only output unchanged.
TOPIC_BRIEFING=""
if [ -n "$AUTH_TOKEN" ]; then
  TOPIC_BRIEFING=$(curl -s --max-time 2 \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    "http://localhost:${PORT}/topic-intent/${TOPIC_ID}/briefing" 2>/dev/null)
else
  TOPIC_BRIEFING=$(curl -s --max-time 2 \
    "http://localhost:${PORT}/topic-intent/${TOPIC_ID}/briefing" 2>/dev/null)
fi

if [ -n "$TOPIC_BRIEFING" ]; then
  echo "$TOPIC_BRIEFING"
  echo ""
fi
```

The block is **degrade-open** (2s timeout, empty body when nothing tracked
yet, never blocks the rest of the hook output). Position: prepended before
the recent-messages output, so the agent sees the topic-frame first when
processing a new user prompt.

### 2. Anti-drift guard test

A new unit test that asserts byte-equality (or content-equivalence after
trimming) between the canonical template file and the migrator's inline
hook string:

```ts
import fs from 'node:fs';
import path from 'node:path';
// (illustrative — paths resolved relative to repo root)
const template = fs.readFileSync(
  path.resolve(__dirname, '../../src/templates/hooks/telegram-topic-context.sh'),
  'utf-8',
);
const migrator = new PostUpdateMigrator({...});
const inline = (migrator as any).getTelegramTopicContextHook();
expect(inline.trim()).toBe(template.trim());
```

The test fails whenever the two diverge — the next session that edits one
without the other gets caught at commit time, not in production six months
later. **Structure > willpower applied to the dual-source-of-truth class:
the rule is enforced in CI rather than carried as a "remember to update
both places" comment.**

### 3. Migration parity (already in place — but verify the loop closes)

Per the Migration Parity Standard, `migrateHooks()` always overwrites the
`.instar/hooks/instar/telegram-topic-context.sh` file on every PostUpdateMigrator
pass. So once the inline content is corrected, **every existing agent gets
the fixed hook on its next update** — no per-agent intervention, no opt-in.
Verify via:

- An integration test that constructs a temp `.instar/hooks/instar/` dir,
  runs the migrator's installation step, and asserts the installed file
  contains the briefing-fetch curl line.

### 4. Observability — make the wire-up visible

On the next migration the migrator emits the existing
`hooks/instar/telegram-topic-context.sh (per-message unanswered detection)`
log line. That message is correct but does not mention briefing injection.
Update the log line to reflect the actual capability:
`hooks/instar/telegram-topic-context.sh (briefing + per-message unanswered
detection)`. Tiny, but it surfaces the migration impact in the migrator's
output so an operator scanning logs sees that this update wired the
briefing.

## Out of scope (tracked refinements)

- **Generalize the anti-drift guard to all migrator/template hook pairs.**
  This hook is one instance of a fleet-wide pattern: every `getXxxHook()`
  method on PostUpdateMigrator is a potential drift candidate against
  whatever lives in `src/templates/hooks/Xxx.sh` (when it exists). The
  generic version walks the migrator's `getHookContent` allowlist and
  diffs each against the canonical template, ignoring hooks with no
  template file. **Tracked as `migrator-template-drift-guard-generalize`.**
  Out of scope here because the systemic fix is its own spec and design
  decision (e.g. should the migrator *read* from the template file at
  runtime instead of carrying an inline copy?). v1 closes the immediate
  miss + the immediate hook.
- **Agent-self-prompt mid-session refresh.** Within a single user-prompt
  cycle the agent may run many tool calls and produce content without a
  new UserPromptSubmit. The briefing is fetched fresh on each user prompt
  (UserPromptSubmit fires per-prompt), so the briefing stays current
  *across* user prompts. ArcCheck (PR #474) reads the store directly and
  fires at outbound-send time, so within-prompt drift is signal-covered.
  A genuine within-prompt re-injection (e.g. via a `PreToolUse` hook or
  PostCompact hook) is a separate design question. Tracked as
  `topic-intent-briefing-within-prompt-refresh`.

## Lessons carried

- **Dual-source-of-truth is a structural bug, not a discipline bug.** The
  comments at PostUpdateMigrator hook bodies do say "canonical source:
  src/templates/hooks/Xxx.sh" in several places, and they still drifted —
  because the comment is a wish, not a guarantee. The fix is to make the
  drift fail a test, not to ask future-us to remember.
- **Signal-only fallbacks don't replace the upstream surface.** ArcCheck
  catches drift at draft time. The briefing keeps the agent on-frame in
  the first place. Both layers belong; neither substitutes for the other.

## Testing (all three tiers + drift guard)

- **Tier 1 (unit):**
  - Drift guard: `getTelegramTopicContextHook()` output equals (trim-equal)
    the contents of `src/templates/hooks/telegram-topic-context.sh`.
  - Content check: the output contains the literal
    `/topic-intent/${TOPIC_ID}/briefing` curl line in both
    authenticated and unauthenticated branches.
- **Tier 2 (integration):**
  - Construct a temp agent dir; run the migrator's hook-install step;
    assert the installed `.instar/hooks/instar/telegram-topic-context.sh`
    contains the briefing-fetch curl line.
- **Tier 3 (e2e):**
  - Boot an Express app mounting `topicIntentRoutes` (existing pattern).
  - Seed a topic with a SETTLED ref via `appendEvidence`.
  - `exec` the installed hook against the live server, with a synthetic
    `[telegram:N]` prompt on stdin.
  - Assert the hook's stdout contains the rendered briefing block (the
    `=== TOPIC N INTENT BRIEFING ===` header) PLUS the recent-messages
    block. Both surfaces preserved.

## Acceptance criteria

1. After this ships, `PostUpdateMigrator.getTelegramTopicContextHook()`'s
   output contains the briefing-fetch curl line (both auth branches),
   verified by unit + content check.
2. The drift-guard unit test passes (template == migrator inline output).
3. Migration on an existing agent installs a hook that, when run against a
   topic with refs, produces output containing the briefing block.
4. Recent-message-history output is preserved verbatim (no regression of
   the existing unanswered-message-detection behaviour).
5. Briefing fetch failures (route 503, network blip) degrade open — the
   hook still emits recent-history (no shell error, no agent-visible
   breakage).
6. The migrator's log line for this hook mentions "briefing" so the impact
   is visible in upgrade output.

## Risk and rollback

Low. The change is a content addition to a shell script: a `curl --max-time 2`
+ a conditional `echo`. The shell guards (`if [ -n ]`, `2>/dev/null`,
`--max-time 2`) bound the worst-case to "briefing not injected for one
prompt" — which is **exactly today's behaviour** for stale-hook agents.
Rollback: revert the migrator change; next migration pass reinstalls the
prior content. No state, no config, no schema changes.

## Migration parity

`migrateHooks()` already always-overwrites built-in `instar/` hooks on every
update. No new migration code needed — the fix flows through the existing
overwrite path automatically.

## Why not a deeper "real-time" refresh design

The user-facing question — "the agent should not drift mid-session" — is
answered by the existing per-user-prompt fire of UserPromptSubmit plus
ArcCheck's draft-time check. Once the briefing is actually injected on each
user prompt (this fix), the briefing reflects the latest store state on
every turn, and within-prompt drift hits ArcCheck. A deeper "refresh on a
timer / on store mutation / via PostCompact" design adds machinery to solve
a problem that does not exist once this fix lands. If a residual within-prompt
gap surfaces in real conversations, it belongs in
`topic-intent-briefing-within-prompt-refresh` — not here.
