# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**"Open this" topics now arrive named + summarized.** When you promote a Threadline
conversation into its own topic ("open this" in the Threadline hub), the new topic used to
get a crude name (the first ~5 words of the cold message) and a single generic "tied to this
topic" marker — an unlabelled, empty room. Now an LLM names the topic from what the
conversation is actually about and writes a short orientation summary as the first message
(who the other agent is, what it's about, where it stands), so you walk in oriented.

This is strictly additive on top of the deterministic "open this" intercept. It NEVER fails
the bind: if the LLM can't run (timeout, daily spend cap, rate-limit, scrubbed output, or
the deps aren't wired in your build), "open this" degrades to a deterministic templated brief
(peer · message count · last activity · latest line) — and only falls back to the bare marker
when there's literally no conversation behind the entry yet. The LLM is a generator, never a
gate. The naming/summary call runs on the shared interactive LLM lane (you're waiting on it)
with a 3.5s ceiling, ~1 cent per call, governed by the existing daily spend cap.

Credential scrubbing uses value-pattern detection (actual `sk-…`/`xoxb-…`/`ghp_…`/key blocks),
not bare english words — so a legitimate technical topic ("token refresh triage", "API key
rotation") is named normally, while a pasted secret never lands in your chat-list title or the
first message.

## What to Tell Your User

Nothing to do — it's automatic. Next time you "open this" in the Threadline topic, the new
topic shows up with a real name and a short summary of the conversation inside it, instead of
an empty room. "Tie this to <existing topic>" is unchanged. (The topic takes a few seconds to
appear while the summary is generated; if the model is slow you still get an instant plain brief.)

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| "Open this" topics are LLM-named + summarized | In the Threadline hub topic, say "open this" — the new topic gets an LLM-generated name and a summary of the conversation as its first message. Automatic; no command or flag. |
| Always-contextful fallback | If the LLM can't run (timeout / daily cap / unwired), the new topic still gets a deterministic templated brief (peer · message count · last activity · latest line) instead of the old empty marker. The bind never fails on LLM trouble. |
