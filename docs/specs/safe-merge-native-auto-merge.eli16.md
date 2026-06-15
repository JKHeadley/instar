# ELI16 — safe-merge gets a native auto-merge path (`--auto`)

## What this is, in plain English

`scripts/safe-merge.mjs` is the wrapper instar uses to merge its own PRs. Until
now it had one strategy: **poll** the PR's checks in a loop until they go green,
then merge with `gh pr merge --admin`. `--admin` force-merges, *bypassing*
GitHub's required-check enforcement — so the wrapper has to manually re-impose
all those checks (wait for green, confirm e2e ran, cross-check the required
contexts) to stay safe. That works, but it has a fatal operational flaw: the
poll has a **deadline**, and instar's CI takes ~15 minutes. When the wrapper
runs as a background watcher, the harness kills it at ~18 minutes — often
*before* the slow Build/E2E/Integration jobs finish. Result: `refused:
checks-timeout`, no merge, and a human (or another agent) has to come finish it
by hand. This is the single biggest source of the "merge took 2 hours" friction.

This change adds a second, **preferred** strategy: `--auto`. Instead of polling,
it asks GitHub to do the waiting — it arms **native auto-merge** (`gh pr merge
--auto`) and returns immediately. GitHub then merges the PR the instant every
required check passes. Native auto-merge **never bypasses a check** (so it's
strictly safer than `--admin` — there's nothing to re-impose), and it **can't
time out** (GitHub waits as long as the checks take, even hours). Arm it and
walk away.

## What already exists vs what's new

- **Already exists (untouched):** the entire `--admin` synchronous path — the
  poll loop, the e2e-presence guard, the required-contexts producer-bound
  cross-check, the independent merge confirmation. Zero behavior change for any
  caller that doesn't pass `--auto`.
- **New:** a `--auto` flag. When set, the script runs only the cheap pre-flight
  (PR open? not a draft? head not moved past `--match-head-commit`?), arms
  native auto-merge, independently confirms it's armed (or already merged if the
  checks were green), and exits. New exit code `5 = auto-merge-armed` (distinct
  from `0 = merged-confirmed`, because "armed" honestly is *not yet merged*).
- **Guard:** `--auto` and `--admin` together are a **usage error** — they're
  contradictory strategies (native enforcement vs bypass-then-re-impose), so the
  strict argv parser refuses the incoherent combo loudly instead of silently
  picking one.

## The safeguards, in plain terms

- Native auto-merge only merges when GitHub's branch protection (all 12 required
  checks) is satisfied — the script is not trusting itself, it's delegating to
  the platform's own gate. There is no `--admin` bypass on this path.
- The same "never trust the exit code alone" confirmation the `--admin` path
  uses applies here: after arming, the script re-reads the PR and only reports
  `auto-merge-armed` if GitHub actually shows it armed (or `merged` if it already
  landed). A `gh` success with nothing armed is reported as an honest error, not
  a false success.
- Head-pinning carries over: `--auto --match-head-commit <sha>` arms auto-merge
  bound to that exact commit, so a head that moves cancels the arming rather than
  merging something unverified.

## What the reader needs to decide

Nothing irreversible. This is an **additive** flag on a dev-only script; the
existing `--admin` path is the untouched fallback for repos where "Allow
auto-merge" is disabled. The follow-up (separately spec'd) is switching the
green-pr-automerge watcher (`MergeRunner`) to use `--auto` so the automated path
also stops timing out — that's a semantic change to that feature and is **not**
in this PR.
