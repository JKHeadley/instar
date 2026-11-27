# Session continuity trial side effects

This patch extends the scoped memory hygiene trial to the legacy scheduled session continuity skill. The two settings remain separate, and the memory hygiene job keeps its existing setting and history fields. No schedule or resident configuration is changed.

Under [Signal vs Authority](../../docs/signal-vs-authority.md), the usage record is evidence. The launcher applies the empty integration option on supported Claude paths. Missing skill or ledger, incompatible tooling, explicit integration policy, or an unsupported launch leaves the normal path in place. Bash and Skill remain available under the job's existing policy. The patch makes no changes to proposal authority, the skill, its prompt, or its result handling.

The local replay covers a completed 15-minute session with no retained artifact. Baseline and treatment both reach a simulated missing-artifact proposal. A retained artifact leaves the proposal count unchanged. Run history exposes first-request usage when the bound transcript survives and the ledger has read it. Tests use synthetic token counts. No live proposals or model trials were made.

Six saved baseline sessions used Bash and Skill and had a median first-request input of 81,012.5 tokens including cache. Removing the trial setting restores normal launch behavior for future occurrences while retaining existing evidence under the ordinary history policy.
