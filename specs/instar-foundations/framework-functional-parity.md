---
status: foundational-draft
date: 2026-05-18
author: echo
audience: justin
type: foundational-spec
revision: 5
---

# Framework Functional Parity — Instar's foundational compatibility principle

## What this is

A foundational design principle for Instar: every required functional capability works equivalently across every supported agent framework. The user feels framework "flavor" — different model voices, different speeds, different costs — but never feels Instar itself is less capable on one framework than another. When a framework offers bonus capabilities others lack, Instar opportunistically uses them on that framework without making them dependencies elsewhere.

This document defines what functional parity means for Instar, why Instar commits to it, how it's structured, and what the long-term implications are for Instar's identity as a system.

## Why this matters

Instar's value proposition is **persistent autonomy infrastructure** that survives the underlying agent framework. The framework is the substrate; Instar is the persistence layer on top. If Instar's capabilities depend on the substrate, every framework swap regresses functionality and the value proposition leaks. So the substrate must be commoditized at the level of Instar's REQUIRED primitives — gaps in any framework's native implementation are filled by Instar's own native implementations.

Three downstream consequences make this commitment load-bearing:

- **Vendor independence.** When a framework provider changes pricing, deprecates a feature, or sunsets a CLI, Instar agents keep working under any other supported framework with full required-primitive coverage. The 2026-06 Anthropic Agent SDK repricing is exactly this scenario; provider portability v1.0.0 solved it for the cost dimension, this spec extends it to capability.

- **Optimal framework leverage.** Frameworks have framework-specific strengths. Functional parity does NOT mean reducing to the lowest common denominator — it means Instar invests in framework-specific rendering so each substrate is used optimally, AND Instar opportunistically uses framework-bonus capabilities where they exist without making them required.

- **Future identity.** Once every required primitive has an Instar-native implementation (as the fallback for frameworks that lack it natively), Instar has, in fact, become its own agent framework. The functional parity work is the on-ramp to Instar-as-framework, powered by any model (cloud frontier, OSS, local) directly.

## What is NOT a functional primitive

A capability earns "functional primitive" status only when it's a contract Instar promises across frameworks — something a user/agent can name, request, and expect uniformly. Several adjacent things are *not* primitives and live one layer down:

- **Context-engineering strategies.** Recursive tree structures (self-knowledge tree), recursive LLM-driven search, knowledge graphs, semantic search, the playbook scoring system, per-topic memory shards. These are *how Memory's internals are organized* — they decide what content surfaces for a given session and in what shape. They sit below the Memory primitive's contract; the framework only sees the rendered output. A future redesign of any of these strategies leaves the Memory primitive unchanged from the framework's perspective.

- **Rendering / loading mechanics.** IdentityRenderer's logic for turning `.instar/AGENT.md` into `CLAUDE.md` or `AGENTS.md` is implementation of the Instruction-file primitive, not a separate primitive. Same with telegram-relay.sh's bash code.

- **Substrate primitives.** `oneShotCompletion`, `structuredCompletion`, `agenticSession`, etc. — these are Layer 2 (see "Layer relationships" below), not Layer 3 functional primitives. They're the contracts adapters satisfy, not the contracts users invoke.

The distinction matters because it stops the primitive catalog from inflating. Every active area of context-engineering research could otherwise look like a candidate primitive, and the parity sentinel would chase contracts that don't actually need cross-framework guarantees.

When context-engineering strategies *would* graduate to first-class concerns: in the Instar-native-runtime future, where Instar itself is assembling the prompt directly rather than handing the framework a pre-rendered file. At that point context-assembly becomes substrate work, not Memory-internals work. Until then, these strategies are Memory's business.

## What functional parity is NOT

- **Not feature equivalence to the most capable framework.** Bonus capabilities one framework has and others don't are NOT promoted to required just because they exist.

- **Not behavioral identity.** Same prompt across two frameworks produces different output. That's framework flavor; Instar doesn't hide it.

