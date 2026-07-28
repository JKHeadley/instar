# Unreleased

## What Changed

"Open this" in the Threadline hub is now a deterministic, structural action instead of something the agent has to interpret (CMT-529). Previously the agent could — and did — ramble a reply instead of creating a topic.

- **Structural intercept.** When a message in the Threadline hub topic is exactly "open this" / "tie this to &lt;topic&gt;", the system catches it at the one inbound seam BOTH message paths converge on (`telegram.onTopicMessage`) and binds the conversation to a topic before any agent interprets it. Ordinary hub chat falls through to the agent unchanged. FAIL-OPEN.
- **Bare "open this" auto-picks the most-recent** unbound conversation (the one you're looking at) instead of asking "which one?". The legacy-state ordering bug that made "most recent" unreliable is fixed (migrated hub entries now preserve their original order instead of all sharing one timestamp).
- **Readable topic names.** A newly-opened topic is named from what the conversation is about (capped, charset-scrubbed, and a safe fallback if the content looks like a secret) instead of a cryptic `peer · threadId`.
- The `POST /threadline/hub/bind` API is unchanged (it still returns 409 on ambiguity for scripted callers); the route and the intercept now share one `bindHubConversation` helper.

## What to Tell Your User

When you're looking at the Threadline topic and say "open this", I now reliably spin up a topic for that conversation — no more rambling, no judgment call on my end. It opens the one you're looking at and names it after what it's about. You can also say "tie this to &lt;one of my topics&gt;" to file it into an existing topic.

## Summary of New Capabilities

- Deterministic "open this" / "tie this to X" hub commands (intercepted structurally, both inbound paths).
- Auto-pick most-recent-unbound on bare "open this"; readable, scrubbed topic names.
- Shared `bindHubConversation` helper behind both the intercept and the API route.
- Legacy hub-state ordering fix so "most recent" is trustworthy.

## Evidence

- Verified against v1.3.0; design converged by two reviewers — the decisive catch was the dual-path trap (intercept must sit at `onTopicMessage`, the convergence both lifeline-forward and server-polling reach, not just `/internal/telegram-forward` where it'd be dead code for polling agents). Auto-pick, no-double-post, and topic-name privacy also folded in.
- 3-tier tests: unit for `parseHubCommand` (both sides of the boundary), `bindHubConversation` (open/tie/404/409/autoPick/readable-name), and the legacy-ordering fix; integration parity for `POST /threadline/hub/bind`; full threadline suite green (1569 unit/integration + 329 e2e, zero regressions). Typecheck + build clean.
- Independent second-pass review of the diff; live test-as-self on Codey (type "open this" into the hub → a readable-named topic is created + bound, no ramble).
