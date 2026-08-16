# Privacy & Ethics Review — GitHub Collaboration Monitor

**Review ID**: 20260329-153418
**Round**: 1
**Reviewer**: Privacy & Ethics Specialist
**Spec**: github-collaboration-monitor.md
**Date**: 2026-03-29

---

## Approval Status: CONDITIONAL

The spec is thoughtful and shows genuine security awareness. However, it has meaningful gaps in consent, data retention, right-to-erasure, and the fairness properties of its trust scoring system. These are solvable — none require rearchitecting — but they must be addressed before the system goes live, especially given it operates against public GitHub profiles of real people who have not opted in to being profiled or scored.

---

## Research Findings

Before reviewing the spec, I conducted independent research into the privacy landscape for automated PR review bots and related systems.

**On automated review bots and contributor experience**: Research published through NSF and Springer Nature documents that review bot comments are frequently perceived as spam and unwelcoming by contributors. The technical and social impact on open-source communities is real. Contributors who receive automated rejection or "request-changes" reviews from a bot they didn't know existed often experience friction and confusion. This is not merely a UX concern — in privacy terms, it relates to the reasonable expectation of humans about who (or what) is evaluating their work.

**On GDPR and GitHub bots**: Open-source projects are not exempt from GDPR obligations. When a bot collects, stores, and processes contributor usernames, commit history, merge counts, and behavioral signals, that constitutes personal data processing under GDPR Article 4. GitHub itself acts as a data processor; any downstream agent that reads and stores derived data about individuals becomes an independent data controller. The "Right to be Forgotten" (Article 17) is a documented concern for OSS projects with bot-generated data trails.

**On trust scoring and bias**: 2025 AI bias research (including the certified collective action in Mobley v. Workday) demonstrates that algorithmic trust scoring systems can encode discrimination risks. A trust model that starts all unknown contributors at the same level sounds neutral but may disadvantage contributors who are less active on GitHub, who contribute infrequently due to time zone or language barriers, or who work in domains that generate large diffs by nature (e.g., internationalization, accessibility). Bias in trust systems can function as "moral cover" — appearing objective while perpetuating inequity.

**On AI-generated profiles stored externally**: GitHub's own March 2026 Privacy Statement updates highlight increased scrutiny of how interaction data is used to build profiles. Storing contributor behavioral profiles in a local relationships database (outside GitHub's own data handling framework) adds a layer that GitHub's privacy protections do not cover.

---

## Critical Issues

### 1. No Contributor Consent or Awareness Mechanism

The system monitors public GitHub activity and builds persistent behavioral profiles (trust scores, merge history, interaction patterns) on external contributors without their knowledge or consent. While public GitHub data is technically accessible, building and storing persistent derived profiles crosses from observation into profiling.

**Risk**: Under GDPR Article 22, automated decision-making that produces "legal or similarly significant effects" on a person requires explicit consent or another lawful basis. An automated review that blocks a PR merge or labels a contributor as untrusted could significantly affect their standing as an open-source contributor.

**Required fix**: Add a disclosure comment posted once per unique contributor when Echo first reviews their PR. Something like: "This repository uses an automated review assistant (Echo). Your contribution has been analyzed by an AI system. [Link to policy or README section explaining what data is stored and how to request deletion.]"

### 2. No Data Retention Policy

The spec defines how trust data accumulates (graduated from unknown → trusted, revocable on revert) but never specifies when or how contributor records are deleted. The relationships API stores: `trustLevel`, `mergedPRCount`, `lastMergedAt`, `lastRevertedAt`. This data can accumulate indefinitely.

**Risk**: Persistent profiling of individuals without a retention limit violates the data minimization principle (GDPR Article 5(1)(e): "kept in a form which permits identification of data subjects for no longer than is necessary").

**Required fix**: Define a retention policy. Suggested: contributor records with no PR activity in the past 12 months are archived (anonymized summary only) or deleted. Include this in the job config as `contributorRetentionDays: 365`.

### 3. No Right to Erasure / Data Access Path

The spec has no mechanism for a contributor to request deletion of their profile data or to see what has been stored about them.

**Risk**: GDPR Article 17 (right to erasure) applies when a data subject requests deletion and there is no overriding legitimate interest to retain the data. Without a deletion path, the system is non-compliant.

**Required fix**: Document in the PR disclosure comment that contributors can contact the repo maintainer to request data deletion. Internally, the relationships API should support a `DELETE /relationships/{contributor}` operation, and the audit log entries should be anonymizable (replace username with a hash) upon request.

### 4. Trust Model Fairness Not Defined

The trust graduation criteria ("2+ merged PRs with no reverts within 14 days") is a reasonable heuristic but it is opaque to contributors and potentially unfair to certain contributor types.

**Specific fairness concerns**:
- **Infrequent contributors**: A one-time fixer who submits a single critical bug fix and disappears will never reach `trusted` status, meaning their next contribution years later still gets full deep-review treatment even if their prior work was excellent.
- **Large-diff domains**: Contributors working on accessibility, i18n, or refactoring inherently produce large diffs. The `auto-integrate` path is permanently unavailable to them regardless of track record.
- **Bot account treatment**: The spec says bot PRs from known CI bots are `auto-integrate` but unknown bots are `needs-review`. This is reasonable, but the criteria for "known CI bot" is undefined — creating an invisible whitelist that contributors cannot see or appeal.
- **Revert-based revocation**: Trust can be "revoked if a merged PR is later reverted." Reverts happen for reasons unrelated to contributor quality (e.g., timing, architectural changes by the maintainer). Automatic trust revocation based on revert events conflates contributor error with maintainer decisions.

