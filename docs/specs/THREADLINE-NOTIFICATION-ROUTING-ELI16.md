# Threadline notification routing — the plain-English version

## What's wrong

Two things you flagged:

1. **Topic spam.** Every time something happened with an agent-to-agent conversation — an agent loop got stopped, a spawn hiccup, a delivery failure — the system created a brand-new Telegram topic just to announce it. That's why your chat list filled up with a wall of one-off "Threadline conversation loop wound down" / "Spawn-storm" / "codey can't spawn" topics. The cause: those notices get filed into the general "attention list," and the attention list gives every single item its own topic by design.

2. **"Open this" did nothing useful.** The "Threadline" topic in your list is meant to be a shared inbox for agent conversations that aren't tied to one of our existing topics. It even says "say 'open this' to engage" — but nothing was actually wired to that. So when you said "open this," I just replied in that same topic instead of pulling the conversation into its own space.

## What I'm building

**One rule for where agent-conversation notices go — never a new throwaway topic:**

- If a conversation is already tied to one of our topics → its real replies show up there (that's the fix we shipped last round; it already works).
- If it's not tied to anything → a quiet note lands in the single "Threadline" topic. That's it. No new topic per event.
- Low-value housekeeping ("I stopped an agent that was looping") never clutters the topic we're actually working in — it stays in the Threadline topic, quietly. (Your call #1.)

**The Threadline topic stays calm and silent.** Agent-to-agent chatter doesn't buzz you and isn't framed as "waiting" — because it's not your job by default; two agents are just talking. You glance at that topic when you're curious. The only thing that ever breaks the silence is when one of those conversations actually produces a real question or decision aimed at *you* — that surfaces normally, like any of our own messages. (Your call #2.)

**"Open this" finally works.** When you do peek at the Threadline topic and decide a conversation is worth its own space, you say "open this" and I spin up a fresh topic and tie the conversation to it — so everything from then on flows there. Or you say "tie this to <one of my existing topics>" and I bind it to that one instead. After that, that conversation's updates follow the first rule above and land in its new home.

## How I'll make sure it's right (no loose ends)

I'm reusing the piece that already manages the Threadline topic instead of adding a new moving part. The reviewers caught a handful of real gaps I'm closing in the build: the attention list needs a way to know which conversation a notice belongs to; one opt-in feature (mirroring whole conversations into their own topics) gets explicitly left alone since you turned it on deliberately; "open this" must not accidentally reuse the wrong topic or get blocked by a safety check; and I'll teach every agent (via the standard onboarding doc) how "open this" works so it's not just my private knowledge.

Then the usual: build it in isolation, write tests for every branch, deploy it onto the live Codey agent and actually watch a real agent conversation land quietly in the Threadline topic (not a new one) and "open this" promote it into its own topic — then restore Codey and merge. Same playbook as the reply-surfacing fix that's already live.

## What I need from you

A thumbs-up on this plan. Both your calls (#1 keep housekeeping out of our working topics, #2 keep the Threadline topic silent) are baked in. After your ok I build it end-to-end and report back when it's live — no check-ins in between.

---

_Status: approved 2026-05-25 (Justin, topic 12304); implemented in this PR with 3-tier tests + a concurring second-pass review. Both decisions baked in: housekeeping stays out of working topics, and the Threadline hub stays silent (no "waiting" framing)._
