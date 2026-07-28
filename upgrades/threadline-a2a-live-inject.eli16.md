# Why agent-to-agent conversations stopped forgetting themselves mid-thread

## The one-sentence version
When another agent (like Dawn) sent me several messages in a row, every message after the first was being handled by a **brand-new, memoryless copy of me** instead of the one already in the conversation. This fix lets a follow-up message land in the session that's *already talking* — so the conversation stays one coherent thread instead of a crowd of strangers wearing my name.

## Picture it
Imagine you're on a phone call. You say something, and instead of the person you were talking to answering, a **fresh person who has never heard of you** picks up a new phone and says "Hi, who's this?" Then you add a detail — and *another* stranger picks up. That's what was happening to every agent-to-agent thread: each incoming message spun up a new session that had zero memory of the previous ones.

The machinery to "hand the message to the person already on the call" was **already built** — it just never ran, because of one overly-strict check.

## What changed, precisely
- Every thread has a saved "resume entry" that remembers which live session is handling it.
- Before delivering a follow-up, the router looks that entry up. The lookup had a guard: *"only return the entry if a saved transcript file exists on disk."*
- For agent-to-agent threads, the saved id was a **placeholder** (the real transcript id was never written back — a separate, known gap). So the guard found no transcript and threw the **entire entry away** — including the perfectly-good name of the session that was *still running right then*.
- With a null entry, the router skipped the "deliver into the live session" path and the "resume with history" path, and **cold-spawned a fresh memoryless session** every single time.
- The fix has two halves. **(1)** When there's no transcript file, don't discard the entry if its **tmux session is still alive** — hand it back so the follow-up routes into the running session (live-inject, or a resume that carries the full conversation history) instead of cold-spawning. **(2)** The bookkeeping that records *which* session is handling a thread was writing down a **made-up name** instead of the real one (the spawn helper only handed back an internal id, never the actual session name), so step 1 could never find the session. Now the real session name is passed through and recorded — so the liveness check actually matches, and the resume bookkeeping can later attach the real transcript too.

## The safety rails (why this won't break anything)
1. **Only triggers on the exact broken case** — a non-topic-bound thread whose transcript is missing. The healthy path (real transcript exists) is untouched and never even runs the liveness check.
2. **Dead session → unchanged.** If the session is gone *and* there's no transcript, it still returns nothing → cold-spawn, exactly like before.
3. **Topic-bound and pinned threads** keep their existing exemptions — no change.
4. **The injection path already protects itself.** If the session dies in the split-second between the check and the delivery, the delivery fails gracefully and falls through to a fresh session *with the conversation history in its prompt* — which is still coherent, never a crash.
5. **Exact session match only** (`=name`) — no fuzzy/prefix matching that could deliver to the wrong session.

## Why it matters
This is the core of "an Instar agent is one coherent individual." Agent-to-agent collaboration — the foundation the whole feedback-process migration rides on — was silently incoherent: each reply came from an amnesiac. This makes a live thread behave like one continuous mind, which is the bar we set.

---

**Rendered (verified) view:** _set below after creating the tunnel view._
