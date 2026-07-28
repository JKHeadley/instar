# Model-Registry Current-Pins Correction — Plain-English Overview

> The one-line version: point the "most capable" model slots at the models that are actually current — Gemini 3.1 Pro, Claude Opus 4.8 — instead of the older IDs they had drifted to, and mark the registry freshness guard's flagged items as resolved.

## The problem in one breath

Instar picks which AI model runs each internal job by looking up a small table of "for the heavy/capable tier, use model X." Those IDs quietly go out of date: the Gemini capable slot still said `gemini-2.5-pro` long after Gemini 3-class models shipped, and two different internal Claude tables disagreed about the current Opus (one said `claude-opus-4-6`, the running default is `claude-opus-4-8`). A stale pin is invisible until it silently gives you worse results than the model you could have used.

## What already exists

- **Per-provider tier tables** — tiny maps that turn an abstract tier (`fast` / `balanced` / `capable`) into a concrete model ID, one per provider "door" (Claude, the Claude background/headless path, Gemini, Codex).
- **A freshness guard** — a lint (`scripts/lint-model-registry-freshness.mjs`) plus a manifest that, on every CI run, checks two things: the pins were reviewed recently, and each pinned "capable" model is on that door's approved-frontier list. It shipped in report-only mode and had two pins flagged as "known-stale, waiting for the operator to confirm the replacement."
- **The routing registry doc** (`docs/LLM-ROUTING-REGISTRY.md`) — the human-readable "what model each thing defaults to" reference.

## What this adds

Nothing new is built — this is a correction of existing values. The Gemini capable pin moves from `gemini-2.5-pro` to `gemini-3.1-pro-preview` (the current top usable Pro, verified reachable this session via the Gemini CLI, OpenRouter, and a paid Gemini key). The Claude Opus ID is reconciled everywhere to `claude-opus-4-8` (the running default and current canonical Opus), fixing the `opus-4-6`↔`opus-4-8` disagreement. The Codex/OpenAI capable pin was already `gpt-5.5` (the GA flagship) and is left exactly as-is — the preview-only `gpt-5.6-sol` is deliberately NOT pinned. The freshness manifest's approved-frontier list is updated to match the new pins, and both of its flagged-stale items are recorded as resolved so the guard stops flagging them.

## The pieces touched

- **Gemini adapter tier map** — `capable` now resolves to `gemini-3.1-pro-preview`; `gemini-2.5-pro` stays a recognized/spawnable model and a capacity fallback.
- **Claude tier maps** — `src/core/models.ts` and the anthropic-headless adapter now agree on `claude-opus-4-8` for the Opus/capable tier.
- **Framework session launch** — the Gemini capable/opus launch resolution mirrors the adapter (`gemini-3.1-pro-preview`).
- **Freshness manifest + routing doc** — allowlist entries updated to match, flagged-stale block emptied (both prior pending pins resolved), the capable-row and caveat in the doc corrected.

## The safeguards

**Nothing is silently removed.** `gemini-2.5-pro` is kept in the known-Gemini set, so it is still a valid model to spawn or fall back to — only the "capable/frontier" pointer moves.

**The guard confirms the fix.** After the change the freshness lint passes cleanly in both report and strict mode with zero findings and zero warnings — the flagged-stale noise is gone because the underlying pins are now current.

**No new decision authority.** This change adds no gate, filter, or block. It only edits which model ID a lookup returns; every behavior that consumes those IDs is unchanged in shape.

## What ships when

This is a single small change that ships as one PR: the pin edits, the manifest/doc updates, and the handful of test assertions that encoded the old IDs, all together. Rolling it back is a plain revert of the one commit.
