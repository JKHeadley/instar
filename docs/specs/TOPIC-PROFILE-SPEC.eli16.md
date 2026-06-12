# Topic Profile — the plain-English version

## The itch

Right now, every Telegram topic you talk to me in has a few hidden "execution settings":
which **agent framework** runs it (Claude Code vs Codex), which **model** it uses (Opus vs
Fable 5), and how hard the model **thinks** (reasoning effort / extended thinking).

The problem: those three settings live in three different, half-finished places.

- **Framework** is already a proper sticky per-topic setting — you can say "use Codex here" and
  it sticks until you change it.
- **Model** is *automatic* — the system picks it by policy. You can't just say "this topic
  always uses Fable" and have it stay that way.
- **Thinking mode** can't be set per topic at all, even though both Claude and Codex support
  the knob underneath.

You asked for the obvious unification: full control over all three, set per topic, sticky
until you change them again — and when a change needs a fresh session, swap it smoothly with as
little lost context as possible.

## The idea: one Topic Profile

Treat those three settings as one thing — a **Topic Profile** — because they're really three
faces of the same question: *how should this topic run?*

A profile is just `{ framework, model, thinkingMode }`, saved to disk per topic. Set it once;
it persists across restarts and compaction until you deliberately change it. You set it three
ways: by just telling me ("switch this topic to Codex with high thinking"), with a `/topic`
command, or via the API.

## The honest hard part: swapping without losing the thread

Some changes can be applied to the running session in place. Others need a brand-new session.
The spec's core is a little decision table that picks the gentlest possible method and **tells
you what it costs**:

- **Change the model or thinking on a Claude topic** → I can usually do it with `--resume`,
  which reloads the *entire* conversation from Claude's own transcript. **Zero context lost.**
- **Change model/thinking on a Codex topic** → same idea, `codex resume`. **Basically nothing
  lost.**
- **Switch the framework itself** (Claude → Codex) → this is the lossy one, and it's a real
  limit, not a bug: the two tools keep their conversation history in *incompatible formats*, so
  a Codex session literally cannot read a Claude transcript. The best I can do is carry over the
  recent history + your memory and continue from there. The key promise: **I say that out loud**
  ("switching to Codex — the full transcript can't follow across tools, so I'm carrying recent
  history and memory") instead of pretending the switch was seamless.

That honesty is the whole point of the matrix. You always know whether a switch was free or
whether it cost some deep history.

## How it plays with the Fable escalation you just turned on

Earlier today you armed automatic Fable-5 escalation (the system bumps to the stronger model for
spec design and heavy build work). Per your correction: **pinning a model to a topic does NOT turn
that off.** There are two separate layers:

- **The topic's everyday model** (what normal back-and-forth uses) — this is what a pin sets.
- **The heavy-work mandate** (spec design / building → Fable) — this *keeps firing* even on a
  pinned topic, by default.

So if you pin a topic to Opus, normal chat uses Opus, but a spec-converge or a build in that topic
still jumps to Fable. The mandate only steps aside if you *explicitly* say "use Opus even for the
heavy stuff here" / "don't escalate this topic." Pinning an everyday model never silently weakens
the heavy-work mandate.

## Works on Slack too

Everything here — pinning, the who-changed-this protections, the swap notices — runs through the
same platform layer, so it works on Slack exactly like Telegram. A "topic" just becomes a Slack
channel/thread instead of a Telegram topic. (On the protections, honestly: someone you haven't
authorized at all can never change settings; for people you HAVE authorized, every change is
recorded with who made it and announced in the topic, so a change you didn't make is always visible
— and undoable with one word.)

## Safety, so this can't bite you

- A profile change is only ever a **routing** decision — it picks what runs. It can **never block
  a message or a tool call**. If any piece of this breaks, the worst case is "the topic keeps its
  current settings," which is just today's behavior.
- Pinning a framework that isn't installed, or a Claude model on a Codex topic, is **refused with
  a clear reason** — never a crash.
- Rapidly toggling settings won't thrash your sessions — changes coalesce and at most one respawn
  fires, inside the existing rate guard.
- It ships **off for everyone else, on for me** (the dev agent), behind a flag, with a dry-run
  mode that logs what the new machinery *would* do before it takes over. One honest nuance: the
  existing framework-switch command (`/route`) keeps working everywhere exactly as it does today —
  dry-run never turns it off. Instead, while dry-run is on, the new switching machinery watches
  that real traffic from the sidelines and logs the decisions it would have made, so we can check
  its judgment against reality before handing it the controls.

## The five forks — all decided (here's what I chose and why)

Per your standing directive (decisions at this level are mine; you read the result and override if
you disagree), I made these calls. One was already yours.

1. **Local-model bindings — keeping them separate this release.** If a topic has a local model
   pinned, that wins, and I'll refuse a cloud-model pin until you clear it. Merging two working
   systems mid-build couples their risks for no visible gain; I'll fold them together once this is
   proven, and that follow-up is tracked, not just remembered.

2. **Heavy-work escalation — YOUR call, already settled:** pinning an everyday model does *not*
   disable the Fable heavy-work mandate; it only steps aside if you explicitly ask. Baked in. ✅

3. **Codex "no context lost" swaps — building the missing piece now.** Changing model/thinking on a
   Claude topic keeps the whole conversation; for Codex that needs its session id captured, which
   we don't save today. I'm building that capture as part of this work so BOTH frameworks are
   zero-loss from day one — shipping with "Codex topics lose recent context (but I'll tell you)"
   would make the feature's first impression on Codex a real loss.

4. **Thinking levels — five** (off / low / medium / high / max). Codex natively has four and Claude
   maps cleanly to budgets; on/off would throw away control the tools already have and force a
   breaking change later.

5. **Switching framework mid-task — wait until idle, with a "switch now" override.** If a topic is
   mid-build, I won't kill its work for a settings change; the switch applies at the next idle
   moment — unless you say "switch now," which is always your right (I'll state what gets
   interrupted first).

If any of these four calls looks wrong to you, say so and I'll re-run the affected sections.
Nothing gets built until you approve the spec.
