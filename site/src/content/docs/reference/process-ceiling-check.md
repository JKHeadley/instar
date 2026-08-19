---
title: Process Ceiling Check
description: Why a machine can be running under a process limit that is too low even after the fix reaches it, and how instar notices and says so — ProcessCeilingCheck, the launchd NumberOfProcesses ceiling, and the raise-only migration.
---

Every macOS user account has a cap on how many processes it may run at once. Instar sets
one deliberately in its launchd agent, as a last-resort belt beneath the host spawn cap.

That belt shipped at 512 — a number sized against instar's own subprocess count, which is
the wrong denominator. `NumberOfProcesses` maps to `RLIMIT_NPROC`, which the kernel enforces
**per real UID**: every process the logged-in person owns, including the desktop, the
browser and the editor. An ordinary desktop idles around 500-550, so the belt sat below the
machine's idle floor and refused `fork()` on an otherwise quiet machine. On 2026-08-19 that
produced hours of intermittently-refused commands and then killed an agent server outright.

The ceiling is now 2048.

## What this belt is, and is not

It is a **UID fork-exhaustion backstop**. It catches a process-count explosion far beyond
anything a working system produces.

It is **not** an OOM-prevention control, and it does **not** catch the 2026-06-20 runaway
class (~230-289 concurrent LLM spawns). On a ~500-550 idle floor those total ~730-839,
comfortably under 2048 — and no value both clears the idle floor and trips before ~250
spawns exhaust memory at roughly 400MB each. The control that bounds that class is the host
spawn cap (`SpawnLimiter`, default 8 concurrent LLM subprocesses), which is unchanged.

2048 is an empirical default derived from observed fleet baselines, not a validated safe
minimum for every host. A heavy developer desktop running containers, parallel test runners
and several IDE helper trees may need more; both write paths are raise-only so an operator's
own higher value survives.

## Both write paths are raise-only

- `installAutoStart` (`src/commands/setup.ts`) REGENERATES the plist on install and re-run,
  so `preserveHigherProcessCeiling` carries a previous value forward when — and only when —
  it is strictly greater than the template's. A stale low value is replaced; a deliberate
  higher one survives.
- `PostUpdateMigrator.migrateLaunchdProcessCeiling` reaches already-deployed agents. It is
  floor-gated, idempotent, surgical rather than regenerative (hand-added keys and comments
  survive), and it deliberately does **not** reload launchd — forcing a reload would restart
  a running agent mid-update.

## Why the file is not the answer — `ProcessCeilingCheck`

launchd applies a raised ceiling only to what it starts **next**. So a migrated machine keeps
running the old ceiling until it restarts, and the corrected file on disk says nothing about
the running process. That gap is the 2026-08-19 incident: the plist was raised at 10:26 and
the machine kept crashing until 12:18, restarted only because the agent asked a human by
hand.

`ProcessCeilingCheck` (`src/core/ProcessCeilingCheck.ts`) closes it. At server boot on macOS
it reads the **live** soft `RLIMIT_NPROC` of the running process — from the process's own
report, not from any file instar wrote, and without spawning anything (the failure being
detected is precisely an inability to spawn). It then raises at most one deduped Attention
item:

| Live limit | Plist | Verdict | Priority | What the operator is told |
|---|---|---|---|---|
| below floor | at/above floor | `raise` | HIGH | Needs one restart to pick up the raised limit. |
| below floor | below / missing / half-raised | `repair` | HIGH | Unsafe, and a restart will **not** fix it — the correcting update has not arrived or did not complete. |
| at/above floor | below / missing / half-raised | `future-repair` | NORMAL | Fine now; a restart **may** lose that. No hurry. |
| at/above floor | at/above floor | `ok` | — | Nothing. |
| unreadable | any | `unknown` | — | Nothing — but always logged on macOS. |

Three properties are load-bearing:

- **Signal, never authority.** It raises a notice and can do nothing else — no restart, no
  `launchctl`, no gating. A wrong reading costs one wrong notice, never an outage.
- **Silence on uncertainty, but never invisible silence.** An unreadable limit yields
  `unknown` and no item, because a fabricated "healthy" would hide a real gap and a
  fabricated "broken" would nag every correct machine forever. On macOS — where it is
  supposed to work — that branch is always logged, so a reader that broke could not disable
  the check fleet-wide while still satisfying its no-item contract.
- **Claims only what it measures.** `future-repair` says a restart *may* lose the limit, not
  *will*: an absent or unparseable plist does not prove the next limit is low, since defaults
  or another launch path could apply.

Notices are deduped on the verdict, the machine id, the host fingerprint and the two numbers.
The host fingerprint is there because a machine-id collision would otherwise swallow the HIGH
notice for a machine that is actively crashing; with it, a collision costs a duplicate rather
than a silence. A machine that moves between verdicts (say `repair` to `raise` once the
migration lands) is re-told, because the required action changed.

None of the notices names a file, a key or a command — the action is "restart this machine",
which needs no terminal.

## Known gap

This verifies the **limit**, not the **headroom**. A machine sitting at 1900 of 2048 is close
to failing and reports `ok`. Measuring headroom means counting the UID's processes, which
means spawning one — the exact operation that fails when the limit is exhausted — so a
fork-based probe would return nothing precisely when it mattered and reassurance the rest of
the time. A non-forking count needs a native binding instar does not have; it is tracked, and
any future change to the ceiling value is blocked on it landing first, because a ceiling
change is exactly the decision that needs real baselines.

Spec: `docs/specs/launchd-process-ceiling-floor.md`.
