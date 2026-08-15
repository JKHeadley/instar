# llmBenchCoverage.ts wave-2 flips (prepared content for the routing-apply PR)

Replace the `// ── Wave 2 (sentinels/gates/extractors still to author) ──` block's
24 `{ pending: 'wave-2' }` entries with the following (wave-3 block unchanged).
The pinned shrink-only test (tests/unit/llm-bench-coverage-ratchet.test.ts) must
have its wave-2 pending set emptied in the same commit — graduating entries is
the allowed direction.

```ts
  // ── Covered by Wave 2 (authored 2026-07-02; tasks-wave2/ in the bench harness) ──
  InputGuard: { task: 'input-guard-coherence' },
  SessionActivitySentinel: { task: 'activity-digest' },
  StallTriageNurse: { task: 'stall-triage-diagnosis' },
  CommitmentSentinel: { task: 'commitment-detector' },
  PresenceProxy: { task: 'presence-tier3-stall' },
  ProjectDriftChecker: { task: 'project-drift-check' },
  TemporalCoherenceChecker: { task: 'temporal-coherence' },
  SessionWatchdog: { task: 'watchdog-stuck-judge' },
  ResumeQueueDrainer: { task: 'resume-sanity-check' },
  TopicIntentArcCheck: { task: 'arc-check-classify' },
  TelegramAdapter: { task: 'telegram-stall-confirm' },
  // SlackAdapter.confirmStallAlert builds a byte-identical prompt to
  // TelegramAdapter's (verified by diff) — same task id covers both
  // (precedent: CompletionEvaluator maps two surfaces to two ids).
  SlackAdapter: { task: 'telegram-stall-confirm' },
  PromptGate: { task: 'prompt-gate-detect' },
  UnjustifiedStopGate: { task: 'unjustified-stop-gate' },
  OverrideDetector: { task: 'override-detector' },
  TaskClassifier: { task: 'task-classifier' },
  ResumeValidator: { task: 'resume-validator' },
  SessionSummarySentinel: { task: 'session-summary-sentinel' },
  TopicIntentExtractor: { task: 'topic-intent-extractor' },

  // ── Wave-2 argued exemptions (evidence in tasks-wave2/SKIPPED.md) ──
  IntegrationGate: {
    exempt:
      'no LLM prompt of its own — delegates to JobReflector.reflect() (attribution JobReflector, tracked wave-3); zero intelligence.evaluate() calls in IntegrationGate.ts',
  },
  CoherenceGate: {
    exempt:
      'no callsite carries attribution CoherenceGate — all LLM calls flow through CoherenceReviewer.callApi() (incl. DynamicReviewer subclass), covered by gate-triage',
  },
  AutoApprover: {
    exempt:
      'mechanical key injection + audit logging, no LLM callsite; the upstream judgment is InputClassifier.classify(), covered by input-classifier',
  },
  InputDetector: {
    exempt:
      'attribution-manifest alias only (a legacy prompt-pattern matcher); the live InputDetector class in PromptGate.ts calls with attribution PromptGate, covered by prompt-gate-detect',
  },
  PromiseBeacon: {
    exempt:
      'no live LLM prompt — generateStatusLine/classifyProgress hooks are unwired at the construction site (server.ts); the enqueue path resolves templated strings; revisit if a generator is wired',
  },
```

Notes for the PR:
- 24 wave-2 pending entries → 19 covered (18 task files; SlackAdapter shares) + 5 exempt.
- Update the ratchet test's pinned wave-2 set to `[]` in the same commit.
- Evidence trail: tasks-wave2/SKIPPED.md (grep-verified rationales), commits
  cef22f135 + 5e5f9393d, wave2 run results (stamp `wave2`).
