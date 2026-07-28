# Presence ghost-text strip - ELI16

> The one-line version: the presence proxy no longer mistakes the suggestion text inside an empty codex input box for something the agent is actually doing.

## The problem

When you ask "what is my agent doing?", the presence proxy captures the agent's terminal pane and has a small LLM summarize it. Codex's input box shows rotating placeholder suggestions when it's empty — dim text like "Write tests for @filename" or "Implement {feature}" that nobody typed. The pane capture strips the colors, so by the time the summarizer sees it, the ghost text looks exactly like a real typed command.

Last night that produced a confabulated status: the proxy reported a session was "preparing to write tests for the referenced file" while the session was completely IDLE at a fresh prompt — it was reading the input box's placeholder. The operator acted on a status that described nothing real (ledger finding d0fd5483, topic 2271 at 00:35:28Z).

## What changed

The pane sanitizer — the single chokepoint every presence snapshot passes through before reaching the summarizer — now strips input-box ghost lines. A line is treated as ghost text only when it is an input-box line (starts with the prompt chevron) AND its content is recognizably template text: it contains a `{placeholder}` or `@filename` token, or exactly matches the known codex suggestion set.

## What is deliberately KEPT

- A real typed-but-unsubmitted command in the input box stays visible — that is genuine pane state.
- Prose in normal output that happens to mention `@filename` or `{tokens}` stays — only input-box lines are candidates.
- Agent output lines that begin with a quote-style chevron mid-report stay (they don't match the template test).

The rule: only text the user never wrote gets stripped.

## Evidence

The unit fixture is the REAL incident pane capture, asserted both ways: the ghost line disappears, the surrounding context survives. All nine existing presence-proxy suites stay green (96 tests).
