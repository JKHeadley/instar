# Convergence Report — Codex creates only Lifeline

## ELI10 Overview

Last test install ended up with two "Dashboard" topics in the
Telegram group. Cause: the Codex setup flow created all 4 system
topics, and the instar server also creates 3 of them on boot.
Lifeline didn't duplicate (Codex saves its ID, server reuses);
the other three did, because Codex doesn't save their IDs.

Fix: Codex creates only Lifeline. The server creates Dashboard,
Updates, and Attention like it already does. One creator per
topic. No duplicates.

The missing dashboard link was a separate issue — Cloudflare was
rate-limiting the quick tunnel (429), so there was no URL to post.
Not a code bug. Two follow-up asks from Justin (notify the user on
tunnel failure, keep a backup tunnel pool) are tracked separately.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self + Justin's screenshot + live config probe | 1 | Codex creates only Lifeline |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Finding 1 — Duplicate Dashboard topic from dual creation.**

- Verified via the live instar-codey config: `config.dashboardTopicId
  = 14` (the server's "📢 Dashboard") and a separate Codex-created
  "📊 Dashboard" with no config reference.
- Severity: medium (confusing UX, orphan topic).
- Resolution: Codex prompt steps 13 + 14 rewritten to create +
  seed only Lifeline; explicit instruction not to create the
  other three; orientation message tells the user the rest appear
  on server boot.

## Convergence verdict

Converged at iteration 2. Prompt-content-only change; server-side
topic ownership unchanged; reduces drift surface (Codex no longer
hard-codes 3 topics' names/colors). 81 wizard tests pass.
