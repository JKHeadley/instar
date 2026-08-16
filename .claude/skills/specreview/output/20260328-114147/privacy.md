# Privacy & Ethics Review — Docs-Code Sync Job

**Review ID:** 20260328-114147
**Round:** 1
**Spec:** `specs/docs-code-sync.md`
**Reviewer:** Privacy & Ethics Specialist
**Date:** 2026-03-28

---

## Approval Status

**CONDITIONAL APPROVAL** — The spec is well-scoped and technically sound. No fundamental privacy violations exist. However, three issues require mitigation before first deploy: secret/credential exposure in diffs sent to LLMs, the absence of a secrets-scanning gate in Phase 1, and the implicit assumption that all code content is safe to transmit to external AI inference endpoints.

---

## Research Findings

Before writing this review, I researched the following:

### Privacy Implications of Automated Code Analysis (AI Processing Source Code)

Key finding: The "trust paradox" is well-established in the security community — AI tools need deep codebase access to be useful, but unrestricted access means credentials, PII, and proprietary logic get transmitted to inference endpoints you may not fully control. Even trusted platforms like GitHub Copilot have exhibited data leakage behavior. GDPR applies to any code containing personal data that AI systems process, with penalties up to EUR 35M or 7% of global revenue.

Specific risk: Hardcoded credentials, database connection strings, authentication tokens, and customer PII are commonly found in code diffs — even in "clean" codebases. Pre-commit hooks often catch these before commits, but once committed, they appear in `git diff` output verbatim.

### Ethical Considerations for AI Automated Documentation Modification

Key finding: A 2023 Stanford study found 35% of AI-generated code contained vulnerabilities copied from training data. For documentation, the equivalent risk is that AI-generated doc updates introduce inaccurate or misleading content without human review. By 2026, IDC forecasts 40% of enterprises will mandate "AI ethics audits" for AI-generated artifacts. The emerging norm is: AI-generated changes should be attributable (tagged in commits), reviewable (not auto-merged without traceability), and bounded (scoped to exactly what was requested, no more).

The spec's current auto-commit approach without any post-commit human approval window is at odds with this trend, particularly for safety-critical docs like `docs/context/safety.md`.

### Data Handling When Processing Code Diffs

Key finding: GDPR's data minimization principle requires collecting and processing only what is actually needed. Sending full diffs (including test files, configuration files, and comment blocks) to an LLM for triage exceeds what is strictly necessary. The spec's Phase 1 filter handles some of this, but the exclusion list is incomplete — it filters test files and generated files but does not filter files known to contain secrets (e.g., `.env.example`, configuration files with placeholder credentials, or any file matching secret-pattern heuristics).

Pre-commit hook automation scanning for secrets is now industry standard. GitGuardian detects 200+ secret types; GitHub's built-in scanning is on by default for public repos. The absence of equivalent scanning before sending diff content to LLMs is a gap.

### Regulatory Compliance Landscape (2026)

- **GDPR / EU AI Act**: If any code processed contains personal data (user records, emails, tokens associated with individuals), GDPR data minimization applies. The EU AI Act's requirements around automated decision-making are relevant when the system autonomously modifies documentation that shapes how other AI agents behave.
- **US State Privacy Laws (2025-2026 expansion)**: Multiple US state laws now require documentation of automated processing activities. Automated doc modification that affects AI agent behavior could fall under AI-specific disclosure requirements in states like Colorado and Connecticut.
- **SOC 2 / ISO 27001**: For teams operating under these frameworks, transmitting code diffs to external AI endpoints must be documented in the data processing inventory.

---

## Critical Issues

### CRIT-1: Diff Content May Contain Secrets Before LLM Transmission

**Severity: High**

The spec sends diff summaries and full diffs to Haiku (Phase 2b) and full code content to Sonnet (Phase 3). Phase 1 filters out test files and generated files, but does NOT filter for:
- Environment variable files (`.env`, `.env.example`, `.env.staging`)
- Configuration files with embedded credentials (common in `src/config/`, infrastructure code)
- Files containing API keys, tokens, or passwords even if not in the formal secrets store
- Log files accidentally committed
- Migration files that contain SQL with real data

If any of these appear in a commit between two checkpoint runs, their full content flows to the LLM.

