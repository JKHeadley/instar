---
title: Skill-driven sign-in repair
description: On a Mac, a short-lived agent session signs a subscription back in the way a person would; the server alone decides whether it worked.
---

When a Claude Code or Codex subscription gets signed out, Instar's automatic sign-in repair
can bring it back. On macOS, with `subscriptionPool.assistedRelogin.navigation: agent-session`,
the browser part of that repair is done by **one short-lived agent session** that follows the
`/subscription-signin` skill (section 3 and its "Agent-run repair" subsection). It looks at the
screen, clicks and types in the account's own normal Chrome, just as a person at the machine would.
It works where the fixed page rules used to stop: Chrome's first-run window, a Google popup, and
permissions pages that are worded slightly differently.

## What the server keeps

- **One helper per machine.** `SubscriptionReloginHelper` holds the machine's browser seat lease.
  It waits (without spending an attempt) while another repair or browser drive has it, or while the
  session limit is full. The operator's approval is kept alive while the repair waits its turn, up to
  60 minutes.
- **A healthy helper account.** The helper runs on another account on the same Mac, never the one
  being repaired. That account must have just made a real authenticated call; for Codex it must also
  pass the CLI's own login check (`CodexLoginStatusChecker`). If no account qualifies, the repair
  waits on the operator, and the dashboard shows **Sign in** so it can be finished from a phone.
- **One small door back.** The helper hands the Claude code back through
  `POST /subscription-relogin/:episodeId/code`. That route is loopback-only, takes a per-episode token
  held only in memory, and accepts only three shapes: the code, a phone-tap request, or a macOS
  permission report.
- **Success is measured, never claimed.** The login must complete, the signed-in email must match,
  and a real call using the account must work. A helper that stops without finishing ends the repair
  as `agent-sign-in-unfinished`.
- **A time limit.** The helper is capped at 15 minutes (less if the login link expires sooner) and is
  shut down on every exit.

Approval is always required on this path. Set `navigation` back to `agent` or `closed` to roll back.

## Is the account really signed in?

`GET /subscription-pool` shows `loginCheck` (`ok`, `signed-out` or `unavailable`) next to each
account's status:

- A Codex account counts as signed in only after a **live** read from the Codex app server. Its
  local usage file is history, not proof.
- A Codex account turns `needs-reauth` when the Codex CLI and the live read both say it is signed
  out, on two polls at least five minutes apart. A network failure never counts.
- Claude's status command is never used as proof, because it reports "signed in" for expired
  sessions. Claude's signal is the authenticated usage read.

A repair that is still waiting after the account was signed in some other way is closed
automatically as `resolved-elsewhere`, once the server has verified the account.
