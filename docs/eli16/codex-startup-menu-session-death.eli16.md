# Why codex sessions died 18 seconds after starting — in plain English

## The symptom

Every fresh interactive codex session died about 18 seconds after it was
spawned. Not "hung", not "refused to answer" — the terminal pane vanished
entirely, as if someone had closed the window.

## What was actually happening

Codex 0.147 started opening every interactive session with a menu:

```
✨ Update available! 0.147.0 -> 0.149.0

› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version

  Press enter to continue
```

Two details matter. First, this menu **blocks** — codex will not proceed
until someone answers it. Second, the highlighted default is **"Update
now"**, and choosing it makes codex shell out to `npm install` and **exit**.

So the fatal sequence was: instar spawns a session → codex draws the menu →
instar decides the session is ready → instar types the user's first message
and presses Enter → Enter lands on "Update now" → codex exits → the pane
dies. Roughly 18 seconds, every time.

## Why instar thought a menu was a ready prompt

Instar has a check that reads the terminal and answers one question: "can I
type into this pane right now?" It knows about two dangerous-looking states.
A pane that is still painting itself (typing there loses the message), and a
**menu** (typing there is worse — Enter *selects an option*, so an arriving
message can answer a question on the operator's behalf).

That check had a blind spot. Claude Code marks the focused menu option with
one cursor character; codex uses a different one. The "is this a menu?" half
only knew Claude's character. The "is this ready?" half already knew both.

So a codex menu fell straight through the menu test — no Claude character
present — and landed on the ready test, which saw codex's character and said
"ready, go ahead and type". The file's own documentation states the rule
that got broken: a menu is never ready, *no matter which glyphs it carries*.
It carried a glyph only half the file knew about.

## What changed

Three things, because the bug could hurt in three different ways.

**1. Both halves now read the same list of cursor characters.** This is the
actual fix. A codex menu is now recognised as a menu, so instar refuses to
type into it. This also covers codex menus nobody has seen yet — any future
blocking menu codex draws is caught by shape, not by its wording.

**2. Instar now tells codex not to check for updates at startup.** Codex has
its own setting for this, and instar passes it on every interactive launch.
The menu is never drawn, so the session is genuinely *usable* rather than
merely no-longer-fatal. Change #1 alone would have left sessions alive but
stuck.

**3. The stuck-menu watcher learned codex's footer.** Instar has a watcher
whose job is to report a session parked on a menu it could not clear. It
decides "this really is the bottom of a menu" by recognising the last line,
and it did not recognise codex's `Press enter to continue`. Without this,
fix #1 would have traded a loud death for a *silent* stall — instar
correctly declining to type, and nothing ever saying so.

## What was deliberately NOT done

Instar has a second watcher that *auto-answers* approval prompts by pressing
Enter. It was not taught this menu, on purpose. On this menu Enter is
precisely what kills the session — the focused option is the irreversible
one. Pressing a key whose meaning depends on where a cursor happens to be
sitting is the bug, not the cure. The same reasoning already applies to
grok's menus, which that watcher answers with a digit rather than Enter.

## How we know it works

The failure was reproduced first, not theorised. A faithfully-spawned codex
session sat alive on the menu; injecting a message plus Enter killed it in
under nine seconds — and genuinely upgraded the machine's codex from 0.147.0
to 0.149.0, which is direct physical proof that Enter ran the updater.

For each of the three fixes, the bug was put back and the new tests were
confirmed to fail. A test that passes with and without the fix guards
nothing.

Finally, a session was spawned through the real, built launch code: alive
past 20 seconds, sitting at a proper input prompt, and it accepted and
answered an injected message — the exact operation that used to kill it.

## A second menu we weren't looking for

While probing, codex turned out to have another blocking startup menu: it asks
whether you trust the contents of the directory it's running in, with the same
`Yes / No` shape and the same footer.

That one was misread as ready too — which means an arriving message plus Enter
would have picked "Yes, continue" and answered a **trust** question on your
behalf. Nobody would have seen it happen. It's now recognised as a menu with no
extra code, because the fix keys on the *shape* of a menu rather than on any
particular wording. That's the difference between fixing one menu and fixing the
class.

One honest consequence: a codex session in a directory you haven't trusted will
now wait for a real answer instead of quietly proceeding. Your agent's own home
directory is already trusted, so day-to-day nothing changes.

## What you would notice

If you use codex topics: they start working again, and they keep working the
next time codex ships a release. If you never use codex: nothing changes —
the launch flag is codex-only and the cursor-character fix cannot make a
Claude pane read differently than it did before.

## If this turns out wrong

Revert the commit. There is no migration, no stored state, and no change to
anything already on disk. The one behaviour an operator might miss is
codex's update prompt inside instar-spawned panes — `codex update` still
works, and a codex session started by hand outside instar is untouched.
