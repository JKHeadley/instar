# Side-effects review — Tier 2.E Subsystem framework-aware intelligence

**Version / slug:** `tier-2e-subsystem-shared-intelligence`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (single-flag substitution: every subsystem now consumes the already-framework-aware `sharedIntelligence` instead of constructing its own ClaudeCli provider)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

Server-boot smoke test with `INSTAR_FRAMEWORK=codex-cli` confirmed
`Intelligence: Codex CLI` for the primary `sharedIntelligence`, but
some downstream subsystems were independently constructing
`ClaudeCliIntelligenceProvider`, which silently routed their LLM calls
through Claude even though the agent was supposed to be Codex-only.

Affected subsystems:
1. **RelationshipManager** — `config.relationships.intelligence` was
   built from `new ClaudeCliIntelligenceProvider(claudePath)`.
2. **TopicSummarizer** — Session-completion auto-summarization
   instantiated its own Claude provider via dynamic import.
3. **JobReflector** (via `instar reflect` CLI) — `resolveIntelligence`
   helper built Claude unconditionally.

Fix: each call site now first consults `sharedIntelligence` (built
upstream by `buildIntelligenceProvider({ framework: resolvedFramework })`)
and only falls back to constructing a Claude provider when
`sharedIntelligence` is unavailable. The reflect CLI uses
`frameworkFromEnv()` directly since it doesn't share state with the
server boot path.

Files touched:
- `src/commands/server.ts` — 2 call sites:
  - RelationshipManager init now reuses `sharedIntelligence` and emits
    `LLM-supervised (Codex CLI)` (or Claude, or fallback) in the boot log.
  - TopicSummarizer init prefers `sharedIntelligence` over a dynamic
    Claude import.
- `src/commands/reflect.ts` — `resolveIntelligence` now uses the
  factory + `frameworkFromEnv` first; Claude-only path remains as a
  documented last-ditch fallback.

## Decision-point inventory

- **Reuse sharedIntelligence vs build fresh** — `add` (reuse). The
  framework already resolved once at boot via `resolvedFramework`.
  Building a fresh provider per subsystem (a) duplicates the spawn
  cost on first use, and (b) creates a footgun where one subsystem
  gets Claude while another gets Codex on the same boot. Reuse keeps
  every subsystem on the same plane.
- **Preserve the Claude fallback** — `add`. When
  `sharedIntelligence` couldn't be built (no Claude AND no Codex
  installed), the call sites still try the legacy ClaudeCli
  constructor as a last-ditch. Drops to heuristic-only beyond that.
  Symmetric with the existing `sharedIntelligence` fallback in
  server.ts at line 2055.
- **Reflect CLI's own factory call** — `add`. The reflect CLI runs
  outside the server boot path; it can't reach `sharedIntelligence`.
  Doing a fresh `buildIntelligenceProvider({ framework })` call there
  is the right shape — same pattern the `instar route` CLI uses.

## Signal vs authority

This change doesn't shift any signal/authority boundaries — each
subsystem still has its own LLM-supervised authority for its domain
(identity resolution, topic summarization, reflection). The change is
purely about WHICH framework's CLI carries those decisions.

## Over-block / under-block analysis

**Over-block:** None. The Claude fallback ensures any installation
that was working before still works.

**Under-block:** A user with Codex-only could see slightly different
relationship/summary outcomes than a Claude-only user — that's the
whole point of provider portability. Same Phase 5a fitness research
that mapped tasks→models applies; nothing about the call shape
changes.

## Level-of-abstraction fit

- Call-site change only; no new abstraction.
- `sharedIntelligence` is already the framework-aware singleton; we're
  just plumbing it where it should have plumbed originally.

## Interactions

- **`RelationshipManager`** — receives `sharedIntelligence` instead
  of a fresh ClaudeCli. Same interface.
- **`TopicSummarizer`** — same.
- **`JobReflector`** — same.
- **No interface changes** anywhere.

## External surfaces

- Boot-log copy change:
  - Before: `Relationships loaded: 0 tracked (LLM-supervised (Claude CLI subscription))`
  - After: `Relationships loaded: 0 tracked (LLM-supervised (Codex CLI))`
    or `(Claude CLI subscription)` per `intelligenceSource`.
- No new endpoints / env vars / config keys.

## Rollback cost

Trivial.

## Tests / verification

- `npx tsc --noEmit` clean.
- End-to-end boot verification:
  - Before: `Relationships loaded: 0 tracked (LLM-supervised (Claude CLI subscription))` even with `INSTAR_FRAMEWORK=codex-cli`.
  - After: `Relationships loaded: 0 tracked (LLM-supervised (Codex CLI))` with `INSTAR_FRAMEWORK=codex-cli`.
- No new unit tests: the change is a call-site re-pointer to the
  existing `sharedIntelligence` singleton, which is already tested
  upstream in `tests/unit/intelligenceProviderFactory.test.ts` and
  `tests/unit/config-framework-routing.test.ts`. Adding a fresh
  per-subsystem test would just re-assert the same factory plumbing.
