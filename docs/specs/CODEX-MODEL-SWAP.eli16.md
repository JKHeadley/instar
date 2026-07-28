# Plain-English overview: auto-switch the codex model when its quota runs out

## What this is

A codex agent runs on a main model (like gpt-5.5). That model has a usage limit
with a weekly cap. When the weekly cap is used up, codex just starts failing and
the agent gets stuck. But codex also offers other models — and at least one of
them (a "Codex-Spark" tier) uses a SEPARATE quota bucket. So when the main
model's weekly quota is empty, you can keep working by switching to the other
model, which still has budget.

This change makes that switch automatic.

## How it decides

It reuses the usage reader we just added (the one behind `GET /codex/usage`),
which reads the real 5-hour and weekly limit numbers codex writes to disk. When
it's time to start a new codex session, the agent checks: is the weekly window
basically empty (at or below a small threshold, default 10% left), or has codex
flagged that a limit was actually hit? If so, it launches that session on the
backup model instead of the main one. A session that's already running can't
change models in the middle, so the switch happens at the next launch — which is
exactly the moment it matters.

## Why it's safe

- **Off by default.** Nothing happens unless an operator turns it on AND fills in
  which backup model to use. If it's off, the code doesn't even read the disk —
  zero extra work on the normal path.
- **It only picks a model.** It never blocks anything, never cancels a launch,
  and never touches a running session. If it can't read the usage for any reason,
  it just launches with the normal model. Fail-safe.
- **The backup model name is yours to set.** We deliberately did NOT hard-code
  "Codex-Spark" anywhere, because the exact model name and whether it works on
  your specific ChatGPT subscription is something only the account owner can
  confirm. You put the verified name in the config to arm the feature.

## What you need to decide

Two things, and only when you want to turn it on: (1) confirm the exact backup
model id that works on your codex subscription, and (2) set it (plus enabled:
true) in the agent's config. Until then this ships completely inert. If it ever
misbehaves, turning it off is just removing one config block — there's no data to
migrate and nothing to repair.

## How it connects to the other change

This is the second half of a pair. The first half made codex usage readable. This
half acts on it — automatically moving to a fresh-quota model when the main one is
spent — so a codex agent doesn't silently stall on a depleted weekly limit.
