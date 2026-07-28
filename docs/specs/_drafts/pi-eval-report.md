# Pi Hands-On Evaluation Report (P0.1)

> Project: `pi-harness-integration` · Item P0.1 · Evaluated: 2026-06-06 (24h
> autonomous run, topic 20390) · pi version: **0.78.1** (`@earendil-works/pi-coding-agent`)
> Method: sandboxed install (`/tmp/pi-eval`, isolated `HOME`), hermetic mock
> OpenAI-completions provider (zero credentials, zero spend), tmux driving via
> the same primitives our session layer uses.

## Verdict

**Both integration faces work as documented.** No blocker found for either the
TUI-in-tmux adapter (P1) or the RPC client (P2). The hermetic-mock technique
used here is directly reusable as the CI fixture for all adapter tests.

## What was verified hands-on (all PASS)

### RPC face (`pi --mode rpc`, JSONL over stdin/stdout)

| Claim | Result |
|-------|--------|
| Starts + answers credential-free (`get_state`) | ✅ structured response incl. sessionId, steering/followUp modes, messageCount |
| Custom provider via `~/.pi/agent/models.json` | ✅ `openai-completions` mock at localhost picked up by `--provider mock --model mock-model` |
| Full agent loop | ✅ prompt → streamed tool-call → REAL `bash` execution in cwd → tool result returned to LLM → final text → `agent_end` (26 events) |
| Event stream | ✅ typed JSONL: `agent_start/turn_start/message_start/message_update(toolcall_delta,text_delta)/tool_execution_start|update|end/turn_end/agent_end` + `response` correlation by `id` |
| Mid-stream steering | ✅ `steer` accepted during streaming (`success:true`) and the steer message entered the conversation (verified in turn history) |
| Session persistence | ✅ JSONL session file written under `--session-dir` |
| Resume | ✅ `--continue` resumed the same sessionId with messageCount=5 carried over |

### TUI face (interactive `pi` inside tmux — the v1 adapter path)

| Claim | Result |
|-------|--------|
| Renders inside tmux | ✅ banner, input box, status line (cwd, ↑↓ tokens, context %, model name) |
| Standard injection works | ✅ `tmux send-keys "<text>"` + separate `Enter` submits FIRST TRY — no Gemini-style auto-submit box quirk |
| Tool execution visible in pane | ✅ `$ echo …` + output + `Took 0.0s` rendered — dashboard streaming will show real work |
| Completion detectable | ✅ idle state = input box redrawn + status line stable; token counters (`↑250 ↓30`) give progress signal |

### Wire format (captured from the mock — ground truth)

- System prompt: **2,494 chars (~624 tokens)** — matches the "~1k token" minimalism claim.
- Tools: exactly **4** (`read`, `bash`, `edit`, `write`), standard OpenAI function-calling schemas.
- Requests are plain OpenAI-completions with `stream:true`; usage chunks carried.

## Adapter-relevant caveats found

1. **tmux extended-keys**: pi warns `tmux extended-keys is off. Modified Enter
   keys may not work` — plain Enter works fine (verified), but the adapter
   should set `extended-keys on` for the pi session or document the
   degradation (Shift+Enter newline etc.).
2. **First-boot binary downloads**: pi fetches `fd` + `ripgrep` from GitHub on
   first run (403'd in the sandbox; degraded gracefully). Adapter should
   pre-warm once per machine or tolerate the 30s first-boot delay.
3. **zsh `=word` trap (ours, not pi's)**: unquoted `=session:` tmux targets
   get eaten by zsh's `=cmd` expansion when commands run through `sh -c`
   layers. Our adapter code paths quote these; eval scripts must too.
4. **Session files are per-cwd-keyed** (project sessions); `--session-dir`
   overrides location. The adapter should pin `--session-dir` into the agent
   home state dir for durability + reap-log coherence.

## NOT verified hands-on (documented honestly)

- **Subscription OAuth flows** (Codex/ChatGPT, Claude Pro/Max, GitHub
  Copilot): require interactive browser login; cannot be exercised headlessly
  in a sandbox. Docs state Codex usage is officially endorsed by OpenAI and
  Claude Pro/Max via third-party harness bills as **per-token extra usage,
  not plan limits** (consistent with Anthropic policy). The P2.2 subscription
  guard treats these as policy inputs, not assumptions: Claude-via-pi is
  blocked by default regardless.
- **Real-provider behavior differences** (Anthropic/OpenAI native APIs vs the
  openai-completions mock). Mitigation: the adapter is provider-agnostic by
  construction (pi owns provider quirks — that's the point of adopting it).

## Reusable artifacts produced

- `/tmp/pi-eval/mock-openai.mjs` — scripted-turn mock provider (tool-call turn
  + final-text turn + configurable stream delay). **This is the CI fixture
  design for every adapter test tier.**
- `/tmp/pi-eval/home/.pi/agent/models.json` — custom-provider config template.
- Captured request/event logs (`mock-requests.jsonl`, `rpc-events.jsonl`,
  `rpc-steer.jsonl`) for schema reference.

## Conclusion for P0.2 (master spec)

Proceed as scoped. v1 TUI-in-tmux adapter is LOW risk (standard send-keys
works; status line is scrapeable; extended-keys nit). RPC client is LOW risk
(protocol behaves exactly as documented; strict-LF framing note from docs
applies — do not use Node `readline`). The hermetic mock makes the whole
adapter testable in CI without credentials — Testing Integrity Standard
compliant by design.