**Required fix**: Document the trust scoring criteria publicly (e.g., in a CONTRIBUTING.md section). Add a grace condition to revert-based revocation: only revoke trust if the revert commit message explicitly references contributor error, or require maintainer confirmation.

---

## Recommendations

### R1 — Contributor Disclosure Comment (High Priority)

When Echo posts its first review on any contributor's PR, include a footer section:

```
---
*This review was generated by Echo, an automated AI system.
What data we store: contributor username, PR history, and trust level.
Questions or deletion requests: tag @JKHeadley.*
```

This is a lightweight consent alternative — "notice" rather than explicit opt-in — which is appropriate given the public nature of GitHub activity. It substantially reduces GDPR risk without adding friction to the workflow.

### R2 — Retention Policy in Job Config

Add `contributorRetentionDays: 365` (or similar) to the job config. Stage 1 should check on each run for contributor records older than the retention window and flag them for archival or deletion. This is a minor addition that demonstrates good faith data minimization.

### R3 — Audit Log Anonymization Support

The audit log (`.instar/logs/github-review-decisions.jsonl`) stores PR numbers, classifications, recommendations, and signals. It should support anonymization on request: replace contributor usernames with a hash while preserving the statistical integrity of the log. This enables retention of operational data while honoring erasure requests.

### R4 — Trust Score Transparency

Add a section to the README or CONTRIBUTING.md explaining the trust model: what `unknown` vs `trusted` means, how graduation works, and what triggers revocation. This is not just a fairness measure — it reduces perceived hostility from contributors who receive automated `request-changes` reviews and don't understand why.

### R5 — Define "Known CI Bot" List

The edge case table mentions "PR from bot account: auto-integrate if from known CI bot." This whitelist should be explicit in the job config (e.g., `knownBots: ["dependabot[bot]", "renovate[bot]"]`) so it is auditable and not a hidden classification criterion.

### R6 — Revert Revocation Grace Condition

Modify the trust revocation logic: a revert alone does not revoke trust. Trust revocation requires either (a) maintainer explicit action, or (b) two or more reverts from the same contributor. This prevents a single unlucky timing event from permanently downgrading a trusted contributor.

---

## Observations

**The system is operating on public data — but public does not mean consent-given.** The legal basis for processing public GitHub data for the purposes described is arguably "legitimate interests" (GDPR Article 6(1)(f)), which is a defensible basis — but it requires a documented balancing test showing the system's interests don't override contributor privacy rights. No such documentation exists in the spec.

**The AI disclosure footer is already in the review comment template** — "Automated review by Echo... generated by an AI system." This is genuinely good. It satisfies the minimum transparency bar for the review itself. What's missing is the data profile disclosure: telling the person that a persistent profile of them is being maintained.

**Cross-border data transfer**: The spec stores contributor data locally (`.instar/` state directory) and syncs via Git. If the machine is in the US and contributors are in the EU, this is technically a cross-border data transfer of personal data. Under GDPR, this requires either a Standard Contractual Clause or adequacy decision coverage. In practice, for a small personal project, enforcement risk is low — but it is worth noting as a consideration if the system ever scales.

**Dual-use risk of the networking/relationship graph**: The Relationships API storing contributor interaction history could in principle be used to track individuals across projects. The spec scopes it to a single repo (JKHeadley/instar), which limits this risk significantly. If the system is ever generalized to multiple repos, this concern escalates substantially.

**The "informational" category and fork tracking**: Tracking forks and their divergence is passive monitoring of work people have done on their own copies of public code. This is legally unambiguous (public data) but ethically worth noting: a developer who forked the repo for personal learning and has no PR plans may not expect their fork to be analyzed and stored in a third-party system's database. The weekly cadence and activity filter (PushEvent in last 24 hours) are good mitigations.

---

## Scalability Assessment

At the current scale (one repo, limited external contributors), the privacy risks are manageable. The absence of retention policies and consent mechanisms is a gap, but not an acute one.

At 10x scale (multiple repos, dozens of active contributors): the trust profile database becomes a meaningful personal data asset. The lack of retention policy becomes a compliance liability. The absence of a right-to-erasure pathway becomes a legal exposure. The fairness concerns in the trust model become more statistically significant and legally relevant.

At 100x scale (if generalized as an instar capability used by many agents): this system would require a formal privacy impact assessment (PIA), explicit data processing agreements, and potentially appointment of a data protection officer depending on jurisdiction. The fairness issues in trust scoring would attract scrutiny similar to the AI bias cases currently in litigation (Mobley v. Workday).

The spec is appropriately scoped as "Echo-only" and "not a general instar capability" — this scoping decision is the most important privacy protection in the document. If that scope ever changes, a full privacy re-review is mandatory.

---

## Score: 6.5 / 10

**Justification**: The spec shows genuine privacy awareness — AI disclosure in review comments, audit logging, no access to private data, auto-merge disabled by default, security path gating. These are real, positive signals. Points are deducted for: absence of any contributor consent/notice mechanism (-1), no data retention policy (-1), no right-to-erasure path (-0.5), opaque trust model with fairness gaps (-0.5), no documentation of the legal basis for processing personal data (-0.5). The issues are all fixable without architectural change. With the recommendations applied, this would score 8.5/10.

---

## Summary

The GitHub Collaboration Monitor is a well-designed system with good security instincts. Its privacy gaps are not malicious — they're gaps of omission: the spec focuses on what the system does to code and doesn't fully reckon with what it does to people. Addressing the four critical issues (contributor disclosure, retention policy, erasure path, trust fairness documentation) would bring it into reasonable compliance posture for its current scope. The conditional approval stands pending these additions.
