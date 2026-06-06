---
title: Pi Harness Integration
project: pi-harness-integration
status: spec
approved: true
approval_basis: >
  Pre-approved under Justin's blanket all-tiers authorization for the 24h
  autonomous run (topic 20390, 2026-06-06T03:08Z: "Yes, go … please enter a 24
  hour autonomous session to attempt to fully accomplish all Tiers robustly").
  Scope changes beyond this spec still require his word.
---

# Pi Harness Integration Spec

> Project `pi-harness-integration` (topic 20390). Grounding: kickoff
> requirements (`_drafts/pi-harness-integration-kickoff.md`) and the hands-on
> evaluation (`_drafts/pi-eval-report.md`, pi 0.78.1, both faces verified).
> Tip-of-main integration target: the provider substrate from PR #873.

## 0. Constraints (non-negotiable, from Justin)

1. **Additive only.** No subscription path is displaced. Claude work stays on
   Claude Code (plan limits). The pi route REFUSES Anthropic providers by
   default (§4.3 structural guard) — extra-usage billing can never be selected
   silently.
2. **Dashboard parity.** pi sessions stream + accept direct input in the
   dashboard exactly like Claude Code sessions (TUI-in-tmux, §3). The
   event-stream renderer (§6.1) is an optional later UPGRADE, never a
   replacement.
3. **Ships dark.** Everything gates on `enabledFrameworks` containing
   `'pi-cli'` (default absent). Existing agents see zero behavior change.

## 1. Naming & identity

Framework id: **`pi-cli`** (consistent with `codex-cli`/`gemini-cli`).
Binary: `pi` (from `@earendil-works/pi-coding-agent`), path overridable via
`frameworkBinaryPaths['pi-cli']`. Provider-substrate adapter id: `pi-cli`.

## 2. Phase A — fourth framework (project items P1.1, P1.2)

### 2.1 Type unions (compiler-enforced where possible)

Add `'pi-cli'` to: `types.ts:65` (Session.framework), `types.ts:139-141`
(componentFrameworks), `types.ts:154` (SessionManagerConfig.framework),
`types.ts:2182` (topicFrameworks), `types.ts:2301` (enabledFrameworks),
`types.ts:116/125` (frameworkBinaryPaths/frameworkDefaultModels), and
`intelligenceProviderFactory.ts:46` (`IntelligenceFramework`) — the `never`
exhaustiveness checks at `intelligenceProviderFactory.ts:170` and
`frameworkSessionLaunch.ts:338` then force every dispatch site to handle it.

### 2.2 Interactive launch builder (`piCliBuilder`)

`frameworkSessionLaunch.ts` BUILDERS entry:

- Command: `pi` + `--session-dir <agentStateDir>/pi-sessions` (durable,
  reap-log-coherent location — eval caveat 4) + `--provider <p> --model <m>`
  when `frameworkDefaultModels['pi-cli']` is set (format `provider/model`).
- Resume: `--session-id <id>` (deterministic create-or-resume; verified
  `--continue` also works but is ambient — we pin explicit ids like Claude's
  `--resume`).
- No permission-bypass flag exists or is needed (pi is YOLO by design; our
  gate layer wraps it like every framework — kickoff Risks).
- tmux: set `extended-keys on` for pi sessions (eval caveat 1); plain Enter
  injection verified working regardless.
- `frameworkInjectionProcesses.ts`: `'pi-cli' → ['pi']` (the
  framework-agnosticism test enforces this pairing).
- `SessionManager.isMarkerStuckAtPrompt`: pi's input box has no `❯`-class
  prompt char; detection key: the bordered input region + stable status line
  (`<cwd> … <model>` bottom line). P1.2 pins the exact pattern with the
  hermetic fixture; until then pi falls back to the generic marker path.

### 2.3 Headless builder

`pi --mode rpc --no-session` one-shot: write `{"type":"prompt"...}` line,
read events to `agent_end`, exit. (RPC is strictly LF-framed JSONL — parser
MUST NOT use Node `readline`; eval-verified + upstream docs.) This builder is
shared with §4's provider adapter — one implementation, two consumers.

### 2.4 First-boot warm-up

pi downloads `fd`/`ripgrep` on first run (eval caveat 2). The adapter
tolerates the delay; `instar doctor` gains a non-blocking note when the pi
binary is configured but has never booted.

## 3. Phase A — dashboard parity (project item P1.3)

NO dashboard code changes. Verification (tests, not assumption):
- Integration: spawn pi session (hermetic fixture provider), assert
  `GET /sessions` lists it with framework `pi-cli`; assert
  `GET /sessions/:name/output` streams the pane (the eval showed tool
  execution renders in-pane); assert `POST /sessions/:name/input` round-trips
  (send prompt → mock-driven tool runs → pane shows `HERMETIC-TOOL-EXEC-OK`).
- E2E: production-init path boots with `enabledFrameworks: ['claude-code','pi-cli']`
  and the sessions surface is alive (200, not 503).

## 4. Phase B/C — provider-substrate adapter + routing (P2.1, P2.2)

### 4.1 RPC client (`src/providers/adapters/pi-cli/transport/rpcClient.ts`)

Typed client over child-process stdio: strict-LF JSONL framing; request/
response correlation by `id`; commands `prompt`, `steer`, `follow_up`,
`get_state`; typed event union (verified event taxonomy: `agent_start/end`,
`turn_start/end`, `message_start/update/end` with
`toolcall_start/delta/end|text_start/delta/end`, `tool_execution_start/
update/end`, `response`). Session persistence via `--session-dir` +
`--session-id`.

### 4.2 Provider adapter (`createPiCliAdapter`)

Follows the #873 adapter pattern (mirror `adapters/openai-codex/` shape):
capabilities `OneShotCompletion`, `AgenticSessionHeadless`,
`AgenticSessionRpc`, `AgenticSessionInteractive`; registered at boot by
`registerPiAdapters()` (mirrors `registerAnthropicAdapters()` — idempotent,
gated on `enabledFrameworks` containing `'pi-cli'` AND pi binary resolvable;
absent binary degrades to not-registered + doctor note, never a boot failure).

### 4.3 Subscription guard (STRUCTURAL — the additive-only enforcement)

`src/providers/adapters/pi-cli/policy.ts`: provider allowlist evaluated on
EVERY session/prompt construction:

- DEFAULT DENY for `provider === 'anthropic'` (and any provider whose auth
  entry is an Anthropic subscription OAuth token): constructing a pi call
  with an Anthropic provider throws `PiAnthropicRouteError` with the
  explanation (extra-usage billing ≠ plan limits; use claude-code instead).
- Override ONLY via explicit `piCli.allowAnthropicProviders: true` in
  `.instar/config.json` — and even then the call is audit-logged with a
  cost warning. No env-var or per-call bypass.
- Unit tests cover both sides of the boundary (deny default, allow+audit on
  explicit opt-in) per the Testing Integrity semantic-correctness rule.

### 4.4 Component routing

`intelligenceProviderFactory.ts`: `case 'pi-cli'` builds a
`PiCliIntelligenceProvider` (one-shot headless RPC under the hood) with its
OWN circuit breaker (per-framework isolation parity). `componentFrameworks`
accepts `'pi-cli'` in categories/overrides — e.g.
`{"categories": {"sentinel": "pi-cli"}}` routes sentinels through pi onto
whatever non-Anthropic provider its config names (Codex/Copilot subscription
or local). `GET /intelligence/routing` reports it like any framework.

## 5. Phase D — metrics + quota (P2.3)

- Per-feature metrics: `PiCliIntelligenceProvider` reports through the same
  attribution path as Claude/Codex providers → rows appear in
  `/metrics/features` (tokens from pi's usage events — verified present in
  the wire capture).
- ResourceLedger: pi sessions are tmux sessions → CPU/RSS sampling works
  unchanged; pi-routed component calls attribute under their component name.
- Quota: pi adapter exposes provider-reported usage when available;
  rate-limit fallback mirrors other frameworks (breaker + heuristic
  fallback, no herd).

## 6. Phase E — optional (P3.1, P3.2; only after §2-5 land + test-as-self)

1. **Event-stream dashboard renderer**: a `pi-rpc` session kind whose
   transcript view renders from the typed event stream (messages, tool calls,
   costs) — additive tab/view; tmux view remains default.
2. **Apprenticeship mentee groundwork**: register `pi-cli` as a valid
   framework for apprenticeship instances; the hermetic fixture doubles as
   the mentee's training sandbox.

## 7. Testing (Testing Integrity Standard — all three tiers)

- **Fixture**: `tests/fixtures/pi-mock-provider/` — the eval's scripted-turn
  mock OpenAI-completions server (tool-call turn, final-text turn,
  configurable stream delay for steer tests) + models.json template +
  isolated-HOME harness. Zero credentials, zero network beyond localhost.
- **Unit**: builders (launch spec shapes incl. session-dir/session-id),
  JSONL framing parser (incl. U+2028/U+2029-in-string case), policy guard
  (deny/allow+audit), capability declaration.
- **Integration**: real pi binary (devDependency, installed with
  `--ignore-scripts`) against the fixture — RPC one-shot, steer, resume,
  session listing/injection routes. Skip-with-reason when the binary is
  unavailable offline (mirrors LLM-dependent test convention).
- **E2E lifecycle**: production-init boot with pi enabled → routes alive
  (sessions surface, `/intelligence/routing` shows pi-cli, adapter
  registered); the Phase-1 "feature is alive" test.
- **Wiring integrity**: registerPiAdapters deps non-null + real; framework-
  agnosticism test extended for `pi-cli`.
- **Migration parity**: config defaults via `migrateConfig()` (existence-
  checked), CLAUDE.md template section via `migrateClaudeMd()` (content-
  sniffed), template SHA lint satisfied.

## 8. Ship plan within the 24h run

PR 1: docs (kickoff + eval report + this spec). PR 2: Phase A (§2-3).
PR 3: Phases B-D (§4-5). Each: fresh-worktree build, CI green, three tiers,
merge per the established his-word pattern. Then test-as-self proof (deploy
dist into a throwaway home with pi enabled; live pi session end-to-end via
the fixture), THEN §6 optional items as time allows. Final honest scoreboard
to topic 20390; every claim in it `verify-claim`-grade.

## 9. Out of scope (durable record, not silent drops)

- Replacing any Claude Code path (constraint 1).
- pi-ai library adoption for non-pi internal calls (separate decision later).
- OAuth flow automation (interactive by nature; documented unverified).
- Mid-session cross-provider handoff via pi (powerful but no consumer yet).
