<!-- bump: patch -->
## What Changed

A new `PreCompact` steering hook (`.instar/hooks/instar/pre-compact-steer.sh`, its own entry in `.claude/settings.json`, added on update) prints pre-rendered "keep these" instructions into Claude Code's compaction prompt. Claude Code adds a successful PreCompact hook's output to the instructions it summarizes with (verified on 2.1.321 and proven on a real compaction). The text is staged per session under `.instar/state/context-layers/_keep/` by a single writer and printed only when its recorded hash matches; the hook never writes its own text and can never block a compaction. Nothing stages text yet, so compactions behave exactly as before until the coming fold and standing-packet work uses it. Off with `contextBudget.compactionRecovery.enabled: false`. Fifth slice of the Context Budget: Layered Summaries spec.

## What to Tell Your User

When one of our long conversations gets compressed, I can now tell Claude what must survive the compression (the conversation's purpose, open items, work in flight). The coming pieces will start using it.

## Summary of New Capabilities

- Pre-rendered keep-instructions steer Claude Code's compaction summary, per session, hash-verified.
- Rollback: the `contextBudget.compactionRecovery.enabled` switch, or revert; a hook with nothing staged prints nothing.

## Evidence

- L7 on real Claude Code 2.1.321: a staged codeword appeared in the compaction's own summary; with the text tampered, nothing was added.
- Unit `tests/unit/pre-compact-steer.test.ts`, integration `tests/integration/pre-compact-steer-settings.test.ts`, e2e `tests/e2e/pre-compact-steer-lifecycle.test.ts`.
