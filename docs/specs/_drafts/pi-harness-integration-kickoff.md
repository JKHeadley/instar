# Pi Harness Integration — Kickoff / Requirements Capture

> Status: kickoff draft (requirements capture for the `pi-harness-integration`
> project). Research session: 2026-06-05/06, topic 20390. Approved direction by
> Justin 2026-06-06 ("Lets make this an official initiative/project and start
> scoping it out!"). Tracked follow-through: CMT-1108.

## What pi is

**pi** is a minimal coding-agent harness by Mario Zechner (badlogic, libGDX
creator), acquired by Earendil Works in April 2026 (Mario joined; open-core:
MIT core, Fair-Source coordination layers). ~60k GitHub stars, 2,100+
community packages, powers OpenClaw, endorsed by Armin Ronacher.
Repo: `badlogic/pi-mono` → `earendil-works/pi`; npm scope
`@earendil-works/pi-*`; docs at `pi.dev/docs/latest`.

Architecture (four packages):

- **pi-ai** — unified multi-provider LLM API (Anthropic, OpenAI, Google, xAI,
  Groq, Cerebras, OpenRouter, self-hosted/OpenAI-compatible; ~25 providers),
  streaming, TypeBox tool schemas, cross-provider mid-session handoff, token +
  cost tracking, auto-generated model registry.
- **pi-agent-core** — minimal agent loop (tool exec, validation, event
  streaming, message queuing).
- **pi-coding-agent** — interactive CLI **plus** `--mode rpc` (JSONL over
  stdin/stdout) **plus** a Node SDK (`createAgentSession`/`AgentSession`).
- **pi-tui** — terminal UI lib (differential rendering).

Philosophy: 4 tools (read/write/edit/bash), ~1k-token system prompt, no MCP,
no subagents, NO permission system (containerize instead), full context
observability.

## Why Instar cares (the deltas)

1. **RPC mode is the interface our tmux layer hand-reconstructs.** Structured
   JSONL: `prompt`, `steer` (mid-stream), `follow_up`, session
   persistence/resume, structured event stream — vs pane-scraping +
   completion-detection heuristics + per-CLI quirks (Gemini auto-submit box,
   codex wedges). A pi adapter would be the cleanest framework integration we
   have and a reference shape for the interactive-pool work.
2. **TypeScript SDK embeds in-process** — relevant to per-component framework
   routing and internal LLM calls.
3. **Subscription OAuth** — ChatGPT Plus/Pro (Codex; officially endorsed by
   OpenAI) and GitHub Copilot (NEW leverage for us). ⚠ Claude Pro/Max via pi
   bills as per-token **extra usage**, NOT plan limits — Claude Code remains
   the only plan-limits path for Claude.
4. **Complementary, not competitive** — pi deliberately excludes everything
   Instar is (persistence, scheduling, messaging, multi-user, gates,
   monitoring). Earendil monetizes coordination layers (adjacent — watch).

## Hard constraints (Justin, 2026-06-06, topic 20390)

- **Additive only — never forfeit subscription leverage.** Every framework we
  support today (Claude Code, Codex, Gemini CLI) is driven through the user's
  subscriptions; pi enters as one more adapter next to them, never instead.
  Claude work stays on Claude Code (plan limits). A routing policy guard must
  make Claude-via-pi structurally non-selectable by default.
- **Dashboard parity.** Session streaming + direct access must not regress:
  adapter v1 runs pi's interactive TUI in tmux (identical dashboard
  behavior); the RPC face starts with internal background work; an
  event-stream dashboard renderer is an optional later upgrade, never a
  replacement.
- **Sequencing.** Build rounds land AFTER the June-15 interactive-only /
  subscription-only work ships (CMT-1105 / topic 9984). Scoping + hands-on
  evaluation may proceed now.

## Justin's stated goals

- Efficiency ("really hoping this can help us be more efficient").
- **Multiple frameworks for a single agent** — e.g. main work on Claude Code,
  sentinels through Codex. NOTE: per-component framework routing
  (`sessions.componentFrameworks`, `GET /intelligence/routing`) already ships
  this for claude-code/codex-cli; this project extends the routing surface
  with pi as a target and widens the provider set (Copilot subscription,
  multi-provider fallback) rather than starting from zero.

## Risks

- Startup-owned (Earendil) with adjacent monetization; MIT core mitigates
  (pin/fork). Use at the edge (one adapter among several), never as the
  foundation.
- Fast-moving project — pin versions; supply-chain posture upstream is good
  (exact pins, shrinkwrap, audit CI).
- No permission system in pi — Instar's gate layer (external-operation-gate,
  dangerous-command-guard, SafeGit/SafeFs) must wrap pi sessions like any
  other framework; containerization optional later.
- Claims to verify hands-on before the master spec freezes: subscription OAuth
  flows actually work as documented (Codex, Copilot), Claude extra-usage
  billing reality, RPC session resume fidelity, TUI-in-tmux behavior under our
  injector.

## Sources

- mariozechner.at/posts/2025-11-30-pi-coding-agent/ (design philosophy)
- github.com/badlogic/pi-mono — docs: rpc.md, sdk.md, providers.md, sessions.md
- mariozechner.at/posts/2026-04-08-ive-sold-out/ (Earendil acquisition)
- syntax.fm/show/976 (Pi w/ Armin Ronacher & Mario Zechner)
- lucumr.pocoo.org/2026/1/31/pi/ (Armin Ronacher)
- Video that triggered the research: youtu.be/FJxgz5pN4wU ("Pi Agent explained
  in 6min", Caleb Writes Code, 2026-06-03)
