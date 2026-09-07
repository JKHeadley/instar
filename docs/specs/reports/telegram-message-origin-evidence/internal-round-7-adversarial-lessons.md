# Round 7 — Adversarial and lessons-aware review

Verified current spec body SHA-256 after removing frontmatter: `113955744c76d9474652b98ceb450012a6066f68be38f7008a0fe2d09e1784f2`. Read the changed canonical-serialization, clock-skew, evidence-fallback, Web K feasibility and recording-outage paragraphs; retained prior full-spec/source/lessons grounding. Also read `browser-feasibility.md` and the anonymous Web K canary artifact. `conformance-round-7.json` reports 90 standards checked, zero findings, not degraded, with a passing registry canary.

## ADVERSARIAL perspective

**DESIGN: 0. PRECISION: 1.**

### R7-AL1 — PRECISION — Name the transport-specific sealing boundary for Web K

The canonical section calls each materialization's digest the exact serialized wire-body bytes and prohibits transport reserialization. That is precise for a sealed Bot API HTTP body. The evidenced Web K path, however, supplies immutable RPC method/arguments to `apiManager.invokeApi`; the client worker necessarily performs Telegram TL serialization and transport encryption afterward. The wording should not imply that the plan stores the final encrypted MTProto network bytes or bypasses the existing client's codec.

Clarify that the browser's sealed application request is the canonical RPC method/argument representation entering the version-tested bridge, while the Bot API boundary seals the actual HTTP body. The bridge may only parse/encode those same fixed semantic values through the provider codec; no application-level reparsing/Markdown/content/destination mutation is permitted. Provider framing/encryption is outside the application-body digest claim. This names the boundary of the already-selected architecture, rather than requiring a new capture system or changing the authorized operation.

No new DESIGN issue found. Canonical version, ordering, integer/string-ID treatment, Unicode/entity preservation and golden fixtures now make independent implementation agreement testable. Parent-content and child-materialization digests have distinct purposes. Current policy checks invalidate stale notice reservations instead of editing their sealed bytes. Evidence sinks remain inert; correlated spool failure is acknowledged; same-ID uncertain Web work cannot silently become a fresh request. Closing the owning browser on deadline bounds further worker activity without falsely proving non-acceptance.

## LESSONS-AWARE perspective

**DESIGN: 0. PRECISION: 0.**

The draft now explicitly engages the new review concerns: local spool separation is file-level rather than an unsupported hardware-resilience claim; the peer gets its remaining bounded time; clocks have a stated skew/transport assumption and preserve unknown/rejection honestly; notice policy/snapshot invalidation precedes a single attempt; bounded recording fallback exhaustion is the specific self-heal prerequisite rather than an invitation to invent another repair loop.

The browser spike has concrete source-map paths, public-asset hashes and an anonymous manager RPC canary. Its report expressly does not claim authenticated sending, current login validity or a production receipt trial. The required activation test and version-drift canary remain appropriate L5/P20 evidence, and replacing an imagined DOM receipt with a named server-result seam respects P11's feasibility discipline. No extra transport enrollment or new operator decision is inferred from unverified login state.

## Result

Total: **0 DESIGN, 1 PRECISION**. No prior finding was relabeled to produce a quiet result. This is a design-quiet pass; the parent comparison process owns aggregate convergence. No source/runtime implementation changed and no external messages were sent.
