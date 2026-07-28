# THREADLINE OPEN-THIS LLM NAMING — plain-English overview

**What problem we're fixing.** Last night I made "open this" reliable — say it in the Threadline topic and a topic gets created and bound. But what you got was a topic with:

1. A bad name — just the first 5 words of whatever the other agent said ("Hey echo quick check on"), not what the conversation is actually *about*.
2. An empty room — the only message in the new topic was the generic "🧵 This conversation is now tied to this topic" tie-marker, with zero context about who you're talking to or what's going on.

That's the opposite of what "open this" is supposed to do — you opened it because you wanted a *workable* topic, not an unlabelled empty one.

**What I'm building.** Two strictly additive improvements, on the same deterministic "open this" path:

1. **An LLM names the topic** from the actual conversation (what it's about — not the first words). Short, scannable, human-readable.
2. **An LLM writes a one-paragraph orientation summary** as the first message in the new topic — who the other agent is, what the conversation is about, where it currently stands. So when you walk in, you're already oriented.

Both use the existing intelligence provider through the shared LLM queue, so cost and rate-limiting are already governed.

**What stays the same.** Everything from PR #399. "Open this" is still deterministic — the system catches it before any conversational me ever sees it. "Tie this to &lt;topic&gt;" still uses the topic name you picked, unchanged. The deterministic intercept itself isn't touched.

**Safety: this NEVER breaks "open this".** There are three levels, best-first:
1. **LLM brief** (best) — a smart name + a written summary.
2. **Templated brief** (if the LLM can't run — timed out, daily cap hit, etc.) — a plain auto-built note: who you're talking to, how many messages, last activity, and the latest line. No model needed, instant, always works.
3. **Bare marker** (only when there's literally no conversation behind the entry yet) — the old "tied to this topic" note.

So you ALWAYS land in a topic with *some* real context now — never the empty room you saw. The LLM just makes it nicer when it's available; it's a *generator*, never a gate, so "open this" stays as reliable as last night.

One review fix worth calling out: I'd originally put the LLM naming on a low-priority lane — which meant if you pinged me somewhere else at the same moment, the naming would get bumped and you'd silently get the worse name. My reviewer caught it; it now runs on the priority lane, since you're literally standing there waiting for the topic to appear.

**Privacy.** Both fields (name and summary) get scrubbed for credential patterns before going to Telegram, same scrubber that already guards the slug name. A cold relay message that contains a token can't leak into your chat-list-visible topic name OR into the first message. Length caps stay (40 chars for the name, ~600 chars for the summary).

**Cost.** One LLM call per "open this" (the call returns both the name and the summary together — cheaper than two). Bounded inputs (last 10 messages, each capped). The daily LLM spend cap already enforces a hard ceiling — if you hit it, "open this" keeps working, just with the templated brief instead. Estimated ~1 cent per call, and "open this" is a handful-of-times-a-day action, so it's a rounding error.

**How I'll prove it works.** Same way as the last three:
- Unit tests on the new module (LLM-success, every fallback cause, scrubbing).
- Integration tests on `POST /threadline/hub/bind` end-to-end (happy path renames + summarizes; failure paths fall back).
- Test-as-self on live Codey — deploy the build, fire a real "open this" at his hub, watch a properly-named topic appear with a real summary inside, then restore Codey.
- Independent code review.
- Then merge.

**What I need from you.** Approve the spec and I'll build it the same way as #390 / #392 / #399, then ping you when it's live.

**One real-world tune from testing:** when I tried this for real (against live Claude, then a live Codex agent), the naming/summary call takes about 8-10 seconds — the model's startup is the slow part. My first draft gave it only 3.5 seconds, which would've quietly fallen back to the plain template almost every time. So after "open this" the new topic now takes a few seconds to pop up named-and-summarized, rather than appearing instantly with a worse name. For a deliberate "open this" that's a fine trade, and if it ever runs long you still get the instant plain brief.

**Status:** CONVERGED (two review rounds, four reviewers) + TEST-AS-SELF PASSED on live Codey (real Codex LLM named a topic "Mentor ledger dedup strategy" + wrote its summary). Shipped.
