# Privacy & Ethics Review: GitHub Collaboration Monitor (Round 2)

**Reviewer**: Privacy & Ethics Specialist
**Round**: 2
**Date**: 2026-03-29
**Spec Version**: Revision 2 (updated 2026-03-29)
**Prior Synthesis**: 20260329-153418

---

## Approval Status: CONDITIONAL APPROVE

Round 2 addressed the four privacy blockers from Round 1. The spec now has a data retention policy, a right-to-erasure procedure, a contributor disclosure comment, and a documented quality override in the trust model. All were listed as P1 in the Round 1 synthesis. What remains are implementation gaps and a GDPR legal basis question that is structural to any system processing public GitHub data. No new critical blockers introduced.

**Score: 7.5 / 10** (up from 6.5 in Round 1)

---

## What Changed Since Round 1

| Issue | Round 1 Status | Round 2 Status |
|-------|---------------|----------------|
| No data retention policy | MISSING | ADDRESSED — `contributorRetentionDays: 180`, audit log 90d, skip ledger 30d |
| No right-to-erasure path | MISSING | ADDRESSED — documented in Data Retention section and edge cases table |
| No contributor disclosure | MISSING | ADDRESSED — first-review disclosure comment template added |
| Trust model fairness | PARTIAL | IMPROVED — quality override via `trustOverride: "trusted"` added |
| GDPR legal basis | NOT ADDRESSED | STILL MISSING |
| Anonymization implementation detail | NOT ADDRESSED | STILL MISSING |

---

## Detailed Findings

### 1. GDPR Legal Basis — Still Unaddressed (HIGH)

**The issue**: The spec processes personal data (GitHub usernames, commit histories, contribution patterns, written PR descriptions) about EU-based contributors. Processing requires a lawful legal basis under GDPR Article 6.

**Current spec language**: "Contributor data (usernames, emails) handled per GitHub's public API — no private data accessed."

**Why this is insufficient**: Public availability does not equal freely processable. GDPR Recital 47 and Article 6(1)(f) — legitimate interests — can apply, but only if:
1. The legitimate interest is documented
2. A balancing test is performed against contributor fundamental rights
3. Contributors can object (right to object, Article 21)

The spec documents none of this. The right-to-erasure section covers deletion on request but does not establish what legitimate interest justified processing in the first place. This gap creates a technical legal exposure if a EU-based contributor challenges data processing.

**Recommended fix**: Add a one-paragraph legal basis statement to the Data Retention section:

> This system processes GitHub public API data (usernames, contribution history) under legitimate interests (GDPR Art. 6(1)(f)): maintaining software security, coordinating open-source collaboration, and ensuring code quality. Contributors can object to automated processing or request erasure as documented below. Processing is limited to publicly disclosed activity on a public repository.

This does not require a lawyer — it documents an existing legitimate interest. The disclosure comment already partially serves this purpose. Formalizing it in the spec closes the gap.

---

### 2. Retention Policy — Correctly Scoped, Implementation Unspecified (MEDIUM)

**What's good**: Three distinct retention tiers are now defined:
- Contributor trust data: 180 days since last activity
- Audit log: 90 days (compress and archive)
- Skip ledger: 30 days after PR close/merge

The 180-day window for contributor data is appropriate — it avoids erasing trust context for contributors who contribute seasonally (e.g., once every 4-6 months) while still enforcing data minimization.

**What's missing**: The spec says data is "anonymized (username → hash)" at expiry but does not specify:

1. **Which hash function**: A simple SHA-256 of the GitHub username is not anonymization — GitHub usernames are public and the hash is reversible by anyone with the username. True anonymization requires a keyed HMAC or a randomly-salted hash that cannot be correlated back to the original. The spec should state: "anonymize using a randomly-salted per-deployment hash (not deterministic from public data)."

2. **What fields are retained post-anonymization**: After anonymization, does the system retain `mergedPRCount`, `avgDiffLines`, `firstContributionAt`, `lastMergedAt`? If so, a sufficiently active contributor is re-identifiable from the aggregate. The spec should enumerate which fields survive anonymization and verify they cannot be used to re-identify.

3. **Archive format for audit logs**: "Compressed and archived" does not specify where or whether the archive is still subject to erasure requests. If archived logs are stored indefinitely in a cold archive, the 90-day retention is effectively nominal.

**Recommended fix**: Specify hash function (randomly-salted), enumerate surviving fields, and confirm archive destruction aligns with erasure requests.

---

