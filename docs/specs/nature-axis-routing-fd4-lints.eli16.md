# FD4 Harness-Door Ban — Enforcement Lints (Plain-English Overview)

> The one-line version: make it *structurally impossible* for a bounded safety check to be answered by the expensive, easily-fooled model on the raw Claude CLI — by adding a build check and a runtime check that both refuse a routing chain that would allow it.

## The problem in one breath

The nature-axis router (shipping dark) picks which model answers each internal check. Bench data shows one route is dangerous: sending a bounded/gating check (a FAST/SORT/JUDGE call — an emergency-stop classifier, a tone gate, a completion judge) to an Opus-family model *through the Claude CLI harness* makes the model credulous and it misses traps. That route must never be reachable. The spec (nature-axis-routing.md, FD4) says the ban must live in THREE independent places so no single edit can re-open it. One place — the always-on runtime clamp — already shipped (A1 #1386, A2.1 #1387). The other two were still just prose.

## What already exists

- **The nature/chain map** — a static table (`NATURE_ROUTING_DEFAULT_CHAINS`, `ROUTING_LABEL_TO_MODEL_ID`) saying which doors+models each chain may use, and which concrete Sonnet id is the one sanctioned Claude reserve.
- **The runtime clamp** (`clampToReserveOnCleanDoor` + A1's always-on `clampClaudeCliSwapModel`) — at model-selection time it rewrites any non-reserve Claude-CLI pick down to the reserve. Place 3 of 3. Already done.
- **The resolver** (`resolveRoute`, `mergeNatureRoutingChains`) — reads the chains live per call, but ONLY when the feature is switched on.

## What this adds

The two missing enforcement places:

- **A build-time lint** (`scripts/lint-nature-chains.mjs`) — reads the authored chain table and FAILS the build if any FAST/SORT/JUDGE position resolves to a non-reserve Claude-CLI model, if the one allowed Claude position is an unpinned tier label instead of the pinned concrete reserve id, or if ANY chain (even WRITE) emits a Fable model. It hard-codes nothing about which id is right — it derives the reserve id and the label map from the source, so swapping the reserve is a data edit, not a lint edit.
- **A resolve-time + config-load validator** (`validateNatureRoutingChains`, a pure predicate) — the SAME rule, run again on LIVE config. Because an operator can `PATCH /config` a whole chain, the validator rejects a banned chain both when config is loaded and when a route is resolved, falling back to the built-in defaults and warning once. The banned route can never be opened by a runtime config edit.

## The safeguards

- **Deny-by-default allowlist, never a denylist** — a Claude-CLI bounded/gating position passes ONLY if it resolves to the single sanctioned reserve id; a future/renamed Opus id can't slip past.
- **WRITE is exempt** for the Claude reserve rule (open-ended writing is the legitimate Opus-via-CLI lane) — but the no-Fable rule applies to every chain.
- **Byte-identical when off** — the validator is consulted only inside `resolveRoute` / `mergeNatureRoutingChains`, both gated behind `sessions.natureRouting.enabled`. With the feature unset/off the resolve path never touches the new code, so routing is bit-for-bit today's behavior. This is the load-bearing safety property and it is asserted in tests.
- **Drift guard** — a ratchet test asserts the build-lint predicate and the runtime validator agree position-by-position, so the two enforcement places can't silently diverge.

## What this deliberately does NOT do

No metered-API doors, no money caps, no PIN go-live (that is Increment B, deferred + PIN-gated). No flip of the feature to enforcing/live (that is the operator-gated A2.2). The FD4.2 R-rule lints (R3–R8) depend on an injection-exposure map that does not exist yet, so they are a tracked remainder, not built here.
