# Door + model controls: readable names and a phone layout that fits — Plain-English Overview

> The one-line version: the door and model controls in the Sessions tab now show model names a person can read, fit on a phone without wrapping, and say plainly what to do when a switch is refused.

## The problem in one breath

The door and model controls shipped in 1.3.1311 and they work, but a walkthrough at phone size on 2026-10-01 showed they look rough. Model names appear as raw ids such as "claude-opus-5-5". The same model can appear twice in a list. On a phone the session screen's top bar breaks the model name and the "Door + model" button across three lines each and cuts the topic name down to a few letters. And when a switch is refused on a brand-new topic, the message talks about a "bound operator", which tells the user nothing about what to do next.

## What already exists

- **Three controls in the Sessions tab** — choose a door and model when creating a topic, switch them on a running topic, and set a default for topics made from the dashboard. All three work and are unchanged in behavior.
- **A list of doors and models from the server** — the dashboard only offers what this machine can really run. Unchanged.
- **The ownership rule for switching** — a topic made from the dashboard only learns who its operator is from the operator's first message in it. Until then a switch is refused. The rule is unchanged; only its wording changes.

## What this adds

Readable names everywhere a model is shown. "claude-opus-5-5" is shown as "Opus 5.5", "gpt-5.6-sol" as "GPT-5.6 Sol". The raw id is still what gets sent to the server, and it is still visible as a tooltip on the badge. A model id the dashboard does not recognize is shown exactly as it is, so a brand-new model is never hidden or mislabeled.

- A model that is listed twice (once plain, once with a date on the end) is shown once. If the dated one is the topic's current model it stays in the list.
- The short aliases are labeled "Opus (latest)" and so on in the lists, so it is clear they follow whatever is newest.
- In the Sessions list a badge moves to the next line as a whole instead of breaking in the middle of a word.
- On a phone, the session screen's top bar stays on one line: a compact model badge, a "Door + model" button that does not break, and more room for the topic name. The small "interactive" tag is hidden at phone width to make that room.
- The refusal message now reads: "Send one message in this topic first, then switch. The topic only learns who its operator is from that first message."

## The new pieces

- **A name formatter in the dashboard page** — turns a model id into a display name. It only affects what is drawn on screen. It is not allowed to change which model is chosen or sent.
- **A list filter in the dashboard page** — drops a dated duplicate from the dropdown. It never drops the model a topic is currently on.

## The safeguards

**Nothing about choosing a model changes.** The value sent to the server is the same raw id as before. The server's own check of what is allowed is untouched, so the dashboard cannot offer or send anything new.

**An unknown model stays visible.** If the formatter does not recognize an id it shows the id unchanged. The color class on a badge is taken from a fixed set of four family names, so nothing from a model id can end up in the page's markup.

**The ownership rule is not loosened.** Only the sentence shown to the user changed. The refusal, its reason code and its audit record are the same.

## What ships when

One small change, in one release. No setting, no migration, nothing for an existing agent to do: the dashboard page and the message text update with the release.

## What you actually need to decide

Nothing. This is display polish on a feature already approved and shipped; it goes out with the next release unless you say to hold it.