### 3. Right to Erasure — Procedure Exists, Channel Is Weak (MEDIUM)

**What's good**: The procedure is now documented — trust profile deleted, audit log entries anonymized, skip ledger entries purged. The edge cases table includes "Contributor requests data erasure" as a handled scenario. CONTRIBUTING.md is named as the documentation home.

**Remaining concern**: The erasure request channel is "via issue or email." This creates two problems:

1. **Issue as erasure channel**: A GitHub issue is a public record. A contributor requesting erasure of their personal data should not have to create a public record to do so. Issues on public repos are indexed by search engines. This contradicts the purpose of the right to erasure and could deter legitimate requests.

2. **No response SLA**: GDPR Article 12 requires a response within one calendar month. The spec has no SLA commitment or tracking mechanism for erasure requests.

**Recommended fix**: Change the channel to email only (e.g., a maintainer contact address). Add a response commitment ("We respond within 30 days") to CONTRIBUTING.md. Note that the email channel can be relayed to Echo via Telegram so Justin can action it quickly.

---

### 4. Contributor Disclosure Comment — Well Designed, One Gap (LOW)

The disclosure comment template is substantively good. It correctly:
- Identifies the system as AI-generated ("powered by Claude")
- Clarifies authority (advisory, not final)
- Explains reply limits and escalation to human
- Points to CONTRIBUTING.md for trust level documentation

**One gap**: The disclosure does not mention data processing. A contributor reading the disclosure knows Echo will review their code but not that their contribution history is being stored and that a trust score is being built. This is a meaningful piece of information — a contributor might make different choices about contributing if they knew their activity was being tracked.

**Recommended addition to disclosure comment**:

> Note: I track contribution history to calibrate review depth over time. This data is retained for up to 180 days. You can request deletion at any time — see CONTRIBUTING.md for details.

This is two sentences. It closes the gap without making the disclosure feel legalistic.

---

### 5. Trust Model Fairness — Quality Override Is Good, But One-Way (MEDIUM)

**What's improved**: The addition of `trustOverride: "trusted"` via `POST /relationships/{id}` gives Justin a path to recognize high-quality one-time contributors. This directly addresses the Round 1 fairness concern where the 5+ PR threshold would permanently disadvantage someone who contributes a single excellent PR.

**Remaining concern**: The override is one-way — there is no documented path for the inverse: a `trustOverride: "blocked"` or `trustOverride: "flagged"` for contributors who have not yet triggered the revocation mechanism but show a concerning pattern. This asymmetry is not a blocker, but it means the trust model has a gap in the hostile contributor path.

More substantively: the spec does not address how `trustOverride: "trusted"` interacts with the security-sensitive path rule. The spec says "always `needs-review` regardless of contributor trust" for security paths. Does a trust override bypass this? It should not. The spec should explicitly state that `trustOverride: "trusted"` does NOT bypass the security-sensitive path rule — those paths are always `needs-review` regardless of manual override.

**Recommended fix**: Add one sentence to the trust model section: "Trust overrides do not exempt contributors from security-sensitive path review — those PRs always require deep review regardless of trust level."

---

### 6. Memory.md as Storage — Unretained Personal Data Leak (LOW)

The spec includes: "Notable contributor interactions saved to MEMORY.md for future context."

MEMORY.md is a persistent, unstructured memory file that has no defined retention policy, no anonymization path, and is not subject to the retention controls described in the Data Retention section. This creates an uncontrolled data store where contributor usernames, PR content, and interaction summaries can accumulate indefinitely outside the retention framework.

**Recommended fix**: Add to the Data Retention section: "MEMORY.md entries referencing specific contributors are subject to the same 180-day retention window. On erasure request, contributor mentions in MEMORY.md are redacted." Alternatively, keep MEMORY.md entries to aggregate patterns (e.g., "contributor X is strong on type safety") rather than timestamped raw interactions.

---

### 7. GDPR Data Minimization — Relationships API Fields (LOW)

The Relationships API stores: `{ trustLevel, mergedPRCount, lastMergedAt, lastRevertedAt, firstContributionAt, avgDiffLines }`.

These fields are proportionate and appropriate for the trust model. No concern here.

However, the spec also mentions storing data for bot accounts in the `trustedBotAccounts` config. Bot accounts are not natural persons and are not subject to GDPR — no issue, just worth noting that the retention policy should clarify that `trustedBotAccounts` are config entries, not relationship records, and exempt from the erasure procedure.

---

## GDPR Compliance Summary

