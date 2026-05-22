# Upgrade Guide — v1.2.30 (Codex creates only Lifeline topic)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: duplicate Dashboard topic in the Codex Telegram setup.**

Real-user retest showed two "Dashboard" topics in the Telegram
group — one created by the Codex agentic flow (📊), one by the
instar server on boot (📢). The Codex flow was creating all four
system topics (Lifeline, Updates, Dashboard, Attention), but the
server ALSO creates Dashboard / Updates / Attention on its first
boot. They didn't coordinate, so Dashboard got made twice.

Lifeline never duplicated because the Codex flow persists its ID
and the server reuses it. The fix extends that pattern: the Codex
flow now creates ONLY Lifeline. The server creates Dashboard,
Updates, and Attention like it always has — with its own
canonical intros, emojis, colors, and the dashboard-link wiring.

The Lifeline orientation message now tells the user that "a few
more topics will appear automatically once my server starts," so
the brief single-topic state between Codex-done and server-boot
doesn't look incomplete.

Spec: `specs/dev-infrastructure/codex-only-lifeline-topic.md`.
ELI16: `specs/dev-infrastructure/codex-only-lifeline-topic.eli16.md`.
Side-effects: `upgrades/side-effects/fix-codex-only-lifeline-topic.md`.

## What to Tell Your User

The setup no longer creates a duplicate Dashboard topic. You'll
get one of each system topic, created by the part of instar that
owns it. The Lifeline topic now mentions that the other topics
appear automatically once your agent's server starts.

(Separately: if your dashboard link is missing, it's usually
because the Cloudflare tunnel can't connect — often a temporary
rate limit. Two follow-up improvements are planned: a clear
"tunnel couldn't connect" message in the Dashboard topic, and a
pool of backup tunnel providers.)

## Summary of New Capabilities

No new capabilities. Duplicate-topic bug fix.

## Evidence

Reproduction prior: live instar-codey config showed
`config.dashboardTopicId = 14` (server's "📢 Dashboard") plus a
separate Codex-created "📊 Dashboard" with no config reference.
The user's screenshot showed both in the chat list.

After fix: 81 wizard tests pass; the topic-creation canary now
asserts the prompt creates ONLY Lifeline and explicitly forbids
creating the other three. The retired Attention/Updates/Dashboard
color codes are no longer hard-coded in the prompt (only
Lifeline's remains).