**Recommendation:** Add a secrets-scanning gate at the end of Phase 1, before any LLM calls. Use a tool like `git-secrets`, `trufflehog`, or a simple regex pass over the diff output. If a diff chunk matches known secret patterns, redact or exclude it from the LLM payload. Add `.env*`, `*credentials*`, `*secret*`, `*.pem`, `*.key` to the default exclusion list regardless of other filters. Log a warning in the handoff notes when redaction occurs.

---

### CRIT-2: Full Current + Previous Code Sent to Sonnet Without Minimization

**Severity: High**

Phase 3 sends `{currentCodeContent}` and `{previousCodeContent}` to Sonnet for each stale doc update. This is the entire file content — not a targeted excerpt. For large files (common in `src/` directories), this:

1. Transmits significantly more data than necessary to an AI inference endpoint
2. Increases the surface area for accidental secret or PII exposure
3. Violates the data minimization principle under GDPR if any personal data is present in the code

**Recommendation:** Scope the code content sent to Sonnet to the specific function, class, or export that changed — not the full file. Phase 1 already extracts "function signatures changed, exports added/removed" — use those as anchors to extract the relevant code block (+/- 20 lines of context). This reduces token cost, reduces exposure, and is actually sufficient for the doc update task.

---

### CRIT-3: Auto-Commit of AI-Modified Safety and Security Documentation

**Severity: Medium-High**

The spec auto-commits Sonnet updates to `docs/context/safety.md` and CLAUDE.md files. These are safety-critical documents — they govern how other AI agents behave. An AI agent autonomously modifying the documentation that instructs other AI agents, without human review, is a meaningful risk:

- A hallucinated update to `docs/context/safety.md` could instruct agents to bypass safety checks they currently respect
- A mistaken CLAUDE.md update could change agent behavior across all sessions
- The auto-commit happens before any human has a chance to review

**Recommendation:** Create a two-tier commit strategy. Routine doc updates (API docs, feature docs, README sections) can auto-commit as currently specified. Updates to safety-critical files (`.instar/context/safety.md`, CLAUDE.md files, any file tagged `security: true` in the exclusion config) should instead stage the change and send an attention queue item or Telegram alert for human review before committing. The open question #1 in the spec already surfaces this tension — resolve it in favor of human review for safety-critical paths.

---

## Recommendations

### REC-1: Add Explicit Data Flow Documentation

