# Silently-stopped trio — plain-English overview

> **One-line shape:** three independent gaps that all let an agent silently stop working without anyone noticing — the worktree convention only fixed half a problem, no detector exists for Claude Code's own "connection dropped" message, and no watchdog covers "agent was producing output and went quiet." All three close in one PR.

## What happened today

Three things failed in the same shape this week:

**Worktree convention left half a hole.** When I make a "worktree" off the instar repo, git puts the working files in a safe path under my agent home (good), but it keeps the per-worktree metadata (HEAD, branch info) inside the SOURCE repo's hidden .git folder. Every git command from the worktree has to read that metadata. macOS's sandbox revoked access to that source path mid-session today and every git command died. I lost about 20 minutes.

**No detector for Claude Code's own "socket dropped" message.** When Claude Code's connection to Anthropic drops mid-session, it prints "socket connection closed unexpectedly" and freezes. We have detectors for rate limits, quota errors, hundreds of patterns. Zero for that string. So when it happens, the session just sits there and nobody knows.

**Watchdog blind spot for "was working, went quiet."** A session that was actively producing output and then stops — without a long-running child process (so SessionWatchdog ignores it), without being topic-bound (so SessionMonitor ignores it), and without a user waiting for a reply (so PresenceProxy ignores it) — falls through every existing watchdog. That's the gsd-side echo session that went silent for an hour and sixteen minutes today.

All three are the same failure class: agent silently stopped doing work, nobody knows, no recovery fires, no alert reaches the user.

## What this change does

**A — WorktreeManager uses clone instead of worktree for cross-project work.** When I need a separate working copy of the instar repo (or any project outside agent home), the manager now does `git clone` instead of `git worktree add`. A clone is a fully self-contained repo with its own .git folder living entirely under agent home. macOS can revoke the source path and the clone keeps working. A one-time migration converts existing worktrees to clones on next update — your branches and uncommitted work survive.

**B — A new SocketDisconnectSentinel watches every active session for "socket connection closed unexpectedly" and similar disconnect strings.** When it fires, you get a plain-English Telegram message immediately ("name lost its connection to Claude Code, trying to recover"), then a recovery staircase — send Ctrl+C + Enter, wait, see if the session comes back. Four attempts; if it can't recover, escalate with a "want me to dig in?" alert. Mirrors the RateLimitSentinel pattern that already protects us against the rate-limit case.

**C — A new ActiveWorkSilenceSentinel watches every session in the registry, regardless of topic binding.** If a session had output recently and then hasn't produced output for 15 minutes, it tries one gentle nudge (an empty tmux send-keys to wake the pane), waits 30 seconds, and either sees the session unstick OR sends a tone-gated alert: "name was working and went quiet about X minutes ago. I tried a gentle nudge and nothing came back. Want me to dig in?"

All three alerts go through the same MessagingToneGate the rest of your outbound messaging uses, so they're guaranteed plain English with no jargon and always end in a yes/no question you can answer in one word.

## Why one PR

Per the no-deferrals rule we just shipped in PR #331 — and per your directive today — these three pieces are the same failure class. Shipping them separately would mean writing "B and C deferred for follow-up" in the spec, which is exactly the pattern we just banned. One PR, three layers, complete.

## What gets safer for every agent, not just for me

- Any agent on any machine whose Claude Code connection drops gets self-recovery + a Telegram heads-up within 15 seconds.
- Any agent that's working and then freezes for any reason gets an alert within 15 minutes — no need for the freeze to be "long-running process stuck" or "user is waiting."
- Any agent doing cross-project work in a worktree gets a self-contained checkout that the macOS sandbox can't kill mid-session.

## What's NOT in scope (the only tracked forward note)

The v3 Self-Healing Remediator's eventual absorption of these sentinels as Tier-3 probes — tracked at topic 3079. Until Tier 3 lands, these three layers are the minimum plumbing that close today's silently-stopped failure class.
