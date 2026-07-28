# ELI16 — Hub bind commands stop being decided by a regex

## What this is, in plain English

When you're in the special "Threadline hub" chat and you type **"open this"** or **"tie this to the
roadmap topic"**, the agent is supposed to grab that message, act on it (open the conversation into its
own topic, or bind it to an existing one), and NOT treat it as normal chat. Until now, the code decided
"is this a bind command?" with two hard-coded text patterns (regular expressions). If your message
matched the pattern, the code **ate the message before the agent ever saw it** and did the bind.

The problem: a regex can't tell a real command from ordinary talk. "should I open this?" is a question,
not a command. "open this in a new tab" is about a browser, not the hub. A pattern that's loose enough to
catch the real command is also loose enough to swallow a message you didn't mean as a command — and once
it's swallowed, it's gone. That's the worst possible failure for a chat surface: your words vanish.

## What already exists

- The **binder** (`bindHubConversation`) that actually does the open/tie — unchanged.
- A `POST /threadline/hub/bind` API route that binds without any text-matching — unchanged.
- The shared `IntelligenceProvider` (the one LLM pipe every gate already uses) with a spawn cap and a
  circuit breaker.
- A proven sibling that did this exact swap for a different command: the move-intent classifier
  (`MoveIntentClassifier`, PR #1367), which replaced a keyword verb-list that hijacked "keep the work on
  the laptop." This change copies that shape on purpose.

## What's new

A small LLM classifier, `HubIntentClassifier`. Instead of matching patterns, it READS your message plus a
few recent turns and decides, with a confidence score, whether you meant "open" or "tie" — or neither. If
it's a "tie," the model must pick the target topic from a **list of your real topics** (it literally
can't invent one, and we double-check the id it returns against that list in code). Everything else falls
through to the agent as normal chat.

The safety rule is the whole point: it **fails open**. If the LLM is down, times out, returns garbage,
picks a topic that isn't real, or isn't confident enough — the message is NOT swallowed; it passes
straight to the agent. A missed auto-bind is cheap (you just say it again, or the agent handles it). An
eaten message is the harm we're removing, so every uncertain case errs toward letting your message
through.

## How it rolls out (nothing changes for most agents yet)

It ships **dark on the fleet** and **dry-run first on a development agent**. Dark = off; the message just
reaches the agent like normal. Dry-run = the classifier runs and writes down what it WOULD have done
(`logs/hub-intent.jsonl`: "would-swallow" vs "pass"), but still doesn't swallow anything. Only after a
real accuracy benchmark passes does anyone flip the switch that lets it actually act. That's how we prove
it stopped eating messages before we trust it to.

## What you'd need to decide

Nothing right now — it's off on the fleet. The one real decision, later, is the graduation flip
(`dryRun:false`) on a dev agent, gated on the live discrimination benchmark (≥90% accuracy plus the two
canonical cases). Until then, this is invisible to users: the only behavior change on the fleet is that
the old regex auto-bind no longer fires, which is the safe direction — the hub API and the browsable hub
still work exactly as before.

## The sibling

There's a second conversion in the same family (#1, the "use codex here / set high thinking on this
topic" recognizer). It uses the identical pattern and ships as its own separate change; it's described in
the spec so the family reads as one story, but it isn't part of this change.
