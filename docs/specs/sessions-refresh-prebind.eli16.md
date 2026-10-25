# Session Restart Answers Honestly — Plain-English Overview

> The one-line version: when you ask the server to restart a session it cannot restart, it now tells you so straight away instead of saying "scheduled" and quietly refusing afterwards.

## The problem in one breath

The "restart this session" request (POST /sessions/refresh) always answered "Refresh scheduled" before it checked whether the session could actually be restarted. If the caller used the wrong name — most often the friendly display name like "Jev" instead of the internal name "echo-jev" — the restart was refused half a second later, and the only record of that refusal was a line in the server log. The caller believed a restart was happening when nothing was. This was caught in practice (learning LRN-034, proposal EVO-025).

## What already exists

- **The restart orchestrator** — it looks up which Telegram topic (or Slack conversation) a session belongs to, finds the running session, enforces a per-session rate limit, then kills and respawns it with its conversation preserved. It always re-checks everything itself, so it never restarts the wrong thing.
- **The busy check before answering** — the route already asks "is this session in the middle of work?" before replying, and answers 409 "session-busy" if so. That shows answering early is already the pattern here.
- **The bulk restart route** — its sibling, restart-all, already resolves bindings before it answers, so its "scheduled" list is honest.

## What this adds

The route now asks the orchestrator one more question before it answers: "would you refuse this right now?" If the answer is yes, the caller gets the refusal immediately — a 409 with the reason code (not bound to a conversation, no such running session, a restart already in flight), or a 429 when the rate limit is used up. Only a request that passes these checks gets the 202 "scheduled" reply, exactly as before.

- When the name given is a session's display name, the refusal names the internal session name to use instead, e.g. "pass the tmux session name instead (echo-jev)".
- The early check is read-only: asking it never uses up rate-limit budget.

## The new pieces

- **An early refusal check on the orchestrator** — it runs the same lookup the real restart runs (binding, running session, in-flight, rate limit) and reports a refusal without changing anything. It is not allowed to kill, record, or restart anything; the real restart still repeats every check itself, so the early answer can only make the caller better informed, never make a restart happen that otherwise would not.

## The safeguards

**Prevents a false "scheduled".** A name that cannot be restarted can no longer receive a success reply; the caller sees the real reason.

**Prevents restarting the wrong session.** A display name is never silently translated to an internal name, because display names are not unique. The caller is told which name to use and decides.

**Prevents the check from changing behaviour.** The early check records nothing, so the rate limit and the real restart behave exactly as they did before for every request that passes.

## What ships when

One small change: the orchestrator gains the early check, the route calls it before answering, and tests cover both the refusal and the passing paths. Nothing to migrate; existing agents get it on update.

## What you actually need to decide

Nothing is needed from you — this is a small correctness fix to an existing route, shipped as a Tier 1 change: should a refused restart request say so immediately instead of claiming it was scheduled? (Yes.)
