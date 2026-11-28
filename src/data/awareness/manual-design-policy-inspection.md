---
title: Manual Design Policy Inspection
---
When reviewing a change to screens or the Design Standard, `instar design:inspect --repo /path/to/repo --base BASE_COMMIT --head HEAD_COMMIT` reads both committed Git trees without running either tree's code. It reports standard structure, permanent rule identifiers, affected registered screens, unregistered UI sources, and changes to rules earned from feedback. Uncommitted files are excluded; the explicit base must be the trusted comparison commit.

This is a manual source inspection, not visual clearance or merge enforcement. Its JSON names what it checked and what it did not check. Exit 0 means only that the listed structural checks found no issue; exit 1 means findings or wording requiring independent review; exit 2 means the inspection was unavailable. Missing policy on the selected base, including a repository before this foundation was installed, is unavailable. Screenshots, accessibility, coverage and mode changes, feedback-entry lint, semantic wording review and owner waivers remain outside this command. Never use its result alone to approve or merge a UI change.

Add `--feedback` for optional committed feedback entry structure, rule links, changelog and history observations. This reads the complete feedback directory on both pinned trees. It does not authenticate messages, grant publication privacy clearance, verify feedback-card binding or activate complete feedback lint. Errors affect the manual command's findings and exit code; all merge authority remains false.
