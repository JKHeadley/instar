# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

Two pieces of Codex-parity hardening on the enforcement-hook layer, both within
the approved spec (`docs/specs/codex-enforcement-hook-layer.md`):

1. **Scope-coherence checkpoint now runs on Codex.** `installCodexHooks` wires
   `scope-coherence-checkpoint.js` into Codex's `Stop` event, joining the
   `response-review` + `deferral-detector` pair already there. This completes the
   spec §4.1 Stop mapping ("deferral / scope checkpoint → Stop") — previously only
   deferral was wired. The script is framework-neutral (reads stdin, POSTs to the
   local server) and Codex honors `{decision:"block", reason}` on `Stop` (verified
   in the 0.133 binary's `StopCommandOutputWire`), so it gives Codex agents the same
   structural "zoom out and re-read scope" grounding pause Claude agents get — not a
   hard termination. It defaults to approve and self-throttles (depth threshold +
   30-minute cooldown), so it cannot loop an autonomous run. Existing Codex agents
   pick it up on update: the script already ships via always-overwrite migration and
   `migrateHooks` re-runs `installCodexHooks` for codex-cli agents.

2. **A hook-contract drift canary** (`codexHookContractCanary.ts`). Layer A is an
   env-independent invariant lock: it asserts the Codex hook config still has the
   load-bearing shape that two earlier live silent-no-op bugs taught us to protect —
   the `.*` tool matcher (a bare `*` matches nothing), `dangerous-command-guard` on
   PreToolUse, and the full Stop review trio. A refactor that regresses any of these
   fails CI. Layer B is best-effort: when a real codex binary is resolvable, it reads
   the binary's embedded hook-event schema and confirms the events instar depends on
   are still declared (catching real Codex-side contract drift). No binary present →
   the binary layer skips rather than fails.

Also recorded honestly: a WIP that would have wired compaction-recovery to Codex's
`PostCompact` event was set aside after verifying against the 0.133 binary schema
that `PostCompact` has no `additionalContext` field — the only channel that
re-injects context into the model. It would have installed a hook that does nothing.
Codex compaction-recovery parity needs a different mechanism and is tracked.

## What to Tell Your User

- **Codex agents now get the same scope-grounding check Claude agents have**: "When
  I've been heads-down implementing for a long stretch, I now get a structural nudge
  to step back and re-check I'm building the right thing — on the Codex engine too,
  not just on Claude."
- **A watchdog for the Codex safety guards**: "There's now an automatic check that
  notices if the Codex safety guards ever stop firing or if Codex changes its format
  underneath us — so a guard can't silently turn into a no-op without us catching it."
- Nothing for you to do — both ship automatically on update.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Scope-coherence checkpoint on Codex Stop | Automatic (installed via init + update migration) |
| Codex hook-contract drift canary | Automatic (CI invariant lock; best-effort binary probe) |

## Evidence

- **Codex Stop schema honors `decision:block`**: verified directly against the
  codex-cli 0.133.0 binary — `strings` shows `StopCommandOutputWire` plus the error
  string `"Stop hook returned decision:block without a non-empty reason"`, confirming
  the block-with-reason contract the scope-coherence script relies on.
- **PostCompact cannot re-inject context** (why that WIP was dropped): the binary's
  `post-compact.command.output` schema enumerates only `continue/stopReason/`
  `suppressOutput/systemMessage` — no `additionalContext`. Only the `SessionStart`
  and `UserPromptSubmit` output wires carry `additionalContext`, and `SessionStart`
  triggers are `startup/resume/clear` (no `compact`). Verified by extracting the
  embedded JSON schema from the binary.
- **Tests**: `installCodexHooks.test.ts` 8 green (incl. new Stop-trio assertion);
  `codexHookContractCanary.test.ts` 6 green (layer-A invariants always asserted;
  layer-B skip-not-fail with no binary). `tsc` clean.
