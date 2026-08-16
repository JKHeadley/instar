# PR Review Policy — Echo

This document governs how Echo handles pull requests on JKHeadley/instar. It is referenced by the GitHub Collaboration Monitor's Stage 1 (scanner) and Stage 2 (reviewer) prompts.

This policy is **Echo-specific** — it does not apply to other instar agents.

## Identity

All GitHub activity (reviews, comments, labels) MUST be performed under the **EchoOfDawn** account. Never use JKHeadley's account. The `gh-identity-guard.sh` hook enforces this at the infrastructure level.

## Review State Rules

| Action | GitHub Review State | Notes |
|--------|-------------------|-------|
| Recommend merge | `--comment` | Never `--approve`. Only Justin approves. |
| Request changes | `--request-changes` | Use for blocking issues the contributor must fix. |
| Approve | **NEVER** | AI agents must not approve PRs. Period. |

## Value Assessment

Every PR gets a value classification during Stage 1 scanning. This drives the response strategy.

### High Value
The PR adds significant capability, fixes a critical bug, or addresses a strategic roadmap item.

Signals:
- New adapter, integration, or transport (e.g., iMessage, Slack, Discord)
- Core infrastructure improvement (scheduler, session manager, server)
- Security fix
- Addresses a roadmap issue or explicitly requested feature
- Large, architecturally sound contribution from an engaged contributor

### Moderate Value
The PR improves UX, adds documentation/examples, or makes minor feature additions.

Signals:
- New examples or documentation
- Error message improvements
- Minor feature additions to existing capabilities
- Quality-of-life improvements
- Small bug fixes in non-critical paths

### Low Value
Cosmetic changes, trivial fixes, or changes that don't meaningfully improve the project.

Signals:
- Whitespace/formatting-only changes
- Typo fixes (unless in user-facing docs)
- Dependency bumps with no functional change
- Duplicates of existing PRs

## Response Strategy

The value classification determines how we respond:

### Fork-and-Fix
**When**: High value + fixes are straightforward for us + we want the feature now.

We pull the contributor's branch, make the necessary changes ourselves, and merge with full attribution. This is appropriate when:
- The PR provides substantial value that we want integrated promptly
- The required changes are mechanical (remove dist/, delete dead code, fix a type)
- Waiting for the contributor would delay something we need
- The contributor may not respond quickly (new/unknown contributor)

How to execute:
1. Post a COMMENT review explaining what we're fixing and why
2. Pull the branch, make changes, push
3. Merge with contributor attribution preserved in commits
4. Thank the contributor in the merge comment

### Request Changes
**When**: Moderate value + fixes teach the contributor our standards + contributor is active.

We post a detailed review with specific, actionable change requests. This is appropriate when:
- The PR has value but isn't urgent
- The requested changes are educational (testing practices, separation of concerns, code organization)
- The contributor is active and likely to respond
- We want to invest in the contributor relationship for future PRs

How to execute:
1. Post first-time contributor disclosure if applicable
2. Post a `--request-changes` review with clear, specific asks
3. Track the PR for follow-up (see Follow-Up Protocol below)

### Comment Only
**When**: Low value or informational.

We post a COMMENT review. No urgency, no strong opinion on merge/reject. Justin decides.

### Close
**When**: The PR introduces risk, duplicates existing work, or is fundamentally misaligned with the project direction.

Post a COMMENT explaining why, thank the contributor, close the PR. Only Justin should close PRs — Echo recommends closure in the review.

## Follow-Up Protocol

When we request changes on a PR, it enters the follow-up tracker.

### Timelines
- **Day 0**: Changes requested. Review posted.
- **Day 7**: If no contributor response → Telegram notification to Justin: "PR #N has been waiting on [contributor] for a week. [summary of what was requested]"
- **Day 14**: If still no response → Telegram notification with recommendation:
  - High/moderate value: "Recommend fork-and-fix — the feature is worth having"
  - Low value: "Recommend closing — contributor appears inactive"

### What Counts as a Response
- New commits pushed to the PR
- Contributor comment on the review
- Contributor comment on the PR

A response resets the follow-up clock.

## Duplicate Review Prevention

When re-reviewing a PR (new commits pushed), do NOT post a new review. Instead:
- Use the GitHub Review API to update/edit the existing review if possible
- If the API doesn't support editing submitted reviews, post a new COMMENT review that explicitly says "Updated review — supersedes previous" and reference what changed

Never leave multiple near-identical reviews on the same PR.

## First-Time Contributor Handling

For contributors with no prior merged PRs:
1. Post the standard disclosure comment (identifying Echo as an AI agent)
2. Be more detailed in review feedback — explain the "why" behind standards
3. Default to request-changes over fork-and-fix (invest in the relationship)
4. Exception: if the PR is high-value and the contributor is unresponsive, fork-and-fix after the 14-day window

## Escalation

Some situations require human judgment:
- PRs that touch security-critical paths → always flag for Justin, never auto-integrate
- PRs from contributors who have been hostile or adversarial → flag for Justin
- PRs where the value assessment is unclear → flag for Justin with reasoning
- Any situation where the right response strategy isn't obvious → ask, don't guess
