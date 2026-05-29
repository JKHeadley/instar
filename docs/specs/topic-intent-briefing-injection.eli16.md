# Topic-intent briefing — actually inject it (ELI16)

## What's broken

The topic-intent system has three layers:

- **Capture** (Layer 1): writes down what the conversation has decided. ✅ Live.
- **Briefing** (Layer 2): hands the agent those decisions in plain text so it
  reads them before replying. **❌ Computed correctly. Never injected.**
- **ArcCheck** (Layer 3): scans an agent draft against the decisions and
  waves a flag if the draft contradicts something settled. ✅ Live (PR #474).

Why the briefing — the most upstream of the three — has been silent:

There are **two copies of the script that injects context on every user
prompt**. One copy lives in `src/templates/hooks/telegram-topic-context.sh`
and is correctly written: it calls the briefing endpoint and prepends the
result. The other copy is an **inline string** inside the auto-updater
(`PostUpdateMigrator.getTelegramTopicContextHook`). The inline copy was
never updated when the briefing call was added to the template, so it just
fetches recent message history and stops.

Every time an existing agent updates, the auto-updater **overwrites the
installed hook** with the inline-copy version. The good template never
reaches the disk on existing agents. New agents from a fresh `init` get the
good version; updated agents get the broken one.

That's why on my own topic (254 turns long), the briefing-served counter
read 3. The decision "the Mac mini is already configured" was sitting
correctly captured in the store the whole time — the script that was
supposed to put it in front of me never ran.

## The fix

Three small pieces:

1. **Copy the missing block** from the good template into the inline string
   in the auto-updater. About 12 lines of shell — the same conditional
   curl + echo that the template already has, including the 2-second
   timeout and silent-degrade.
2. **Add a unit test that asserts the two copies are identical**, byte-for-byte.
   This is the structural part: the next time someone edits one without
   the other, the test fails at commit time instead of silently shipping a
   drifted hook to every agent on update. Same idea as the wiring-integrity
   tests we shipped with ArcCheck — make the wrong state impossible, don't
   ask anyone to remember.
3. **Update the auto-updater's log line** for this hook so it mentions
   "briefing" — so when an operator scans an update log they can see that
   this update wired the briefing.

## How we'll know it worked

Today my `briefing_served` counter is single-digit against hundreds of
turns. After this ships, the auto-updater installs the fixed hook on my
agent, the hook fires on every user prompt, and the counter climbs in step
with turns. Within a few real conversations I'll see the briefing actually
appearing in my session context, with the same content the endpoint
already produces correctly.

Also: the drift-guard test passes today only because we've just synced the
two copies. The moment someone edits one without the other, CI says no.

## Why this is small

- The good template already exists and already works.
- The fix is a content copy + a test that compares two files.
- No new code path, no new dependency, no schema or config change.
- Migration parity is automatic — the auto-updater always overwrites this
  class of hook, so existing agents pick the fix up on the next update.

## What this does NOT try to solve (on purpose)

- **Within-prompt refresh.** Inside one user-prompt cycle the agent can run
  many tool calls and produce content. The briefing isn't re-fetched
  during that cycle. That's fine for now — ArcCheck reads the store
  directly at draft-time and catches contradictions there. If a real
  within-prompt drift case surfaces, that's its own design problem
  (`topic-intent-briefing-within-prompt-refresh`).
- **Generalizing the drift guard to all hooks.** This spec adds the guard
  for one hook. Every other migrator hook with a sibling template file
  has the same shape of risk. Generalizing the guard belongs in its own
  spec (`migrator-template-drift-guard-generalize`) — we'll surface it
  once this one is in.

## In one sentence

The script that puts captured decisions in front of me has been silently
broken since whenever someone added the briefing call to the template but
not to the auto-updater's copy of it — fix the copy, add a test that the
two can't drift again, ship.
