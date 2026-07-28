# ELI16 — Pin the interactive session lane to a pool account (B1)

## The setup

You can give the agent several Claude logins and pool them. Each login has its own
usage limit. To spread work across the pool — and to rescue a session when the
login it's on fills up — every session needs a little tag that says *which login it
is running on*. Without that tag, the auto-swapper has nothing to grab onto: it
can't move a session it can't identify.

## The gap this fixes

When pooling is turned on, the agent's *background* sessions (scheduled jobs,
helper one-shots) already launched under a chosen pool login and got that tag. But
the **session you actually chat with over Telegram** did not. It launched on the
default login with no tag. So if that login was the one getting full, your own
conversation was the one session the swapper couldn't directly move — it could only
be rescued by a slower fallback that figures out the account after the fact. The
session you talk to most was the least protected.

## What changed

The user-facing interactive session now pins exactly like the background ones do.
At launch, when pooling is on, it asks the same account-picker the background lane
uses, launches under that login's home, and records the tag. Now your conversation
is first-class: the swapper can move it directly the moment its login gets close to
full, instead of waiting for the fallback.

## The safety details

- If the agent explicitly asked for a specific login (the mid-conversation account
  swap already does this), that choice always wins — the picker is only consulted
  when nobody pinned a login.
- It only applies to Claude sessions — a Codex or Pi session is never put on a
  Claude pool login.
- It does nothing at all unless pooling is turned on. With pooling off, your
  conversation launches on the default login exactly as before.
- Before launching on a pool login, the agent makes sure that login's home is
  ready for an interactive window (the onboarding flags are seeded), so it can't
  get stuck on a first-launch wizard — the failure we hit and fixed earlier.

## Why it's safe to ship on

It reuses machinery that's already live and proven (the same picker, the same
onboarding-safety seeding, the same tagging the background lane uses). No new
on-by-default behavior, no new switch — it rides the existing pooling switch. With
pooling off it is a complete no-op.
