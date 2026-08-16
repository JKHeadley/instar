# Cross-Model Synthesis: PR #30 iMessage Adapter

**Date:** 2026-03-31
**Models:** GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast

---

## Aggregate Scores

| Model | Score | Status |
|-------|-------|--------|
| Grok 4.1 Fast | 8/10 | CONDITIONAL |
| Gemini 3.1 Pro | 7.5/10 | CONDITIONAL |
| GPT 5.4 | 6/10 | CONDITIONAL |
| **Average** | **7.2/10** | |

---

## Consensus (All 3 models agree)

1. **Temp file security** -- world-readable, no cleanup, predictable names. All three flagged this as critical.
2. **Command/prompt injection** -- unsanitized message content flows into Claude sessions and shell scripts. All three identified this attack vector.
3. **Reply endpoint lacks recipient validation** -- GPT and Grok flagged explicitly; Gemini flagged the broader trust boundary issue.
4. **No durable checkpointing** for lastRowId -- restart replay risk. All three noted this.
5. **Architecture is fundamentally sound** -- all praised pattern reuse from Telegram, fail-closed auth, and bootstrap context design.

## Unique Findings (per model)

### GPT 5.4 (most security-focused)
- Command injection via unescaped `$RECIPIENT` in bootstrap shell snippets (not just the reply script)
- Apple platform fragility -- undocumented schema/TCC/FDA dependencies need explicit docs
- Strongest emphasis on hash collision risk in synthetic topic IDs

### Gemini 3.1 Pro (most architecture-focused)
- Prompt-to-shell execution vulnerability -- LLM executing `imessage-reply.sh` is itself a trust boundary
- Attachment table not joined despite `includeAttachments` config option being present
- Group chat handling completely undefined -- will behave unexpectedly

### Grok 4.1 Fast (most comprehensive)
- WAL/checkpoint handling gaps -- SQLITE_BUSY retry insufficient
- Key injection risk in `detectClaudePrompt` -- sending Down/Enter to consent dialogs without session validation
- Config lacks schema validation (no E.164 format enforcement for authorizedSenders)
- Most detailed scalability assessment across all phases

## Model Strengths

| Model | Best At | Weakest At |
|-------|---------|------------|
| GPT 5.4 | Security depth, injection analysis | Scalability (brief) |
| Gemini 3.1 Pro | Architecture patterns, trust boundaries | Got truncated at 4000 tokens |
| Grok 4.1 Fast | Comprehensive coverage, specific fixes | Slightly optimistic scoring |

## Divergence

- **Severity weighting**: GPT (6/10) was significantly harsher than Grok (8/10) on the same issues. GPT treats injection risks as near-blockers; Grok sees them as fixable within the current architecture.
- **Apple platform risk**: GPT and Gemini both flagged this prominently; Grok was more pragmatic about it.

---

## Combined Priority List (cross-model + internal review consensus)

Issues flagged by both internal reviewers AND external models carry the strongest signal:

| # | Issue | Internal Reviewers | External Models | Combined Signal |
|---|-------|--------------------|-----------------|----------------|
| 1 | Persist lastRowId | 7/8 | 3/3 | STRONGEST |
| 2 | Temp file security | 5/8 | 3/3 | STRONGEST |
| 3 | Session name collision | 6/8 | 1/3 | STRONG |
| 4 | Port 4040 bug | 4/8 | 0/3 | STRONG |
| 5 | Prompt/command injection | 3/8 | 3/3 | STRONG |
| 6 | Reply endpoint validation | 3/8 | 2/3 | STRONG |
| 7 | SQL-level auth filtering | 1/8 | 2/3 | MODERATE |
| 8 | PII in JSONL logs | 1/8 | 1/3 | MODERATE |
