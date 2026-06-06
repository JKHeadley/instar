<!-- bump: minor -->

## What Changed

instar gained a fourth agentic framework: **pi-cli** (the pi coding agent,
`@earendil-works/pi-coding-agent` — the minimal harness powering OpenClaw).
Ships completely DARK: nothing registers and no behavior changes unless an
agent's config explicitly lists `'pi-cli'` in `enabledFrameworks` AND the
`pi` binary is installed. Opting in gets: (1) pi topic sessions in tmux with
IDENTICAL dashboard streaming/typing (TUI-in-tmux v1; launch builders +
stuck-input detection pinned against real captured panes); (2) a
provider-substrate adapter with pi's NATIVE structured RPC channel (prompt /
mid-stream steer / abort, strict-LF JSONL, canonical event normalization)
plus one-shot completions reporting tokens AND cost; (3)
`sessions.componentFrameworks` can route internal components (sentinels,
gates) to `'pi-cli'` — e.g. background chatter onto a Codex/Copilot
subscription via pi; (4) a STRUCTURAL subscription guard: Anthropic/Claude-
routed pi model patterns are DENIED by default at every call-construction
path (Claude-via-pi bills as per-token extra usage, not plan limits — so it
can never be selected silently; file-config-only override, audit-logged).
Verified hands-on against the real binary (pi 0.78.1) with a hermetic mock
provider — zero credentials, all three test tiers.

## Summary of New Capabilities

- **pi-cli framework** (⚗️ experimental, opt-in via `enabledFrameworks`) — drive
  the pi coding agent as a fourth framework alongside claude-code / codex-cli /
  gemini-cli. Sessions run in tmux (dashboard streaming unchanged).
- **pi provider adapter** — `GET /providers/registry` lists `pi-cli` (one-shot
  completion + native RPC session + session-id + hard-kill) when enabled.
- **pi component routing** — `sessions.componentFrameworks` accepts `pi-cli`,
  so sentinels/gates can run on pi (onto a non-Claude subscription).
- **Subscription guard** — `piCli.allowAnthropicProviders` (default false):
  routing pi at an Anthropic/Claude model is denied unless explicitly opted in,
  and the opt-in is audit-logged with a cost warning.

## What to Tell Your User

Nothing proactively — this ships dark and changes nothing by default. If your
user asks about pi/OpenClaw support, or about spreading background LLM load
onto other subscriptions: instar can now drive the pi coding agent as an
additional framework (experimental, opt-in), with a built-in guard that
prevents accidental Anthropic extra-usage billing.
