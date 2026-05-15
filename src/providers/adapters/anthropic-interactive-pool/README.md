# anthropic-interactive-pool adapter

Concrete `ProviderAdapter` implementation that satisfies the Phase 2
provider-portability substrate by maintaining a pool of long-lived
`claude` REPL sessions in tmux and routing work through them via
prompt injection.

**Provider ID:** `anthropic-interactive-pool`
**Billing path (post-2026-06-15):** Max subscription (NOT the Agent SDK
credit pot)
**Status:** in progress (Phase 3b)

## Why this adapter

Sister to `anthropic-headless`. Same substrate, different mechanic:

| | anthropic-headless | anthropic-interactive-pool |
| --- | --- | --- |
| Subprocess | one `claude -p` per call | one `claude` REPL per pool slot, many calls |
| Billing post-2026-06-15 | Agent SDK credit pot ($200/mo) | Max subscription |
| Startup cost | ~5s per call | ~5s once per pool session |
| Steady-state latency | full subprocess each time | ~8s/prompt (prototype measured) |
| Context lifetime | per call | per pool session (auto-retire on threshold) |

The Phase 5 routing policy picks between them by cost (drain credit pot
first, then fall back to subscription). Both adapters expose the same
universal-capability surface so the application layer doesn't care which
is in use.

## Primitives implemented

Active (real implementations):
- **WarmSessionInbox** — primary primitive. A handle reserves one pool
  session; messages run on it in order; retire frees it.
- **OneShotCompletion** — allocates a pool session, runs the prompt,
  releases. Recycles sessions after `maxMessagesPerSession`.
- **HardKill / InputInjection / Interrupt** — tmux operations on the
  underlying pool session.
- **AuthCredentialInjection** — same validation rules as 3a, OAuth
  subscription token preferred.
- **ContextScopeControl / CompactionLifecycle** — same as 3a.
- **TimeoutBound / IdleBound / StopGateInterceptor** — in-memory policy.
- **LiveOutputStream** — `tmux capture-pane` against the pool session.
- **ProcessLifecycle** — `tmux list-panes` plus pool state cross-check.
- **SessionId** — bridges warm-inbox handle to Claude REPL session UUID
  (via `bindClaudeSessionId` once a hook receiver surfaces it).

Stub (throw `UnsupportedCapabilityError` until consumer arrives):
- StructuredOneShot, AgenticSessionHeadless, AgenticSessionInteractive,
  AgenticSessionRpc — the pool model doesn't suit these; route to
  anthropic-headless instead.
- All CAPABILITY primitives (ToolAccess, ToolAllowlist, FileSystemAccess,
  PathAllowlist, BashExecution, WebAccess) — buildSpec-style primitives
  inherited from 3a will land when a consumer arrives.
- ConversationLogReader / Tailer, HookEventReceiver,
  SubagentLifecycleObserver, UsageMeterProvider — share data with 3a's
  implementations; cross-adapter consolidation lands in Phase 3c.
- CredentialStorageProvider, IntelligenceCallQueue,
  InteractivePromptObserver — pending consumer.
- All INTEGRATION primitives (ProviderScaffolder, McpToolRegistry,
  SessionResumeIndex, ConversationLogProvider) — same wiring as 3a;
  consolidation in Phase 3c.

## Configuration

```ts
import { createAnthropicInteractivePoolAdapter } from
  './providers/adapters/anthropic-interactive-pool/index.js';

const adapter = createAnthropicInteractivePoolAdapter({
  poolSize: 2,
  maxMessagesPerSession: 50,
  maxIdleMinutes: 30,
  claudePath: '/opt/homebrew/bin/claude',
});

// Pool starts lazily on first allocate; call explicitly to warm eagerly.
await adapter.start();
```

Environment-variable defaults are in `config.ts`. The OAuth subscription
token (`CLAUDE_CODE_OAUTH_TOKEN`, prefix `sk-ant-oat-…`) is the credential
required for subscription billing; an API key falls back to API billing.

## Layout

```
anthropic-interactive-pool/
├── README.md
├── index.ts                  # ProviderAdapter export, pool wiring
├── _smoketest.ts             # real-API end-to-end test
├── capabilities.ts           # capability set declaration
├── config.ts                 # config + env defaults
├── errors.ts                 # ProviderId constant
├── stubs.ts                  # stub primitive factory
├── pool.ts                   # core pool: spawn / allocate / retire
├── promptRunner.ts           # send-keys + capture-pane mechanic
├── transport/                # OneShotCompletion, WarmSessionInbox
├── control/                  # HardKill, Interrupt, InputInjection, …
└── observability/            # LiveOutputStream, ProcessLifecycle, SessionId
```

## Testing

Phase 2 conformance suites verify capability flags and method presence
(no live calls). Real-API end-to-end is the smoke test:

```bash
INSTAR_REAL_API=1 npx tsx \
  src/providers/adapters/anthropic-interactive-pool/_smoketest.ts
```

The smoke test starts a pool of size 1, sends "What is 2+2?" through
`OneShotCompletion`, asserts the response starts with "4", and shuts
down cleanly. Expected runtime is well under 60s based on the
feasibility prototype (8.4s/prompt mean, plus one-time ~10–15s pool
warm-up).