The spec describes what data flows through each phase but does not document where that data goes at the LLM boundary. For operational hygiene and regulatory compliance, add a section documenting:
- Which AI model endpoint receives which data
- Whether inference calls are logged by the provider (Anthropic's default retention policy)
- Whether the agent operator has a data processing agreement in place with Anthropic

For a private, single-operator deployment like this one (Echo's personal instar instance), this is lower risk. But as instar scales to multi-user or enterprise deployment, this gap becomes significant. Establishing the pattern now is good practice.

### REC-2: Tag AI-Modified Commits Distinctly

The commit message format in the spec includes `Job: docs-code-sync` — this is good. Consider also adding a standard trailer to distinguish AI-authored commits:

```
Co-Authored-By: docs-code-sync <agent@echo.instar>
AI-Modified: true
```

This enables `git log --grep="AI-Modified: true"` to audit all AI-generated documentation changes. Aligns with emerging norms around AI attribution in automated commits (referenced in PMI/ISACA 2025 AI ethics guidelines).

### REC-3: Implement a Diff Audit Log

The state file currently logs `tokensUsed` and `docsUpdated` but does not log what specific diff content was sent to LLMs. For accountability, consider adding a redacted diff summary to the handoff notes — not the full diff, but a structural record of: which files, which line ranges, and whether any content was redacted due to secret detection. This creates an audit trail without retaining the sensitive content itself.

### REC-4: Scope the `docCodeMap` Privacy Exposure

The `docCodeMap` in the state file links documentation paths to source paths. If the state file is ever shared, synced across machines, or backed up to cloud storage, it reveals the structure of the codebase to anyone who can read the backup. This is low-risk for a private agent but worth noting for the multi-agent / multi-machine expansion path. Recommend that backup/sync processes treat `.instar/state/docs-code-sync.json` as a sensitive file (not world-readable, excluded from public backups).

### REC-5: UNCERTAIN Results Should Have a Review Timeout

The spec routes UNCERTAIN triage results to the handoff notes for human review. However, there is no timeout or escalation mechanism. If UNCERTAIN items accumulate across multiple runs without human attention, the doc corpus may silently drift. Recommend adding: if an UNCERTAIN item has appeared in handoff notes for more than N consecutive runs (suggest N=3), escalate to the attention queue or Telegram alert.

---

## Observations

### OBS-1: Consent and Transparency Are Implicitly Appropriate

This system operates on a single-operator private codebase (instar, authored by Justin). There is no third-party data subject whose consent is required. All code and documentation being analyzed was created by or for the operator. The consent question is well-handled by scope — this is not a multi-tenant or user-data-processing system.

### OBS-2: The Phase 1 Filter Design Is Ethically Sound

The decision to exclude `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, and `docs/research/` from automated modification is correct. These are documents where AI modifications would be particularly inappropriate — they reflect deliberate human decisions about community norms, security policies, and governance. The spec gets this right.

### OBS-3: Recursive AI Governance (CLAUDE.md Modification by AI)

The problem statement identifies CLAUDE.md staleness as an acute risk because agents use it as their primary decision interface. This framing is ethically significant — it means this system is an AI agent that modifies the instructions given to other AI agents. This is a recursive AI governance scenario. The spec handles it conservatively (never overwrite blindly, flag template changes for human review) but the broader ethical implication — that automated AI-driven doc updates can shift downstream AI behavior — deserves explicit acknowledgment and the mitigation in CRIT-3.

### OBS-4: Fairness and Bias Are Not Applicable at This Scope

Traditional fairness concerns (differential treatment of individuals, discriminatory outcomes) do not apply to this system. It operates on code and documentation, not on people. No fairness issues identified.

### OBS-5: Dual-Use Risk Is Low but Present

The grep-based doc discovery in Phase 2a builds a comprehensive map of which documentation references which code. This `docCodeMap` could theoretically be used to identify sensitive or undocumented functionality (the `knownUndocumented` list explicitly catalogs this). This is not a meaningful dual-use risk in the current deployment context, but if the tool were productized, the dependency map would need to be treated as a sensitive artifact.

---

## Scalability Assessment

From a privacy perspective, the current design scales well up to a single-operator, single-codebase deployment. The privacy risks escalate non-linearly if the system expands to:

1. **Multi-agent scope** (Open Question #3): Other agents' context docs contain agent-specific state and behavior. Automatically modifying them raises questions about cross-agent consent and whether a doc update for one agent context is appropriate for another. Recommend explicit opt-in scoping per agent, not global scan-all.

2. **Multi-user / enterprise deployment**: If instar is deployed for teams, code diffs will contain code written by multiple people. GDPR applies to git history as it contains names and emails of contributors. The LLM payload would need contributor PII stripped from diff metadata.

3. **Public repository scope**: If the system ever operates on public repos, the calculus changes significantly — diffs may contain user-submitted content, test fixtures with real PII, or reproduced third-party code under license. The current exclusion list is insufficient for this context.

The architecture's three-phase tiered design is privacy-preserving in principle — Phase 1 (zero LLM, pure git) handles the most data and transmits nothing. The LLM exposure is proportional to what actually changed. This is a good design choice that should be preserved as the system scales.

---

## Score

**7.5 / 10**

The spec demonstrates strong structural privacy thinking: tiered LLM access, targeted diff analysis, thoughtful exclusion lists, and clear scope boundaries. The major gap is the absence of a pre-LLM secrets scanning gate, which is table-stakes for any automated system that processes code diffs and transmits content to external AI endpoints. The auto-commit of safety-critical documentation without human review is the other significant concern. Both are fixable without architectural changes — they are policy and tooling gaps, not design flaws.

With CRIT-1 (secrets scanning gate), CRIT-2 (code content minimization), and CRIT-3 (two-tier commit strategy for safety-critical docs) addressed, this would score 9/10.

---

*Review conducted by Privacy & Ethics Specialist agent. Research sources: graphite.com AI coding privacy guide; Cyera legal risk analysis; ISACA 2025 AI ethics alignment; PMI AI ethics checklist; CNIL GDPR Developer Guide; secureprivacy.ai 2026 privacy laws; White & Case 2025-2026 privacy trends.*
