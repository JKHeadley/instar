# Worktree notices post on change, and automated sends skip intent extraction

## What Changed

The worktree monitor posted the same two notices ("Worktree activity detected
after session …" and "Stale worktrees detected") after almost every job
session and every five-minute scan. On 29 September that was 549 of 724
outbound messages, all about the same unmerged branches. It now remembers the
set of branches it last announced for each notice and posts only when that set
changes: a branch appears, or one resolves. A set that stays open is repeated
once a day. The remembered set is saved in
`state/worktree-monitor/announced.json`, so a restart does not post it again.
A failed send is not recorded, so the next scan retries it.

The topic-intent capture loop no longer sends `provenance: automation`
messages to the extractor LLM. That covers scheduler job sends and monitor,
sentinel and system notices. Those messages used about 64% of the extractor's
input tokens, and most of what they stored was repeated "unmerged branches"
facts. The check uses the structural provenance stamp set when a message is
sent, never the message text. User and agent conversation is extracted as
before, and so are unstamped legacy rows. The rolling topic summary still
includes automated messages, so the next conversational extraction still sees
them as context.

## Evidence

- A replay of the real 29 September message log through the new
  `captureTurn`: 549 worktree notices and 64 other automated rows skipped; all
  111 agent and 19 user rows extracted. That is 130 extractor calls instead of
  743.
- A replay of the same day's worktree notice texts under the new rule: 11 of
  549 would be sent, each because the flagged set changed.
- Unit, integration (`/hooks/worktrees/last-report`, `/telegram/reply` →
  capture metrics) and e2e tests cover both sides. The new tests fail when
  the new logic is disabled.

## What to Tell Your User

You'll see far fewer worktree reminders. A notice now means something changed,
and a branch that is still open gets one reminder a day.

## Summary of New Capabilities

- Worktree notices are sent only when the flagged set changes, with one reminder a day; `/hooks/worktrees/last-report` shows when an unchanged finding was suppressed.
- Automated messages are no longer run through topic-intent extraction.
