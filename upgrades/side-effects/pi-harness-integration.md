# Side-Effects Review — pi-harness-integration (Phases A-D)

## Blast radius

Additive at every layer; ships DARK behind `enabledFrameworks` containing
`'pi-cli'` (default absent) AND a detectable `pi` binary. With the default
config, NOTHING registers and NO dispatch path changes outcome.

Shared-file behavior changes (the only non-additive surfaces):

1. **SessionManager.isMarkerStuckAtPrompt** — adds a new detection branch
   (marker sandwiched between two `─` rule lines, pi's input box). Requires
   BOTH the injected marker AND a rule within 2 lines above AND below —
   normal transcript output and the other frameworks' panes cannot satisfy
   it (their input areas use prompt chars, not rule sandwiches). Existing
   prompt-char branches untouched; pinned by tests against real captured
   pane bytes for all four frameworks.
2. **SessionManager binary resolution** — pi-cli now resolves to bare `'pi'`
   instead of falling back to `claudePath` (which holds a CLAUDE binary).
   Without this, a pi topic on a claude install would silently launch
   Claude — the exact additive-only violation this project forbids. Other
   frameworks' resolution is byte-identical.
3. **framework-arg-rendering-matrix test** — now DERIVED from
   SUPPORTED_FRAMEWORKS instead of a hand-list (which had silently dropped
   gemini-cli). Test-only.

## Framework generality

This change EXTENDS the framework abstraction rather than special-casing:
'pi-cli' rides the same Record<IntelligenceFramework, …> dispatch maps as
claude-code / codex-cli / gemini-cli (launch builders, injection processes,
activity + process signals, parity renderer), and the never-exhaustiveness
checks force every future dispatch site to handle all four. The
framework-agnosticism test suite passes with pi included; the arg-rendering
matrix now derives from the registry so a fifth framework cannot silently
miss coverage. Warm-session injection works for pi via the
FRAMEWORK_INJECTION_PROCESS_NAMES entry ('pi'), same as every framework.

## Security / spend surfaces

- **Subscription guard (structural)**: Anthropic/Claude-routed pi model
  patterns are DENIED at every call-construction path (one-shot transport,
  RPC session start, intelligence provider construction), including
  aggregator pass-throughs (`openrouter/anthropic/...`) and the
  pattern-less case (pi's ambient default could be an Anthropic login).
  Override is file-config only (`piCli.allowAnthropicProviders`), never env
  or per-call; allowed calls are audit-logged with a cost warning.
- **Child env hardening**: pi child processes get an explicit allowlist env
  with UNCONDITIONAL deletion of all billing-capable vars (ANTHROPIC/
  OPENAI/GEMINI/GOOGLE/XAI/GROQ/OPENROUTER keys + CLAUDE_CODE_OAUTH_TOKEN),
  mirroring the gemini Rule-1a analog. pi authenticates via its own
  ~/.pi/agent/auth.json (subscription OAuth) or models.json custom keys.
- **No permission system in pi**: instar's gate layer wraps pi sessions
  exactly like other frameworks; containerization noted as future hardening
  in the spec (§ kickoff Risks).

## Rollback

Revert the commit. No migrations mutate state destructively (the CLAUDE.md
migration is content-sniffed append-only; no config defaults are written).
Agents that opted in simply lose the pi framework value on downgrade —
their claude-code/codex-cli/gemini-cli behavior is untouched.

## Deliberate non-goals (tracked in spec §9, not silent drops)

Replacing any Claude Code path; pi-ai adoption for non-pi internal calls;
OAuth flow automation; cross-provider mid-session handoff; event-stream
dashboard renderer (optional Phase E, decided after the core lands).

## CI-fix follow-up (post-first-commit)

Greening CI surfaced expected churn, no behavior change:
- Three existing tests hardcoded the 3-framework SUPPORTED list → added
  'pi-cli' to the expectations.
- The `no-silent-fallbacks` ratchet counted the intelligenceProviderFactory
  pi-cli degrade-to-null catch → marked `@silent-fallback-ok` (it warns
  loudly and the router emits its own DegradationReporter; a second report
  here would double-count the same degrade).
- The release-fragment lint required `## Summary of New Capabilities` → added
  it and switched to the canonical `<!-- bump -->` comment.
None of these touch runtime behavior; they align the new framework with the
existing structural gates.