- **Not a lowest-common-denominator policy.** When framework A has a bonus B lacks, Instar still uses A's bonus on A. It doesn't refuse to use it just because B can't.

- **Not "every framework must natively support every primitive."** Frameworks vary. The commitment is that Instar fills any gap with its own native implementation so the agent experience is uniform across required primitives.

## Layer relationships — functional primitives, substrate primitives, framework adapters

The required functional primitives in this doc are NOT the only primitive layer in Instar. They sit on top of an older, lower-level inventory: the **substrate primitives** catalogued during v1.0 provider-portability work (`specs/provider-portability/01-primitives-inventory.md`).

A clean three-layer model:

- **Layer 3 — Functional primitives** (this doc). User-facing capabilities Instar promises: Skill, Hook, Agent, Memory, Instruction-file, Session-resume, Slash-command, Outbound-relay, Conversational-action, Tool, MCP-server. These are what the user/agent talk about ("add a skill", "fire a hook on compaction"). Required uniform across frameworks.

- **Layer 2 — Substrate primitives** (v1.0 inventory). Transport / capability / observability / control patterns Instar relies on under the hood: `oneShotCompletion`, `structuredCompletion`, `agenticSessionHeadless`, `agenticSessionInteractive`, `toolAllowlist`, `pathAllowlist`, `outputStream`, `eventHooks`, `usageMeter`, `inputInjection`, `hardKill`, `authCredentialInjection`, etc. (~51 entries total.) Framework-agnostic contracts; each adapter must satisfy them.

- **Layer 1 — Framework adapters**. Concrete implementations that satisfy Layer 2 contracts on a specific runtime: `anthropic-headless` (Claude Code CLI), `openai-codex` (Codex CLI), future `free-claude-code`, future Instar-native runtime.

### Worked example — StallTriageNurse

Walks the layers cleanly:

- **Layer 3.** StallTriageNurse is a **Hook** (required functional primitive #2) — it fires on a stall-detection lifecycle event. Users perceive "the agent noticed I'm stuck and tried to recover."
- **Layer 2.** Its diagnosis step needs `structuredCompletion` (a substrate primitive — schema-constrained JSON) plus `outputStream` (to read the stuck session's tmux capture). It does NOT need `agenticSession` or `toolAccess`.
- **Layer 1.** A configured `IntelligenceProvider` adapter satisfies `structuredCompletion`. On Claude that's `ClaudeCliIntelligenceProvider` (CLI passthrough) or `AnthropicIntelligenceProvider` (direct API). On Codex it's a Codex adapter implementing the same contract. On a local model it could be Ollama-via-OpenAI-compat.

So when Justin asks "what powers a sentinel that needs an LLM?" the answer is: the sentinel is a Layer-3 Hook; it acquires LLM access by requesting a Layer-2 substrate primitive (`structuredCompletion` or `oneShotCompletion`); the configured Layer-1 framework adapter satisfies that request. None of the three layers is "the" power source — they're stacked.

### Why both layers are required

- Layer 2 alone is too low to be useful to users — they don't think in `oneShotCompletion`-shaped contracts. They think "add a skill."
- Layer 3 alone has no implementation — there has to be a contract for *how* a Hook gets an LLM call, otherwise "Hook" is just a name.
- Layer 1 is the substitutable part. Vendor portability lives here: every Layer-1 adapter is replaceable as long as it satisfies the Layer-2 contracts the Layer-3 primitives consume.

### Architectural promise

**Any framework that satisfies the v1.0 substrate primitive set automatically supports all required Layer-3 functional primitives.** New framework support is therefore a Layer-1 effort: prove the adapter satisfies Layer 2; Layer 3 falls out for free. This is why `free-claude-code` and an eventual Instar-native runtime are tractable additions, not rewrites.

The Required Primitives Inventory (`required-primitives-inventory.md`) records, per functional primitive, which substrate primitives it depends on — making the dependency explicit instead of implied.

## Two classes of primitives

### Required primitives

The foundational capabilities every Instar agent depends on. Instar defines what this set is. Examples (full catalog in the companion inventory doc): skill, agent, hook, tool, memory, instruction-file, session-resume, slash-command-or-equivalent, outbound-relay, conversational-action.

For every (required-primitive × supported-framework) pair, the implementation comes from one of two sources:

- **Framework-native** — the framework already provides the primitive. Instar wraps it, uses framework-specific rendering, gets the framework's optimizations.
- **Instar-native fallback** — the framework lacks the primitive. Instar substitutes its own implementation. The agent and user feel no difference; the primitive Just Works.

This is the gap-fill principle: a framework's lack of a required primitive is NEVER a reason to refuse support. Instar simply fills the gap.

### Bonus primitives

Capabilities that one framework offers but others don't, AND Instar isn't going to commit to as required. Examples might be: a framework's specific parallel-subagent execution model, a particular advanced sandbox mode, the `--oss --local-provider` flag in Codex CLI.

For bonus primitives:

- Instar is AWARE of them via the per-framework specs.
- Instar OPPORTUNISTICALLY USES them when running on a framework that has them — extracts the optimal-leverage value.
- On frameworks that lack them, the bonus simply doesn't apply (no promise, no emulation expected).
- Agent self-awareness surfaces them: when the agent is on a framework that has a bonus capability relevant to the user's intent, it knows about it and can suggest using it.

The reason bonus primitives exist as a separate class is honesty: not everything one framework can do should become Instar's universal commitment. Bonus is "Instar will leverage when available," not "Instar will guarantee everywhere."

## The structural design

### Layer 1 — Functional Components (Required + Bonus)

Each component is an Instar-recognized abstraction. The catalog is the source of truth for what Instar treats as a primitive. Each entry has:

- A definition (what it is, what it does).
- Required-or-bonus classification.
- A canonical source shape (framework-agnostic master representation, for required components).
- A capability matrix entry per framework.
- A rendering rule per supporting framework.
- A parity invariant (what "in-sync" means for the parity sentinel).
- For required components only: an Instar-native fallback implementation (the gap-filler).

Required primitive catalog (initial draft — to refine):

| Primitive | One-line definition |
|---|---|
| **Skill** | A reusable behavioral capability — markdown + scripts — discoverable as `/<name>` and triggerable by natural language. |
| **Agent** | A spawnable persona with its own session state, identity, and instruction file. |
| **Hook** | A program-defined response to a lifecycle event (session-start, pre-compact, file-change, etc.). |
| **Tool** | A capability the agent can invoke during a turn (bash, file edit, web fetch, MCP server, etc.). |
| **Memory** | Persistent state that survives session restarts (AGENT.md / MEMORY.md / USER.md / topic memory). |
| **Instruction file** | Framework-loaded markdown that defines the agent's identity + system prompt augmentation. |
| **Session-resume** | The mechanism for restoring a paused conversation. |
| **Slash-command or equivalent** | The user-side textual invocation surface. |
| **Messaging-platform integration** | Bidirectional, history-aware integration with the user-side messaging surface (Telegram, Slack, iMessage, WhatsApp). Covers outbound (agent → user), inbound (user → agent), and historical access (read prior conversation history scoped to platform-native containers — Telegram topic, Slack thread, iMessage chat). Consumed by session-resume and memory subsystems that need cross-platform history. |
| **Conversational action** | The agent's ability to interpret natural-language config intent → clarify → execute. |
| **MCP server registration** | Attaching external tool-server capability to the agent. |

Bonus primitive catalog (examples — discovered as we research each framework):

| Primitive | Framework | Definition |
|---|---|---|
| **Codex --oss local-provider** | Codex CLI | Direct flag for routing the model through Ollama / LM Studio without an external proxy. |
| (more added as discovered) | | |

### Layer 2 — Per-framework specs

For each component supported by a framework, a spec lives at `specs/frameworks/<framework>/<component>.md`. Captures:

- How that framework natively represents the component (filename, path, format, frontmatter, sibling files).
- What the framework discovers / loads / surfaces and how.
- Any pre-conditions (trust level, environment, version).
- Known quirks, version notes, observed-not-documented behaviors.
- For required primitives: whether this framework satisfies it natively or relies on Instar-native fallback.
- For bonus primitives: when and how Instar leverages them.

Updates on every new finding or framework version bump. These docs are the SOURCE OF TRUTH about that framework's specifics.

### Layer 3 — Capability matrix

A single `specs/instar-foundations/framework-capability-matrix.md` cross-references components × frameworks. Each cell is one of:

- **native** — the framework has it; Instar wraps.
- **instar-native** — the framework lacks it; Instar's own implementation fills the gap (required primitives only).
- **augmented** — the framework has a partial implementation; Instar's native fills the missing pieces.
- **bonus-available** — bonus primitive present in this framework; Instar opportunistically uses.
- **n/a** — bonus primitive absent; not promised.

When this cell changes (framework adds a feature, framework version regresses), the matrix updates. The parity sentinel reads the matrix to decide what to render vs what to flag.

"Impossible" is no longer a category for required primitives — Instar's native fallback ensures every required primitive is always satisfied. The category remains conceptually for bonus primitives a framework simply doesn't have, but that's marked `n/a`, not `impossible`.

### Layer 4 — The Parity Sentinel

The runtime enforcer. Reads the component registry + per-framework specs + capability matrix. For every (required-primitive × enabled-framework) pair, verifies the rendering exists and matches the canonical source (whether via framework-native wrap or Instar-native fallback). Emits events on drift; takes remediation action per the policy locked earlier (trust-level-mirrored auto-fix; conflict-surfacing for manual edits; sibling-file rendering for framework-specific extras).

Bonus primitives are also tracked but not "remediated" — the sentinel just maintains awareness of which are available where.

Already designed in detail in `specs/provider-portability/13-framework-parity-sentinel.md`.

### Layer 5 — Agent self-awareness

Every Instar agent's instruction file (CLAUDE.md / AGENTS.md / GEMINI.md) auto-renders two sections:

- **Required Capabilities** — every required primitive with one-line description + how to invoke. Identical content across frameworks; the rendering uses framework-appropriate examples.
- **Framework Bonuses** — bonus primitives currently available in this framework with one-line description + when to suggest them.

The agent uses this to: answer "what can I do" accurately, recognize natural-language intents that map to primitives, suggest creating new primitives ("you mentioned this twice — want me to make it a skill?"), and opportunistically leverage bonuses ("you're on Codex so we can use --oss for this private experiment").

Rendered by IdentityRenderer from the same registry the sentinel uses. Single source, multiple consumers.

## The long-term implication: Instar as framework

Once every required primitive has:

- An Instar-native fallback implementation (the gap-filler that runs when a framework lacks the primitive).
- At least one framework-native rendering for at least one supported framework.

…Instar IS, in fact, a generic agent framework. The substrate becomes optional: any model that can do basic tool-calling and instruction-following can power an Instar agent through the accumulated Instar-native fallback implementations.

Four paths to running Instar coexist in this future:

1. **Substrate passthrough** (today). Instar drives Claude Code or Codex CLI; the substrate handles model interaction.

2. **Codex --oss passthrough** (v1.0.0). Local models via Codex's open-model flag. Shipping.

3. **Free-claude-code passthrough** (next). Community project re-implementing Claude Code's flow on open models. Alternative substrate; same Instar abstractions.

4. **Instar-native runtime** (eventual, naturally emerges from completing all Instar-native fallbacks). Instar drives the model directly — no substrate framework.

Each path has its tradeoffs. Functional parity is the architecture that lets ALL of them coexist with consistent agent experience.

## Sentinel-specific implications

The Parity Sentinel (already designed) reads from this layered registry and:

- Validates every required (primitive × enabled-framework) cell is properly rendered.
- Detects drift between canonical source and rendered output.
- Renders missing framework-native or Instar-native fallback implementations on framework-enable.
- Mirrors user-initiated changes (new skill, edited memory) across all enabled frameworks.
- Surfaces bonus primitives to the agent self-awareness layer without enforcing them.

When a new framework is researched and added, the work is exactly: write per-framework specs for each required primitive + classify each bonus they offer + add their entries to the capability matrix. Zero changes to the abstract registry; zero changes to other frameworks' renderings.

## Pacing proposal

1. Lock the foundational principle (this doc, revision 2).
2. Refine the required-primitive catalog (one round of input).
3. Write the Skill prototype end-to-end (instar-concepts/skill.md + frameworks/claude-code/skills.md + frameworks/codex-cli/skills.md + parity-rule + e2e tests). Validate the shape.
4. Instantiate remaining required primitives in priority order — Hook next (since the Codex hooks correction means it's worth establishing the pattern cleanly), then Agent, Tool, Memory.
5. Build the parity sentinel as designed once 3+ primitives have rules; reuses the registry.
6. Layer agent self-awareness on top.

## Companion docs

- `specs/instar-foundations/required-primitives-inventory.md` — the formal Required Primitives list with Instar-native fallback implementation status for each (already-built / partial / not-yet-built).
- `specs/provider-portability/13-framework-parity-sentinel.md` — detailed sentinel design.

## Corrections to revision 4

- **Locked the required-primitive catalog** based on Justin's 2026-05-18 weigh-in. Hook is required. MCP-server registration is bonus for now. Conversational-action is its own primitive (locked the foundational stance: users explore + change every aspect of Instar conversationally; agent has high self-awareness + active guidance responsibility). Memory stays as one primitive but is flagged as a watch item. Session-resume stays as its own primitive.
- **Renamed primitive #9 from "Outbound relay" to "Messaging-platform integration"** with expanded scope covering outbound + inbound + historical access. The reframe closes a quiet implicit dependency from session-resume (needs to read prior conversation context from the right platform/topic) and from memory subsystems (e.g., rolling-topic-summary sentinels that consume per-platform message history). Cross-primitive references added to entries #5 (Memory) and #7 (Session-resume).

## Corrections to revision 2

- Added the explicit **three-layer model** (Layer 3 functional primitives ↔ Layer 2 substrate primitives ↔ Layer 1 framework adapters) so the relationship between this doc and the v1.0 provider-portability primitives inventory is no longer implicit.
- Added the **StallTriageNurse worked example** showing how a sentinel's LLM access is sourced — Layer-3 Hook requests a Layer-2 substrate primitive which is satisfied by the configured Layer-1 adapter.
- Stated the **architectural promise**: any framework satisfying the v1.0 substrate primitive set automatically supports all required Layer-3 functional primitives. New framework adoption is a Layer-1 effort, not a rewrite.
- Added a **"What is NOT a functional primitive"** section drawing the line between Layer-3 primitives and the context-engineering strategies that live *inside* the Memory primitive (recursive trees, knowledge graphs, semantic search, playbook). Stops primitive-catalog inflation and clarifies why those strategies are independent of the parity discussion.

## Corrections to revision 1

- Removed the incorrect claim that Codex lacks lifecycle hooks. Codex 0.130 has its own hooks system (configured via `hooks.json` in the project's `.agent/openai/` directory). Hook is a required primitive that both frameworks satisfy natively, with different file shapes.
- Replaced "feature equivalence to most capable framework" framing with the cleaner required-vs-bonus distinction. Required primitives are uniform; bonuses are framework-specific opportunism.
- Clarified that "impossible" is no longer a capability-matrix category for required primitives — Instar-native fallback always exists by definition for required primitives.