| GDPR Requirement | Status | Notes |
|-----------------|--------|-------|
| Lawful basis (Art. 6) | NOT MET | Legitimate interests applicable but not documented |
| Data minimization (Art. 5(1)(c)) | MET | Retention tiers are proportionate |
| Storage limitation (Art. 5(1)(e)) | MOSTLY MET | 180d/90d/30d tiers defined; archive destruction unclear |
| Accuracy (Art. 5(1)(d)) | MET | Trust data updates on new activity |
| Right to erasure (Art. 17) | MOSTLY MET | Procedure exists; request channel creates public record |
| Right to object (Art. 21) | NOT MET | No explicit opt-out from automated processing |
| Transparency (Art. 13/14) | MOSTLY MET | Disclosure comment exists; data processing not disclosed |
| Security (Art. 32) | MET | Token separation, audit logging, structured prompts |

**GDPR overall**: Structurally sound but missing legal basis documentation and right to object. These are documentation gaps, not architectural ones — they can be addressed in CONTRIBUTING.md without code changes.

---

## Ethical Assessment

**Automated review systems on open-source contributors raise specific ethical concerns beyond GDPR compliance:**

1. **Chilling effect**: Contributors who know their code is being automatically triaged and scored may self-censor contributions, avoid unfamiliar areas, or pad contribution counts to reach trust thresholds. The public documentation of trust criteria in CONTRIBUTING.md partially mitigates this — transparency reduces the chilling effect compared to opaque systems.

2. **Fairness across contributor demographics**: The trust threshold (5+ PRs over 30+ days) structurally disadvantages contributors who are domain experts contributing once (e.g., a security researcher fixing a vulnerability), contributors from time zones where English is not a first language (more likely to get `request-changes` for documentation style), and contributors who contribute large single PRs rather than incremental work. The quality override mitigates the first case. The second and third cases are not addressed.

3. **AI review authority**: The disclosure comment correctly states reviews are "advisory" and Justin makes final decisions. This framing is accurate and ethically appropriate for the current design (auto-merge disabled by default). If auto-merge is enabled in the future, the ethical calculus changes — contributors would be receiving binding automated decisions affecting their ability to contribute. At that point, the system would need to comply with GDPR Article 22 (automated decision-making) and offer human review on request.

4. **Reply round limits**: The 2-reply-round limit after which Echo stops responding is reasonable operationally but should be transparent to contributors. The disclosure comment mentions it, which is appropriate. The current wording is good: "Feel free to ask questions — I'll respond to up to 2 reply rounds, then tag a human."

---

## Recommendations (Prioritized)

| Priority | Action | Effort | Blocker? |
|----------|--------|--------|----------|
| P1 | Add GDPR legitimate interests statement to Data Retention section | Low | No |
| P1 | Change erasure request channel from GitHub issues to email; add 30-day response commitment | Low | No |
| P1 | Specify anonymization hash function (randomly-salted HMAC, not plain SHA-256) | Low | No |
| P1 | Clarify that `trustOverride: "trusted"` does not bypass security-sensitive path review | Low | No |
| P2 | Add two-sentence data processing notice to first-review disclosure comment | Low | No |
| P2 | Add MEMORY.md entries to the retention policy scope | Low | No |
| P2 | Add right-to-object language to CONTRIBUTING.md | Low | No |
| P2 | Enumerate which Relationships API fields survive anonymization post-retention window | Low | No |
| P3 | Document archive destruction policy for compressed audit logs | Low | No |
| P3 | Consider GDPR Art. 22 compliance path for future auto-merge enablement | Medium | No |

---

## Conclusion

The spec made meaningful progress on privacy between rounds. The retention tiers are reasonable. The disclosure comment is well-designed. The right-to-erasure procedure exists. The quality override addresses the most acute trust model fairness concern.

What remains is primarily documentation work, not architectural changes. The GDPR legal basis gap is the highest-priority item — it is a two-paragraph addition to CONTRIBUTING.md, not a redesign. The anonymization hash function specification is a one-line implementation detail that prevents a subtle de-anonymization vulnerability.

No changes in Round 2 introduced new privacy risks. The system is trending toward deployable. The P1 items above should be resolved before the system runs against live GitHub data and before any contributor receives a disclosure comment.

**Recommended progression**: Address P1 items (all low-effort documentation changes), then deploy in recommend-only mode. Auto-merge enablement should trigger a fresh privacy review under GDPR Article 22 automated decision-making rules.

---

*Privacy & Ethics Specialist — Round 2 of specreview multi-agent analysis. 2026-03-29.*
