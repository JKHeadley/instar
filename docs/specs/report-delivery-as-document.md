---
title: Reports for a person are delivered as a document
slug: report-delivery-as-document
tier: 1
eli16-overview: docs/specs/report-delivery-as-document.eli16.md
parentPrinciple: Agent Awareness
---

# Reports for a person are delivered as a document

## Problem

On 2026-11-17 a session wrote a research report for the operator as a markdown file on a git branch and sent a GitHub file link (feedback fb-3bc8a879-2c7, intake entries intake-bridge-7c7e7be3cfd3 and intake-CORR-DaBombs-Mac-Studio-local-478). The operator expected a native document he could read and comment on in the app.

What the session read before it chose:

- The always-loaded Feature Proactivity rows in CLAUDE.md said "I produce research ... → Publish it (Telegraph for public, Private Viewer for private)" and "User mentions a document, file, or report → Use the private viewer". On an agent where documents serve, `POST /view` answers `409 documents-replace-views`, so the only route these rows named is closed.
- The Documents feature note lives in a reference file. The always-loaded file carries only its title in the capability index, so the session had no loaded text saying a report is a document.
- The new-agent identity template (principles 6 and 9) repeats the Private-Viewer-only wording.
- An older memory about GitHub-renderable review files (for PR reviews) leaned toward GitHub.

The session's transcript shows no attempt at either a view or a document: it wrote the file, pushed, and linked it.

## Change

1. `src/scaffold/templates.ts`: the two Feature Proactivity rows become document-first. A report, plan or research write-up for a person is made with `POST /docs` and its link is sent. The rows say a repo file sent as a GitHub link is for code review, not for a person reading a report. The Private Viewer stays the route only where documents are off (`503 documents-off`) or in Slack. The rows are exported constants, so the new-agent and existing-agent paths share one text.
2. Identity template principles 6 and 9 (new agents) say the same in one sentence each.
3. `src/core/PostUpdateMigrator.ts` `migrateClaudeMd`: each retired row, matched verbatim, is replaced with its current row. A row the agent edited is left alone. Running it twice changes nothing. The reference layout already rebuilds these rows from the template; the full layout needs this step.
4. `src/data/awareness/instar-documents.md`: the "When to use" line names the GitHub-link case.

## Decision points touched

None. This is instruction text only. No gate, hold, filter or block is added or changed.

## Why not an outbound link check

A link check at the outbound doorway (like the tone gate's B24 check for old `/view/` links) cannot tell a GitHub link to a report from a GitHub link to a pull request the person is asked to review, which is legitimate and frequent. Holding on the link shape would be a brittle check with blocking authority, and a phrase or pattern rule standing in for a judgment of meaning. The choice of where a report goes is held by the agent's judgment, which needs correct instructions. That is the simplest robust route, and this change gives it correct instructions.

## Rollback

Revert the commit. New agents get the old rows again. Existing agents that already ran the migration keep the new rows, which stay correct; nothing reads them as data.

## Questions for the operator

None. This raises no direction, value or policy question: it corrects instructions to match a feature the operator already approved.

## Review

Standards conformance check (`POST /spec/conformance-check`): 100 standards, 0 findings, parent fit "Agent Awareness". An independent reviewer found that existing agents' AGENT.md kept the old principle wording and that the Private Viewing closing line ignored documents; both are covered: `migrateAgentMdReportDelivery` replaces the retired AGENT.md wording verbatim, and the closing line is now document-first in CLAUDE.md and AGENT.md.
