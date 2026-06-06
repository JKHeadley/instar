# Pi Harness Integration — ELI16 Overview

## What this is

We taught instar to drive a fourth "worker": **pi**, a minimal open-source
coding agent (the engine inside OpenClaw, ~60k GitHub stars). Instar is the
manager — memory, schedules, messaging, safety. Claude Code, Codex, and
Gemini CLI are the workers who actually type. Pi is now the fourth worker —
and the first one that comes with a **data cable** instead of a screen we
have to scrape: its RPC mode is a clean structured protocol (send a task,
stream the events back, steer it mid-task, resume yesterday's session).

## What actually changed

1. **'pi-cli' is a real framework value everywhere** — topics, config,
   per-component routing, monitoring, session spawn, resume. The compiler
   chased every dispatch table for us.
2. **Pi sessions run in tmux like everything else**, so the dashboard
   streaming and direct typing work IDENTICALLY — verified by an integration
   test that injects a prompt and watches the tool run in the pane.
3. **A provider adapter with the data cable** — one-shot calls (with token
   counts AND cost coming back) plus the full RPC session primitive
   (prompt / mid-stream steer / abort), normalized to instar's canonical
   event vocabulary.
4. **The subscription guard, in CODE**: routing pi at an Anthropic/Claude
   model throws an error by default. Why: Anthropic only counts Claude Code
   itself against your plan — Claude through pi bills per token as extra
   usage, real money. The override is a single explicit config line that
   gets audit-logged every time it's used. No env var, no per-call bypass.
5. **Ships completely dark.** Nothing registers, nothing changes, unless an
   agent's config explicitly lists 'pi-cli' in enabledFrameworks AND the pi
   binary is installed. Existing agents are byte-for-byte unaffected.

## How we know it works

Everything was verified against the REAL pi binary (v0.78.1) using a
hermetic mock LLM provider we built — zero credentials, zero spend, runs in
CI. The full agent loop (prompt → streamed tool call → real bash execution →
result → final text) passes through both faces: the terminal UI under tmux
and the RPC cable. The stuck-input detector was pinned against actual
captured terminal bytes, not guesses. Three test tiers: 37 unit tests, 5
real-binary integration tests, 5 end-to-end lifecycle tests including the
"feature is alive" registry check and the dark-default check.

## What could go wrong (and why it's contained)

The riskiest part would be touching the existing frameworks — which is why
the change is additive at every layer: new union member, new builder, new
adapter directory, new boot registration that no-ops unless opted in. The
one shared file with behavior change (the stuck-marker detector) only adds a
new detection branch that requires BOTH the injected marker AND pi's
double-rule input-box shape, so it cannot false-fire on Claude/Codex/Gemini
panes — and the existing prompt-char tests still pass unchanged.

## CI-fix note

After the first commit, CI flagged the usual paperwork for a new framework:
three old tests that listed the three existing frameworks by hand (we added
pi to each), a "no silent failures" counter that needed us to label one
intentional, loudly-logged fallback as OK, and a release-notes format rule
that wanted a one-line capability summary. All cosmetic/structural — the
feature behaves identically.
