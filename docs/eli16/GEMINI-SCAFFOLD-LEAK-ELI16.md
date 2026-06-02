# The Gemini scaffold leak — explained simply

## The problem

When you install an Instar agent you pick which "brain" it runs on — Claude, Codex, or
Gemini. If you picked **Gemini only**, the agent was still dropping a **Claude
configuration file** (`.claude/settings.json`) into your project — a file full of
Claude-specific hooks that a Gemini agent can never use. Harmless, but wrong and
confusing: a Gemini agent shouldn't have Claude's settings sitting in it.

Codey found this for real: he installed a fresh Gemini agent and noticed it had a
7.5 KB Claude settings file even though it was set to Gemini-only.

## Why it happened

Deep in the install code there's a step that reads back "which brains are enabled" and
then decides whether to write the Claude settings. That step had a hand-written list
that only recognized two brains: `claude-code` and `codex-cli`. **Gemini wasn't on the
list.**

So when it read `["gemini-cli"]`, it filtered out the one entry it didn't recognize,
ended up with an empty list, and fell back to a default of `["claude-code"]` — which
made it think Claude was enabled. So it wrote the Claude file. The agent was told "you
only run Gemini," but a stale hard-coded list quietly overruled that.

## The fix

Instead of a hand-written list that someone has to remember to update every time a new
brain is added, there's now **one canonical list of known brains** (`KNOWN_FRAMEWORKS`)
that includes Gemini — and a single helper (`isKnownFramework`) that both spots in the
code use. So:

- A **Gemini-only** install no longer gets a Claude settings file.
- A **Codex-only** install no longer gets one either (it had the same blind spot).
- A **Claude** install is completely unchanged — it still gets its settings.
- And the next new brain we add won't silently hit this bug, because the list is in one
  place tied to the official type.

## How we know it's fixed

A test drives the real install step four ways — Gemini-only, Codex-only, Claude-only,
and Claude+Gemini — and checks the Claude settings file appears exactly when Claude is
actually one of the enabled brains, and never otherwise. All four pass.

## One honest note

Agents installed *before* this fix still have the stray file sitting there (the fix
stops creating it; it doesn't reach back and delete the old one). That leftover is inert
— it just sits there unused — and cleaning it up safely is a small separate follow-up.
