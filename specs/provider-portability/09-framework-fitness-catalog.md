# Framework Fitness Catalog — v0.1

**Status:** Active, living document. **Adopted 2026-05-15** as part of Phase 5a (model+framework fitness research).

## What this is

A per-framework assessment of strengths, weaknesses, and best-fit task types. Frameworks are the wrappers we drive models through — Claude Code, Codex CLI, Anthropic Agent SDK, Aider, Cursor, etc. Two key insights from the research synthesis drove this catalog being separate from `08-model-fitness-catalog.md`:

1. **The framework matters independently of the model.** Same model produces different ceilings depending on which framework dispatches it. Per `tJB_8mfRgCo`, Opus 4.7's max-effort levels are ONLY exposed inside Claude Code, not via the API — so the choice of framework determines whether you can reach the model's full capability.

2. **Tool friction is the binding constraint.** Per `XlfumXPPrLY` (relaying Jeff Dean's GTC quote), an infinite-speed model still yields only 2-3x gain due to tool friction. Choosing the right framework matters at least as much as choosing the right model.

## What this is NOT

- NOT the same as adapter fitness. An adapter (e.g., our `openai-codex`) is one provider's binding to the Instar substrate. A framework is what the adapter wraps. Adapter quality is tracked elsewhere; this catalog assesses what each framework is good at intrinsically.
- NOT a feature inventory. The 51-primitive substrate in Phase 2 captures features. This catalog captures FITNESS — which tasks each framework excels at, where it fails, what surprises it produces.

## How to read

Same confidence markers as `08-model-fitness-catalog.md`: HIGH / MEDIUM / LOW (single-analyst) / PROVISIONAL.

---

## Anthropic frameworks

### Claude Code

**Provider.** Anthropic. CLI wrapper around Claude models with hooks, MCP, plan mode, ultra-review, scaffolding.

**Best fit.**
- `agentic-execution` involving code: only surface that exposes Opus 4.7's extra-high / max effort levels `[tJB_8mfRgCo confidence:LOW]`.
- `code-review` at depth: plan-mode + ultra-review subcommand recommended specifically for 4.7 `[tJB_8mfRgCo confidence:LOW]`.
- Long-running autonomous loops: this is what Instar's existing infrastructure is built on; empirically robust over 48+ hours of continuous operation `[Pavle Hurin test 3e7gmNPr5Vo confidence:LOW]`.
- The Karpathy loop (`edit→run→measure→keep/revert`): plan-mode + the ultra-review pattern map onto this primitive cleanly.

**Avoid for.**
- Token-tight budgets: plugin context tax — 50k tokens of plugin context loaded before the first message is reported as common `[5ztI_dbj6ek confidence:LOW]`. Paired with $42-burn anecdote `[tJB_8mfRgCo confidence:LOW]`.
- Workflows that depend on temperature / top_p / top_k / thinking_budget when running 4.7 — Claude Code can't bring those back; the model itself rejected them.

**Key characteristics.**
- Hook system with 10+ event kinds (SessionStart, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop, PreCompact, etc.) — the most developed hook surface among current frameworks.
- MCP tool registry with name-based matching.
- tmux-mediated REPL is what Instar's `anthropic-interactive-pool` adapter leverages for the subscription path.

**Confidence overall.** MEDIUM. Strong direct experience from Instar building against it.

---

### Anthropic Agent SDK

**Provider.** Anthropic. Programmatic SDK / `claude -p` headless path.

**Best fit.**
- Programmatic one-shot completions where structured output is part of the prompt design.
- The credit-pot economic path (Anthropic's $200/month Agent SDK credit pot, post 2026-06-15).

**Avoid for.**
- Workflows that need max effort levels (those are Claude Code-only per the Opus 4.7 entry).

**Research gap.** Nate B Jones transcripts emphasize Claude Code / Claude-for-Chrome / Co-Work over the raw SDK. No fitness data on the SDK directly `[synthesis-nate-b-jones.md §5 confidence:LOW]`. Phase 5d benchmarking should profile the SDK explicitly.

**Confidence overall.** PROVISIONAL.

---

### Claude for Chrome

**Provider.** Anthropic. Browser extension that drives Chrome with structured permissions.

**Best fit.**
- Repetitive web tasks the user wouldn't otherwise do: Carl Valoti got a $100 credit negotiated `[QT7W_uHjqWE confidence:LOW]`; Eric Schwartz organized ~900 loose documents in Drive `[QT7W_uHjqWE confidence:LOW]`.
- Schedulable recorded workflows — record-and-replay pattern with daily/weekly/monthly triggers `[QT7W_uHjqWE confidence:LOW]`.
- Tasks scoped to Gmail / Drive / Calendar: built-in knowledge of those platforms `[QT7W_uHjqWE confidence:LOW]`.

**Avoid for.**
- Time-sensitive tasks: "not fast… longer than it would take a human" `[QT7W_uHjqWE confidence:LOW]`.
- Large-batch extraction: "expand that watch list beyond a few people, coverage gets spotty" `[QT7W_uHjqWE confidence:LOW]`. Break into subtasks.
- Plans below Max/Team: "simpler your plan, the dumber the model" `[QT7W_uHjqWE confidence:LOW]`. Plan tier gates model intelligence on this surface.

**Key characteristics.**
- Group-tab permission model: can't see anything outside that group tab `[QT7W_uHjqWE confidence:LOW]`. Security-relevant.

**Confidence overall.** LOW. Single source, anecdotal validation.

---

### Co-Work / Claude desktop computer-use

**Provider.** Anthropic. Desktop computer-use agent (sometimes called "cocode" in transcripts).

**Best fit.**
- Desktop-scope automation where MCP cooperation isn't available — "computer-use breaks MCP coverage gaps" `[3e7gmNPr5Vo confidence:LOW]`.
- Long-horizon operation: 48-hour stability validated in the Pavle Hurin "bounce-house test" `[3e7gmNPr5Vo confidence:LOW]`.

**Confidence overall.** LOW.

---

### Dispatch

**Provider.** Anthropic (server-side).

**Best fit.**
- Server-side `/loop` scheduled tasks `[3e7gmNPr5Vo confidence:LOW]`.
- QR-paired parallel co-work spawn pattern `[3e7gmNPr5Vo confidence:LOW]`.

**Confidence overall.** LOW. Limited coverage.

---

### Claude Design

**Provider.** Anthropic.

**Best fit.**
- Eight specific design use cases, SVG-first, JSX components, Canva-integrated `[KlPxWaY91rE confidence:LOW]`.
- "Does in 30 minutes what your team does in a sprint" framing `[KlPxWaY91rE confidence:LOW]`.

**Constraints.**
- Max-tier required `[KlPxWaY91rE confidence:LOW]`.
- No Figma export `[KlPxWaY91rE confidence:LOW]`.

**Confidence overall.** LOW.

---

### Conway (leaked / unannounced enterprise)

**Provider.** Anthropic.

**Status.** Not shipped publicly. CNW.zip extension format layered on MCP `[ro5jpbi5uYc confidence:LOW]`.

**Strategic note.** "Intelligence-portability lock-in" `[ro5jpbi5uYc confidence:LOW]` — explicitly designed to make portability harder once installed. **Material implication for v1.0.0's portability claims.** Re-evaluate this catalog when Conway ships.

**Confidence overall.** PROVISIONAL.

---

## OpenAI frameworks

### Codex CLI

**Provider.** OpenAI.

**Best fit.**
- `code-generation` with computer-use: April 16 revamp shipped "background computer use, mid-70s on OSWorld, parallel agents, in-app browser, image gen, 90+ plugins" `[2d9ZmA-4QzU confidence:LOW]`.
- Subscription-economics agentic work: "OpenAI Codex bundles subscription"; "Anthropic blocks subscription routing 10-50x cost" `[85Q9htV2CBE confidence:LOW]`. Codex is the easier path to subscription pricing for agentic loops.
- Tasks where computer-use beats Claude on reliability `[2d9ZmA-4QzU confidence:LOW]`.

**Key characteristics.**
- App-server JSON-RPC surface (`thread/start`, `turn/steer`, `turn/interrupt`, etc.) — richer programmatic surface than Claude Code's CLI flags.
- Sandbox modes: `read-only` / `workspace-write` / `danger-full-access` as first-class config.
- Sky-team computer-use lineage: ex-Workflow/Shortcuts and ex-Apple WebKit engineers `[2d9ZmA-4QzU confidence:LOW]`. Domain expertise visible in the desktop-control quality.

**Avoid for.**
- Workflows that depend on Anthropic's MCP hook system (Codex's hook surface is intentionally Claude-compatible but only has 6 events vs Claude's 10+).

**Empirical addenda from our Phase 4 work.**
- Subscription-auth model availability constrained: `gpt-5.2-codex` (the CLI default) retired from ChatGPT accounts 2026-04-14; working models on subscription are `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4` `[Phase 4 probe 2026-05-15 confidence:HIGH]`.
- CLI 0.130.0 hangs reading stdin when prompt is passed as a positional argument unless caller explicitly closes stdin `[Phase 4 fix 2026-05-15 confidence:HIGH (direct empirical)]`.
- `--ephemeral` flag silently hangs on ChatGPT-account auth `[Phase 4 probe 2026-05-15 confidence:HIGH]`.

**Confidence overall.** MEDIUM. Strong direct experience from Instar building against it.

---

### OpenAI Apps SDK / "Apps" platform

**Provider.** OpenAI.

**Best fit.**
- App-server-mediated agent integrations.

**Research gap.** Not deeply covered in transcripts. Phase 5d benchmarking should profile.

**Confidence overall.** PROVISIONAL.

---

### Atlas / Chronicle (OpenAI browser)

**Provider.** OpenAI.

**Best fit.**
- Browser-side agent runtime under OpenAI's "computer work" framing `[2d9ZmA-4QzU confidence:LOW]`.

**Constraints.**
- Geo-restricted launch (April 20, not EU/UK/CH) `[2d9ZmA-4QzU confidence:LOW]`.

**Confidence overall.** LOW.

---

## Third-party agent frameworks

### Goose AutoAgent

**Provider.** Third-party.

**Best fit.**
- Meta-agent / task-agent split with explicit "model empathy" — the framework recognizes different sub-tasks suit different models `[xnG8h3UnNFI confidence:LOW]`. Conceptually adjacent to what Instar's selection layer needs to do.

**Confidence overall.** LOW.

---

### Cursor

**Research gap.** Mentioned only as the source of the "CursorBench" benchmark, not assessed as a framework. Phase 5b research pass should populate this entry from the Cursor product docs.

**Confidence overall.** PROVISIONAL.

---

### Aider

**Research gap.** Not mentioned in any transcript. Populate from Aider docs.

**Confidence overall.** PROVISIONAL.

---

### Continue.dev

**Research gap.** Not covered.

**Confidence overall.** PROVISIONAL.

---

### OpenClaw (third-party general-purpose agent)

**Provider.** Third-party.

**Best fit.**
- Email automation — "if you look at the most popular use case for Open Claude, it's just doing email" `[QT7W_uHjqWE confidence:LOW]`.
- SaaS-replacement workflows when hooked to APIs — "$320,000 value SaaS replacement suite by hooking your open claw up to APIs"; "scale your ad creator from 20 to 2000" `[kVPVmz0qJvY confidence:LOW]`.

**Avoid for.**
- Anywhere safety matters and you can't audit the workflow: "open claw is unsafe… not necessarily a technical one, it's a people reason… moving really fast and skipping all of these foundations" `[kVPVmz0qJvY confidence:LOW]`.

**Confidence overall.** LOW.

---

### Karpathy's nanochat / Open Brain pattern

**Best fit.**
- The durable agentic primitive — `edit→run→measure→keep/revert` `[xnG8h3UnNFI, dxq7WtWxi44 confidence:LOW]`.
- Empirical wins cited: Skypilot 910 experiments under $300, Tobi Lutke 19% gain, 700 experiments overnight with 11% speedup `[xnG8h3UnNFI confidence:LOW]`.

**Not a framework you adopt directly.** This is a PATTERN to evaluate other frameworks against — does the framework let you express this loop natively?

---

## Cross-framework routing heuristics

These are the routing intuitions for framework selection. The selection layer (Phase 5b) implements them; the benchmark layer (Phase 5d) validates them.

1. **Code work needing max-effort modes → Claude Code** with Opus 4.7. Other paths can't reach the same ceiling on the same model.
2. **Code work under subscription economics → Codex CLI** with `gpt-5.3-codex`. Anthropic's subscription routing has 10-50x cost penalty per `85Q9htV2CBE`.
3. **Repetitive browser tasks → Claude for Chrome** (small data scale) OR **Codex/Atlas** (computer-use scale).
4. **Programmatic one-shot completions → Anthropic Agent SDK** OR **Codex CLI's exec mode**. Choice driven by which provider's credit pot has capacity.
5. **Long-horizon autonomous loops → Claude Code** (most validated for 48+ hour operation in Instar's experience).
6. **Tasks requiring structured approval events → Codex CLI** (app-server has structured requestApproval events natively; Claude Code scrapes terminal).
7. **Tasks requiring native subagent lifecycle hooks → Claude Code** (Codex has no native subagent hook events; adapter synthesizes from app-server thread notifications).

---

## Update discipline

Same as the model catalog. Frameworks evolve more slowly than models — most framework entries shift on a quarterly cadence rather than monthly — but the same Rule-3 enforcement applies: any change to a framework's fitness profile lands in the same PR as the consuming routing-rule change.

---

## Research source

`research/synthesis-nate-b-jones.md` — synthesized from 25 transcripts pulled 2026-05-15. Phase 4 empirical findings cited inline where applicable.

Next research passes will add:
- Aider docs + community pulse
- Cursor product documentation + recent changelog
- Continue.dev docs
- Direct Anthropic Agent SDK profiling
- Direct OpenAI Apps SDK profiling

The catalog graduates from `v0.1` to `v0.2` when at least three entries have been upgraded from `LOW` to `MEDIUM`/`HIGH` confidence.
