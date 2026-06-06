---
bump: minor
---

## What Changed

instar gained a fourth agentic framework: **pi-cli** (the pi coding agent,
`@earendil-works/pi-coding-agent` — the minimal harness powering OpenClaw).
Ships completely DARK: nothing registers and no behavior changes unless an
agent's config explicitly lists `'pi-cli'` in `enabledFrameworks` AND the
`pi` binary is installed. What opting in gets you: (1) pi topic sessions in
tmux with IDENTICAL dashboard streaming/typing (TUI-in-tmux v1, launch
builders + stuck-input detection pinned against real captured panes);
(2) a provider-substrate adapter with pi's NATIVE structured RPC channel
(prompt / mid-stream steer / abort, strict-LF JSONL, canonical event
normalization) plus one-shot completions that report tokens AND cost;
(3) `sessions.componentFrameworks` can route internal components (sentinels,
gates) to `'pi-cli'` — e.g. background chatter onto a Codex/Copilot
subscription via pi; (4) a STRUCTURAL subscription guard: Anthropic/Claude-
routed pi model patterns are DENIED by default at every call-construction
path (Claude-via-pi bills as per-token extra usage, not plan limits — so it
can never be selected silently; file-config-only override, audit-logged).
Verified hands-on against the real binary (pi 0.78.1) with a hermetic mock
provider — zero credentials, all three test tiers.

## What to Tell Your User

Nothing proactively — this ships dark and changes nothing by default. If
your user asks about pi/OpenClaw support or about spreading background LLM
load onto other subscriptions: instar can now drive the pi coding agent as
an additional framework (experimental, opt-in), with a built-in guard that
prevents accidental Anthropic extra-usage billing.

user_announcement:
  - audience: agent-only
    maturity: experimental
    text: "pi-cli is available as an additive fourth framework (opt-in via enabledFrameworks; experimental)."
