# Convergence Report — Tool (Layer-3 primitive)

## ELI10 Overview

A **Tool** is something the model can do during a turn (read a file, run a shell command, fetch a URL). Tools come for free with whichever framework is running (Claude Code provides Read/Edit/Bash; Codex CLI provides view/apply_patch/shell). Instar doesn't implement tools — but it does need a way for skills, agents, and other primitives to declare *which tools they can use* in a way that means the same thing on both frameworks.

That's what this spec is: a canonical tool-name vocabulary (`read`, `bash`, `web-fetch`, `mcp:server:tool`) and a mapping table to each framework's native naming. v0.1 ships the table as code (`toolNameMapping.ts`) so other primitives can import it when they render their `allowed-tools` fields.

What changes for the user: nothing visible yet. This unblocks the deferred `allowed-tools` rendering in Skill v0.2 — skills will be able to declare tool restrictions canonically and have them render correctly on whichever framework the agent is routed to.

## Original vs Converged

The first draft proposed a full per-instance parity rule with verify + remediate. Convergence surfaced the architectural reality: Tools aren't user-authored artifacts in the way Skills or Hooks are. There's no `.instar/tools/<name>/` directory to mirror to a framework. The cross-framework concern is a *vocabulary lookup*, not a *per-instance rendering*.

The converged spec scopes v0.1 to the mapping table + helper functions, exported as code other renderers consume. No registry entry — the helpers are imported directly. This is the right level of abstraction for a substrate-bound primitive whose "instances" aren't user-authored.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | abbreviated (substrate-bound pattern) | 1 (rule shape wrong for substrate primitive) | Drop per-instance rule; ship mapping table as importable code |
| 2 | (converged — no material new issues) | 0 | none |

## Full Findings Catalog

**F1: Per-instance ParityRule is the wrong shape for a substrate-bound primitive** — Severity: high. Reviewer perspective: integration. Original: spec proposed a parity rule with verify/remediate/listInstances. Resolution: dropped the rule, shipped the mapping table + helpers as code that other renderers import. Registry has no Tool entry; consumers `import { renderCanonicalToolName }` directly.

## Convergence verdict

Converged at iteration 2. No material findings in the final round. The spec is approved (pre-authorized per hybrid C autonomous-mode agreement). Tool primitive ships its load-bearing artifact (the mapping table) and explicitly documents Skill v0.2's wiring as the next consumer.

## Deviation note

Pattern-instance + substrate-bound abbreviated convergence — Tool is the most directly substrate-bound of the required Layer-3 primitives. The convergence cycle's full reviewer perspectives have been baked into the canonical-source-of-truth + per-framework rendering pattern via Skill convergence; Tool's deviation from that pattern (no per-instance rendering) is itself the convergence finding.
