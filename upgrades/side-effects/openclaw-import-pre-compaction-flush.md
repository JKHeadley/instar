# Side-Effects Review — Pre-Compaction Memory Flush

Spec: `docs/specs/OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.md`
ELI16: `docs/specs/OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.eli16.md`
Driving approval: Telegram topic 9003, Justin, 2026-05-13.

## What's IN

1. New `src/core/PreCompactionFlush.ts` — pure class with `handle(payload)` method, fact parser, file writer, audit logger.
2. New `tests/unit/PreCompactionFlush.test.ts` — 16 assertions covering all 9 outcomes + parsing variants + slug coercion + audit shape.
3. Wired into `src/commands/server.ts` directly after the `compactionSentinel.report` PreCompact listener. Conditional on `config.preCompactionFlush.enabled === true`.
4. Default config off (`enabled: false`). Operators flip to opt in.
5. Audit log at `<projectDir>/.instar/audit/pre-compaction-flush.jsonl` for every fire.
6. Per-fact memory files written under `<projectDir>/.instar/memory/learning_precompact_*.md`.
7. MEMORY.md index entries under a `## Pre-Compaction Saves` section (best effort; only if MEMORY.md exists).

## What's DEFERRED

- **Per-model knob.** Could pin flush to Haiku-class or local Ollama independent of session's main model. Current design uses the shared intelligence provider (subscription default). Tracked as v2 enhancement; no demonstrated need today.
- **Cross-session dedup.** Repeated flushes may write similar facts. Memory consumers tolerate near-duplicates on read; explicit dedup is v2.
- **Option B (in-session silent turn).** Considered; rejected for v1 because user-visible outcome is identical and server-side is simpler/lower-risk. Recorded as possible v2 refinement.
- **Migration to existing agents' settings.json.** Not needed — the change is server-side, hooked via the existing PreCompact event that all agents already report. New agents and existing agents benefit equally on the next instar update.

## Over-block analysis

The new behavior:
- Writes at most 5 files per compaction event (each capped at ~700 bytes after frontmatter).
- Appends one block of ≤5 lines to `MEMORY.md` per fire.
- Sends a single LLM call per fire, prompt body capped at ~31 KB (30 KB transcript + ~1 KB instruction).

No file ever gets overwritten — slugs include the flush timestamp, so collisions across two flushes within the same second produce two distinct files. No risk of clobbering existing memory entries.

If the LLM goes haywire (returns 100 facts), `maxFactsPerFlush` caps the writes at 5. If a fact slug coerces to empty after sanitization, that fact is dropped (asserted in test).

## Under-block analysis

When the LLM returns `NONE` or `[]`, the flush exits at `no-facts`. This is the correct under-block — the prompt explicitly invites this response when nothing durable surfaces. No false-positive memory pollution.

When the LLM returns garbage, the flush exits at `parse-failure` with the truncated response captured in audit. The user's MEMORY.md is not polluted.

## Level-of-abstraction fit

- **`PreCompactionFlush` is a single class.** All flush logic — transcript reading, prompt construction, parsing, file writes, audit — lives in one file. Testable in isolation.
- **Wired into server.ts at the existing PreCompact event listener block.** ~22 lines of new wiring code, conditional on config. The class is loaded via dynamic `await import` so the cold-path cost is zero when disabled.
- **No new HTTP endpoints, no new hook scripts.** The change rides on existing infrastructure (HookEventReceiver, hook-event-reporter.js, shared intelligence). One new listener, one new class.

This is the minimal vertical that delivers the user-visible win. Anything larger would be premature.

## Signal-vs-authority compliance

The flush itself is an **authority** path (it writes durable files). Signal-vs-authority is preserved by:
- The LLM is asked to make a *signal-quality* judgment (which facts are durable).
- The class enforces **hard caps** as the **authority** layer (max facts, max length, slug coercion, write-or-audit). No LLM output ever bypasses the caps.
- A bad LLM call can't damage the user's memory — only audit junk surfaces.

## Interactions

- **`CompactionSentinel`** (post-compaction recovery): unchanged. Both run on the same PreCompact event but in independent listeners. The Sentinel handles re-injection AFTER compaction; this class handles flush BEFORE compaction. They don't race because the Sentinel's work is keyed on a 10-second post-compaction delay (line 4477).
- **`HookEventReceiver`**: emits PreCompact unchanged. New listener does not modify the event payload or the emitter's behaviour.
- **`shared intelligence`** (PR #198 chokepoint): used per the subscription-by-default contract. If `sharedIntelligence` is null (e.g., CLI unavailable + no API opt-in), flush audits `no-intelligence` and exits.
- **MEMORY.md**: appended under a dedicated `## Pre-Compaction Saves` heading. If that heading does not exist, it is created at the file tail. Pre-existing memory entries are untouched.
- **`.instar/memory/` directory**: new files only; existing files untouched.
- **`.instar/audit/`**: new jsonl file; existing audit files untouched.

## Rollback cost

- `config.preCompactionFlush.enabled: false` reverts to legacy behaviour. The class stays in the codebase but the listener is never registered.
- Files already written to `.instar/memory/learning_precompact_*.md` are harmless markdown — they can be reviewed and deleted at the operator's discretion.
- Audit jsonl can be moved aside or deleted at any time.
- No schema migrations, no state mutations beyond memory files.

## CI surface

Touched:
- `src/core/PreCompactionFlush.ts` — new file, fully covered by 16 unit tests.
- `src/commands/server.ts` — 22 lines of new wiring inside the existing compaction block. The path is gated on config, so existing server-startup tests (which don't enable the new flag) exercise the gate-off branch.

No CI workflow changes. No husky changes. No native module changes.

## Open questions

None. The design is fully constrained by:
- OpenClaw's documented pattern (audit doc §3).
- Justin's approval of "Option A — server-side, agent-noninterruptive."
- Existing PR #198 safety-guard contract for the intelligence provider.
