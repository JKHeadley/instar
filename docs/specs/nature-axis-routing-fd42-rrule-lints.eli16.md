# FD4.2 — R-Rule Structural-Exclusion Lints (Plain-English Overview)

> The one-line version: bake the bench's "never route THIS kind of check to THAT model" rules into build-time and config-load guards, so a future edit can never quietly re-introduce a model placement a benchmark already proved is unsafe.

## The problem in one breath

The nature-axis router (shipping dark) picks which model answers each of my internal background checks. A benchmark found several specific model-for-job placements that are actively dangerous — a cheap model that gets fooled by hidden instructions when it plays a safety judge, a model that burns its whole budget "thinking" and mangles the strict output a bounded check needs, a model that follows planted evidence. The safe chains are already authored to avoid those placements — but "authored to avoid" is a wish: one careless future edit (in the source, or in an operator's config override) could re-add a banned placement and no one would notice. The spec (FD4.2, rules R3–R8) says those exclusions must be STRUCTURAL — enforced by a guard, not by memory.

## What already exists

- **The nature/chain map + door taxonomy** (`src/data/llmBenchCoverage.ts`) — the tables saying which model doors each kind of check may use, plus per-component labels for task-nature and (new, just merged) injection-exposure.
- **The FD4 harness-door ban** — the first R-rule enforcement, shipped as a build lint (`scripts/lint-nature-chains.mjs`) plus a matching resolve-time/config-load validator, keeping a bounded safety check off the expensive-and-fool-able Claude-CLI route in three independent places.
- **The FD5b injection-exposure map** — a static, fail-safe table (just merged) saying, for every internal check, whether it reads content an outsider could have tampered with. R8 depends on this.

## What this adds

The remaining R-rule exclusions from the spec, R3 through R8, as structural guards that change NO runtime behavior today (the shipped chains already obey them):

- **R3** — a "qwen-tier" model may never take a strict-format (bounded, terse-JSON) position, where it chronically over-thinks and mangles its own output.
- **R4** — the consumer Gemini-CLI door may never take an injection-exposed safety-judge (JUDGE) position; a bench showed it follows a judge-directed injection.
- **R5** — the small gpt-oss-20b / llama-4-scout models may never take a gate (JUDGE) verdict position.
- **R7** — no DeepSeek door/model may take an injection-exposed JUDGE position.
- **R6** — doc-tree / cartographer components (which author summaries over untrusted code) may never route to any Claude door.
- **R8** — my input-classifier checks are marked as reading untrusted content AND are pinned off the cheap Flash-Lite door, whose one reproduced trap-fall is exactly that slot.

R3/R4/R5/R7 are POSITION bans over the authored chains — enforced by both the build lint and the same pure predicate the resolver/config-load already use for the FD4 ban, so a banned operator override is rejected and falls back to the safe defaults. R6/R8 are COMPONENT-scoped pins over the per-component maps (which a config override can never touch), so they are build-lint-only.

## The new pieces

- **`validateChainPositionRRule`** (and its per-chain / combined helpers, in `IntelligenceRouter.ts`) — a pure predicate that flags an R3/R4/R5/R7 violation on one authored chain position. Wired alongside the existing FD4 validator at both config-load and resolve-time, so a violating chain is rejected → built-in default + notice, exactly as the FD4 ban already does.
- **The extended build lint** (`scripts/lint-nature-chains.mjs`) — now also enforces R3–R8 over the authored chains and maps, and fails the build (fail-closed) on any violation or unparseable map. Wired into `npm run lint`.
- **Two small component sets** in the data module — the doc-tree/cartographer set (R6) and the input-classifier set (R8) — the structural pins the two component-scoped lints assert over.

## The safeguards

- **No runtime selection change** — the shipped chains are clean, so every new rejection branch is never taken; the metered doors the rules touch (Flash-Lite, Groq) are already skipped in this increment anyway. The point is purely to stop a future edit from authoring a banned placement.
- **Byte-identical when off** — the resolve-time R-rule check lives inside `resolveRoute`, which only runs when `sessions.natureRouting` is enabled; unset/off is bit-for-bit today's behavior. The pre-existing byte-identical-when-off test and A1's clamp test are untouched and green.
- **Lint agrees with the validator** — a drift-guard test asserts the build-lint predicate and the TS validator return the same verdict position-by-position for R3/R4/R5/R7, so the two enforcement places can't silently diverge.
- **Fail-closed** — an empty claude-banned or input-classifier set, or an unparseable map, is a build failure, never a silent pass.

## What this deliberately does NOT do

No runtime selection change, no metered-API doors, no money caps, no PIN go-live (that is the paid-door Increment B, deferred). No flip of the feature to enforcing/live (operator-gated). No change to `resolveRoute`'s selection walk, A1's clamp, or FD5b's map. The spec is NOT marked approved by this change (that is the operator's step) — it stays converged-but-unapproved.
