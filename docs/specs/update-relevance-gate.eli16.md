# Update-Relevance Gate — Plain-English Overview

> The one-line version: before any "here's what's new" message reaches the owner, a gate quietly asks "would a normal person actually care about this?" — and silently drops the ones that are really just internal plumbing.

## The problem in one breath

The agent sends the owner update messages in a dedicated "Agent Updates" chat. Too many of those messages talk about internal machinery the owner has never heard of — things like "Sibling Agent Server Control" or "apprenticeship cycle recording." To the owner they read like noise: "what is this even about?" A previous fix made those messages opt-in and honest about how finished a feature is, but it never checked whether the owner would *care* about the message at all.

## What already exists

- **The Agent Updates chat** — one dedicated place where the agent posts "I just shipped/updated/restarted" notes, instead of dumping them into whatever conversation the owner was last in.
- **The maturity-honesty layer (PR #698)** — update announcements are now opt-in and labeled Experimental / Preview / Stable, so nothing gets oversold as finished. But this only governs *tone and whether a change was flagged for the owner* — not whether the content is actually relevant or readable.
- **The tone gate** — an existing check on outbound messages that catches technical leakage (commands, file paths, jargon) before a message reaches the owner. It does not ask the "would the owner care?" question.

## What this adds

A single relevance gate sitting at the one doorway every update message must pass through on its way to the Agent Updates chat. There are two different code paths that post updates — the agent narrating its own work, and an automatic release-notes notifier — and both funnel through the same doorway. Putting the gate there means every update is covered without any code path having to "remember" to call it (the project's core "Structure over Willpower" principle).

For each candidate update the gate makes one of three calls:

- **Internal plumbing** → withheld entirely (the owner never sees it; it's still recorded).
- **Relevant but jargony** → rewritten into plain "here's what you can now do" language, and the plain version is sent.
- **Genuinely owner-facing news** → sent through unchanged.

## The new pieces

- **UpdateRelevanceGate** — a small LLM-backed judge. It only ever classifies a message; it cannot do anything else. It mirrors the existing tone gate: same shared intelligence provider, a fast/cheap model, and it treats the candidate text as untrusted (so a message can't "instruct" the judge). It never throws — if anything goes wrong it just lets the message through.

## The safeguards

**Prevents a real update from being lost.** The gate fails open: if the language model errors, times out, or returns something unparseable, the original message is delivered anyway. A hiccup in the judge can never swallow a genuinely important update.

**Prevents it from interfering with normal conversation.** The gate is a strict no-op anywhere except the Agent Updates chat. Every normal reply to the owner is byte-for-byte unchanged, because the gate returns immediately when the message isn't headed for the Updates chat.

**Prevents anything from vanishing without a trace.** Every decision — delivered, suppressed, or rewritten — is written to an audit log (`logs/update-relevance.jsonl`). A withheld update is still "learned" by the agent internally; only the owner-facing ping is held. And a suppressed message is reported as a success, not an error, so the sender never retries or escalates it.

**Prevents a surprise rollout.** It ships live only on the development agent (Echo) and stays dark on every other agent, with a simple off-switch in config. No fleet-wide config migration is required.

## What ships when

It ships as one change: the gate class, the wiring into the two update paths, the audit trail, full unit + integration + end-to-end tests, the owner-awareness note in the agent's CLAUDE.md, and the migration so existing agents learn about it on update. Live on Echo immediately; dark on the fleet until deliberately promoted.
