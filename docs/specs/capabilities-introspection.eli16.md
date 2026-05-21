# Capabilities Introspection — Plain-English Overview

> The one-line version: the two surfaces that decide what /capabilities tells an agent — the response builder and the lint test — now read from one file instead of being maintained in parallel.

## The problem in one breath

PR #290 fixed the original bug: /capabilities was lying about Secret Drop. It did so by adding a lint that walks routes.ts, finds every top-level path prefix, and checks that each one is either listed in /capabilities or on a known-internal allowlist. That lint worked, but it introduced a subtle second risk: now two hand-maintained surfaces had to agree — the /capabilities response in routes.ts (a 440-line object literal) and the lint's hand-written allowlist (a 50-entry list in test code). If they ever drifted, the lint would silently rubber-stamp the drift because both surfaces lived in the same human's memory.

## What already exists

- **/capabilities.** A live endpoint that lists every primitive the agent can use. The first place an agent looks before claiming something is missing.
- **The discoverability lint.** A test that walks routes.ts and asserts each top-level path prefix is accounted for somewhere. Added in PR #290.
- **The hardened Secret Drop retrieve helper.** Added in PR #292. Streams the secret value safely to stdout without leaking the response body.
- **FeatureRegistry.** A separate registry for opt-in features with consent flows. Not the right home for always-on primitives like Secret Drop or Telegram, but it's surfaced from within /capabilities under the `discovery` key.

## What this adds

A new file, `src/server/CapabilityIndex.ts`, is now the single source of truth for the /capabilities surface. It exports two arrays:

- `CAPABILITY_INDEX` — one entry per capability that should appear in /capabilities. Each entry has a key, the route prefixes it owns, and a build function that produces the response block.
- `INTERNAL_PREFIXES` — top-level routes that should NOT appear in /capabilities (operator-only stuff, health probes, legacy endpoints), each with a one-line reason.

The /capabilities handler in routes.ts shrinks from 440 lines to about 25. It iterates `CAPABILITY_INDEX` and merges the build outputs. The discoverability lint imports both arrays directly and enforces that every route prefix is classified into exactly one of them.

## The new pieces

- **`src/server/CapabilityIndex.ts`** — the registry. One entry per capability, with `{ key, prefixes, description, build }`. Compiler-enforced shape; reviewer-enforced classification.
- **`tests/unit/CapabilityIndex.test.ts`** — module-level invariants. Catches duplicate keys, duplicate prefixes, empty descriptions, orphaned entries. Also has a regression guard that the secrets entry continues to surface the hardened-retrieval hint.

## The safeguards

**Prevents the two surfaces from drifting apart.** Both /capabilities and the lint now read from the same array. Adding a new entry takes effect in both places automatically.

**Prevents silent classification gaps.** Adding a new top-level route prefix to routes.ts fails the lint until the author makes a deliberate choice: claim it under a CAPABILITY_INDEX entry (surfaces it to agents) or add it to INTERNAL_PREFIXES with a reason (skips discovery). The lint refuses to assume.

**Prevents dead entries.** Two new tests assert that every prefix claimed by the index actually exists in routes.ts. A stale entry left behind after a route is deleted will fail CI on the next push.

**Preserves the response shape.** Every existing consumer (agents, the dashboard, integration tests) sees byte-for-byte the same /capabilities response. The refactor is pure data flow.

## What ships when

One PR. The registry, the routes.ts handler refactor, the lint refactor, the new CapabilityIndex test file, and the spec/ELI16/side-effects artifact all ship together. There's no half-state — partial would leave the lint reading from one source and the handler from another, defeating the purpose.

## What you actually need to decide

This PR closes follow-up #2 from the case study. With this in main, all three failure modes from the 2026-05-20 incident are structurally closed: discoverability (PR #290), workaround reflex (PR #292), and the parallel-surfaces risk that PR #290 itself introduced (this PR). Anything else you want to land on this slate before we call the case study done?
