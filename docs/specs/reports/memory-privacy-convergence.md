# Convergence Report — Memory privacy: a session loads only what the people it serves may see

**Spec:** [docs/specs/memory-privacy.md](../memory-privacy.md)
**Slug:** `memory-privacy`
**Iterations:** 4
**Final-round design findings:** 2 clarified, 1 declined with a reason (below). The brief said to cut to the smallest version after about 3 rounds that keep finding design problems, so the review stopped here.

## Cross-model review: codex-cli:gpt-6-astra

The external pass ran in all four rounds through the Codex CLI. Gemini was not signed in and Grok was not enabled. Dawn (Portal's agent) reviewed the design on Threadline at the operator's request.

## ELI10 Overview

When one Instar agent serves several people, everything it remembers sits in one pool. On a test agent, a fact one person told it privately was given to someone else. The cause was an ordinary file search, and copies of the same facts sit in logs, backups and transcripts, so hiding them store by store can't work.

This design gives each conversation an audience, decided by the place. A private chat serves one person; a channel or group serves everyone who can read it. Each audience has its own memory folder. Outside the owner's private chats, a session runs in an operating system sandbox and holds a limited key that the server refuses everywhere except a short list.

It costs recall: outside the owner's private chats the agent has no search-based memory and does not learn across people. If the sandbox can't start, the agent sends a fixed reply instead of running unprotected. An agent only one person can message is unchanged in that person's private places.

## Original vs Converged

- Originally the spec filtered each memory store and labelled every fact. After review the boundary is the session itself, because reviewers found the same facts in logs, attachments, backups, transcripts and `history.jsonl`, and a filter per store could never be complete. Most store labelling was cut.
- Originally the route guard listed memory routes and let everything else through. After review it is default deny, because the file viewer, session output and session input would all have reached another person's facts.
- Originally the proven leak was treated as a side case. After review the shell is a core control, because 136880 found the leak was a plain `grep` in Bash.
- Originally Telegram had private chats. After review a Telegram group is one shared place, because the adapter folds DMs into the group.
- Originally scope folders sat inside the agent home. After live testing they sit outside it, because a parent deny beats an allow and `dontAsk` auto-allows reads in the working directory.
- Originally `agent` was one catch-all. After review jobs are `system` and unknown is `none`, because the catch-all broke built-in jobs and let sessions pass facts through a shared folder.
- Added from operator direction: a named-people setting for Luna. Added from Dawn: a read with no audience is an error, no shared general folder, and a brand-new user in the standing regression.
- Added after review: an agent-to-agent session is refused on a multi-person agent, because a peer given owner reach could pull a person's fact out.

## Iteration Summary

| Iteration | Reviewers who flagged design | Design findings | Standards gate | Spec changes |
|---|---|---|---|---|
| 1 | security, adversarial, integration, scalability, decision-completeness, lessons, codex | 30 | ran (3 flags) | Rewritten around a session-level boundary |
| 2 | fresh internal reviewer, codex | 11 | ran (4 flags) | Whole-home deny, write boundary, inbox, reader count per place, scheduler notices |
| 3 | fresh internal reviewer, codex | 8 | not rerun | Peers, owner console spawns, count errors, hook wording, iMessage, versions |
| 4 | codex | 3 | not rerun | File-tool boundary and audience comparison clarified; one finding declined |

Internal lenses in round 1 ran as three combined reviewers rather than six. The clean-door `claude-code` family was not run.

## Contested finding

Codex round 4 asked that a one-person agent's existing Telegram group default to shared until its readers are proven. Declined: the brief requires single-person agents to behave exactly as today, and Telegram cannot list non-admin bots, so this default would take memory from real owners on update. The cost is stated in section 1: an unknown reader already in that group, or one replacing a member at an unchanged count, is not caught.

## Standards flags kept as accepted costs

Machine-local scope folders, no adapter for other frameworks, a fixed reply when the sandbox is unavailable, and status-only notices in shared places. All four are stated in the spec.

## Live checks that drove the design

On macOS, Claude Code 2.1.316, and Ubuntu 24.04 with real sessions: the per-session memory folder works; a single-slash deny rule does nothing; denying the agent home root stops `CLAUDE.md` loading; stock Ubuntu refuses the sandbox until an AppArmor profile is added.
