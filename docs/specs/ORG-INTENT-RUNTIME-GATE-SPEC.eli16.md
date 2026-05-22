# ORG-INTENT Runtime Gate — ELI16

> Plain-English companion to `ORG-INTENT-RUNTIME-GATE-SPEC.md`. Read this first; jump to the spec for full technical detail.

## What is this about

Instar agents have a file called `ORG-INTENT.md`. It describes what the organization wants the agent to actually optimize for — not just what the agent does, but what the organization wants the agent to *want*. The file has three sections:

- **Constraints**: hard rules the agent can never break (e.g. "never quote internal pricing externally")
- **Goals**: organizational defaults the agent should follow (e.g. "resolve customer questions on first contact when possible")
- **Values**: how the org wants to be represented (e.g. "honesty over expedience")
- **Tradeoff hierarchy**: which value wins when two collide (e.g. "customer trust over resolution speed")

This file format and a parser for it shipped over a year ago. But it had a quiet problem: nothing actually read the file at runtime. It was only used by offline analyzer commands. So an agent with the file behaved identically to one without it. The Klarna failure mode — agent optimizes perfectly for the wrong objective — was not actually prevented by the existence of ORG-INTENT.md.

## What this change does

We wire ORG-INTENT.md into the Coherence Gate, the piece that already reviews every outbound message before it gets sent. Now:

1. When the gate loads the agent's value documents to give to its reviewers, it actually parses ORG-INTENT.md into its three structured sections.
2. The reviewer that's literally named "value-alignment" now sees the constraints, goals, values, and tradeoff hierarchy as separate labeled sections, not as one mashed-up text blob.
3. The reviewer's instructions explicitly say: "constraint violations MUST be blocked. Goal contradictions warn or block. Value drift warns. The tradeoff hierarchy resolves ties when two values pull opposite directions."

In plain English: if you write "never quote internal pricing" in your ORG-INTENT.md, and the agent then drafts a message that quotes internal pricing, the gate now blocks the message. Before this change, the file would have been on disk doing nothing.

## What it doesn't do (yet)

This is one of four planned phases. The remaining three are queued behind this one:

- **Phase 2 — Session-start injection**: parsed intent gets injected at the start of every session, the same way the agent's identity does, so the agent reasons with it from message one rather than only getting blocked after the fact.
- **Phase 3 — Tradeoff helper**: a small reusable piece that any part of the code (not just the message reviewer) can consult to resolve value tradeoffs per the hierarchy.
- **Phase 4 — Drift detection job**: a periodic background check that samples recent outbound actions and flags accumulated drift, even when no single message violates anything.

## What you'll notice as an operator

- If you have an ORG-INTENT.md authored and you actually meant your constraints — you may see new blocks on agent messages you didn't see before. That's the point. Audit your file before deploying this version, because constraints that were toothless before now have teeth.
- The value-alignment reviewer becomes slightly more aggressive about failing closed when ORG-INTENT.md has constraints. Specifically, on Telegram and other external channels, a timeout of the reviewer now blocks the message ("Review system unavailable") instead of letting it through unreviewed. This is the "constraints are mandatory" half of the contract showing up in the failure modes too.
- The migrator updates your CLAUDE.md the next time instar runs an update, so the agent itself learns that ORG-INTENT.md is now load-bearing.

## What you'll notice if you don't have ORG-INTENT.md

Nothing. If the file is absent, template-only, or unparseable, behavior is exactly what it was before. This is a zero-cost upgrade for agents that haven't authored an ORG-INTENT.md.

## How to roll back

The change is non-destructive. We kept the old flat-blob loading path alongside the new structured one — the structured path takes priority when ORG-INTENT.md is present and parseable, but the legacy field is still passed too for custom reviewer compatibility. To revert: pass `orgValues` only and skip `orgIntent` in the gate's value-doc loader. The rest of the code keeps working.

## Tests

Three tiers, all passing:

- Unit tests prove the gate loads the structured intent correctly, the formatter omits empty buckets, the cache TTL is honored, and the migration is idempotent.
- Integration tests prove the HTTP route returns the right verdict end-to-end with a real CoherenceGate and a stubbed LLM.
- E2E lifecycle tests prove the wiring matches `src/commands/server.ts` — the "feature is alive" check that catches the "I built it but never plugged it in" failure mode.

## Where to look next

- Spec: `docs/specs/ORG-INTENT-RUNTIME-GATE-SPEC.md`
- Side-effects review: `upgrades/side-effects/org-intent-runtime-gate.md`
- Original intent engineering spec (the one this builds on): `docs/specs/INTENT-ENGINEERING-SPEC.md`
