# Background checks stopped failing on large prompts

## What Changed

Every `tmux send-keys -l` call site now routes through a single funnel
(`src/core/tmuxLiteralSend.ts`) that splits the payload into chunks below the argv ceiling.

`send-keys -l` carries its whole payload in ONE argv element, bounded by `ARG_MAX` minus the
environment. Measured on the affected host (tmux 3.6a / darwin): **~16,256 B sends, ~16,480 B fails**
with a bare `command too long`. The `anthropic-interactive-pool` provider sends prompts this way and
they routinely run ~40 KB, so it failed every time.

`LlmCircuitBreaker` also stopped asserting a cause it had not measured: its OPEN log line hardcoded
`provider rate-limited` for every trip. The new pure `classifyTripCause()` reports the argv ceiling, a
genuine rate limit, a transport failure, a timeout, a missing binary, an auth failure — or plain
`provider unavailable` when the reason does not say. The trip DECISION path is untouched; only the
narration changed.

`scripts/lint-no-unfunneled-tmux-literal-send.js` (registered in the `lint` chain) fails the build on
a raw unfunneled literal send, so the class cannot silently return.

## What to Tell Your User

If your agent's background self-checks were quietly failing — message review, completion
verification, stuck-session detection — this is the fix, and it was never a quota problem.

Your agent hands text to its own reasoning sessions through a terminal command that takes the whole
message as one argument. Operating systems cap how big a single argument can be; on the affected
machine that cap was about 16 KB, and the prompts these checks send are around 40 KB. They were
rejected instantly, every time, with three words: command too long.

The confusing part was the label. When those calls failed, the safety component that pauses a failing
service logged **"provider rate-limited"** — for every possible cause, whether or not any limit was
involved. So the logs showed an account apparently hitting its usage cap fourteen times in a row, and
every reasonable next step that suggests — check the plan, wait for a reset, add capacity — pointed
away from a decades-old argument-size limit.

On the machine where this was found, **ten components were sitting at 76–100% failure**, including the
one that reviews outgoing messages and the one that checks whether the agent is telling the truth
about finishing work.

Large prompts now go out in pieces, and the receiving session sees identical text — verified
byte-for-byte on a real terminal at 40 KB. The breaker now reports what actually happened instead of
guessing.

## Summary of New Capabilities

No new capabilities — a correctness fix plus a structural guard. Nothing gains authority: the chunker
is transport mechanics and the classifier is a pure label with no say in whether the breaker trips.

## Evidence

- **Live measurement before the fix:** `[llm-circuit] OPEN: provider rate-limited … (trip #14)`,
  tripping every 15 minutes since 09:59Z, reason
  `Failed to send prompt: Command failed: … tmux send-keys … -l …`. Ten components at 76–100% error,
  every `byModel` row showing `tokensIn: 0` — the calls never produced anything.
  Worst by volume: `SessionActivitySentinel` 6977/7148 (97.6%); most consequential:
  `MessagingToneGate` 260/342 (76%).
- **Ceiling reproduced directly:** a single `send-keys -l` of a 39,992 B payload returns
  `command too long`; the chunked path delivers **39,992 of 39,992 bytes byte-exact**, head and tail
  markers present.
- **Falsifiability control:** raising `TMUX_SEND_KEYS_CHUNK_BYTES` to 60,000 turns **2 of 3**
  integration tests red; restoring 8,000 makes them green — so the suite fails against pre-fix
  behaviour rather than passing vacuously.
- **Lint A/B:** injecting a raw `send-keys -l` at a converted call site exits 1 naming file+line; the
  restored tree exits 0.
- **Scope:** 9 call sites audited, 8 converted (the 9th is the funnel itself); the remaining fixed-size
  canary uses the shared builder for uniformity.
- **New tests:** `tests/unit/tmux-literal-send.test.ts` (14),
  `tests/unit/llm-circuit-trip-cause.test.ts` (6),
  `tests/integration/tmux-literal-send-ceiling.test.ts` (3).
- **Green:** 132/132 across the 8 suites covering the circuit breaker, session-manager injection and
  interactive-pool readiness, plus 20/20 new unit and 3/3 new integration. `tsc --noEmit` clean; full
  `npm run lint` chain clean with the new lint registered in it.
- **Side-effects review:** `upgrades/side-effects/tmux-literal-send-ceiling.md`.
- **Plain-English overview:** `docs/specs/tmux-literal-send-ceiling.eli16.md`.

## Known limits (stated, not deferred)

- The chunk size is a fixed constant, not a probe of the live `ARG_MAX`. It sits at roughly half the
  measured ceiling, and an integration test asserts a full-size chunk still sends in one call, so a
  machine whose real ceiling is lower fails loudly rather than silently.
- The lint is a guardrail, not a proof: a dynamically-constructed argv array would evade it. This is
  declared in the lint header rather than implied away.
- Anything grepping logs for the literal string `provider rate-limited` will now miss trips that were
  never rate limits. That is the correction, but it is a real change to a string other tooling may
  match on.
