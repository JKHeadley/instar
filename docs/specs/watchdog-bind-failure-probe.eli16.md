# Watchdog bind-failure probe — plain-English overview

> **One-line shape:** the fleet watchdog now notices when an agent's *lifeline* is alive but its *server* is locked out of its port. That exact failure mode kept AI Guy offline for two days without alerting anyone — fixed.

## What broke this week

AI Guy went down on Sunday and Justin didn't hear about it until Tuesday.

The why: two of your launchd entries were configured for the same port — AI Guy and a leftover "codex-server-smoke" smoke-test fixture. When the machine booted, the smoke-test bound the port first. AI Guy's lifeline came up fine and looked perfectly healthy from launchd's perspective. But its actual SERVER couldn't bind the port. Inside the lifeline, the supervisor tried to spawn the server 4,163 times over two days. Each attempt failed silently. The supervisor explicitly logged "Suppressing duplicate server down notification (4163 suppressed this outage)" — it was silencing its own alerts because the failure was repeating identically.

The fleet watchdog I shipped two days earlier had no signal for this. It only catches the case where launchd itself reports a crash-loop. AI Guy's lifeline was happy. The failure was one layer down, invisible to the supervisor.

## What this change does

The watchdog gets a new probe. For every agent on the machine, it now asks one extra question: *is the server I expect on this port actually mine?*

How it asks:
1. Reads the agent's configured port from its config file.
2. Calls the agent's `/health` endpoint.
3. Reads the `project` field from the response.
4. If the response is missing OR if the project name belongs to a different agent — that's a bind-failure signal.

When the probe fires, the watchdog runs the same self-heal it already runs for crash-loops. If the heal can't fix it (because the conflicting party is a legitimately-running peer agent, which the watchdog has no authority to evict), the existing fail counter advances. After three consecutive failed cycles (~15 minutes), you get a plain-English Telegram message: *"AI Guy hasn't been able to start its server because another agent is using its port. My repair attempts haven't fixed it. Want me to dig in?"*

The message goes through the same tone gate that polices every other outbound message, so it's guaranteed jargon-free and ends in a yes/no question you can answer with one word.

## Why this is layered on top of the existing system, not a rewrite

The longer-term home for fleet-health intelligence is the v3 Self-Healing Remediator (the spec you approved May 13). The Remediator has a proper probe registry, a clustering engine, and learned recovery playbooks. When that ships, this probe becomes one entry in its registry and the watchdog's hand-rolled escalation becomes a runbook. Until then, this PR closes the AI-Guy-stuck-behind-codex outage class with minimum plumbing.

The supervisor inside each lifeline ALSO has bind-failure detection (PR #111 from April). That layer didn't catch this incident because the supervisor's own alerts were being suppressed as duplicates. The new probe gives us a second, independent eye watching the same surface from outside the lifeline — exactly the redundancy you'd want for the alert layer.

## What's NOT in scope

- Auto-resolving port conflicts. Deciding which of two agents gets a contested port is a configuration decision; the watchdog detects and reports, but doesn't pick.
- Modifying config files. The watchdog stays strictly read-only on agent state.
- Single-agent machines. If only ONE agent is on the machine and it's the one having problems, there's no peer to relay through (same constraint as PR #245).

## What gets safer for every agent, not just AI Guy

- Any agent whose port gets stolen by another agent surfaces to you within ~15 minutes.
- Any agent whose server crashes in a way the lifeline keeps trying to silently restart surfaces too.
- The watchdog's view of "healthy" now matches the user's view: not just "process is alive" but "the thing the user actually talks to is reachable."
