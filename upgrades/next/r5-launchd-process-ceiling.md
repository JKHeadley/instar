<!-- bump: patch -->

## What Changed

**The fork-bomb belt was set below a normal desktop's idle process count, so it fired at rest and
could take an agent server down.**

The belt shipped `NumberOfProcesses=512`, sized against instar's own subprocess count. That is the
wrong denominator: `NumberOfProcesses` maps to `RLIMIT_NPROC`, which the kernel enforces **per real
UID** across every process the logged-in user owns — browser tabs, editors, the GUI desktop, all of
it. A normal macOS desktop idles at ~500-550 user processes, so the belt sat **below the machine's
idle floor**.

The failure mode was not a bounded runaway. It was every `fork()` from an instar-supervised process
returning `EAGAIN` on an otherwise idle machine.

Observed live on a Mac Studio (2026-08-19): 531 uid processes against the 512 ceiling. Agent shell
commands were refused intermittently for hours, and then the agent server itself died on it:

```
[FATAL] Uncaught unhandledRejection — closing databases before crash:
        spawnSync ssh-keygen EAGAIN
libc++abi: terminating due to uncaught exception ... mutex lock failed
```

A safety limit that trips while the machine is at rest protects nothing; it just converts idle into
an outage.

The ceiling is now 2048 — ~1500 of headroom over that floor, far above anything the host spawn cap
admits (default 8 concurrent LLM subprocesses plus children), far below `kern.maxprocperuid` (10666
on macOS 15), and still well under the 2026-06-20 runaway (~230-289 concurrent spawns on top of the
floor). The belt keeps backstopping a non-compliant runaway; it stops firing at rest.

## The machine now tells you when it needs the restart

The corrected value only takes effect on a restart, and until now nothing said so — on the machine
where this was found, the only reason it got restarted is that the agent asked a human by hand.
Other machines would have had no such prompt.

At boot each machine now reads its own LIVE limit (not the file) and raises one deduped notice:

- **needs a restart** — the setting is corrected and only a restart is left.
- **needs looking at** — the machine is unsafe AND a restart would not help, because the
  correcting update has not reached it or did not complete.
- **fine now, but a restart may lose that** — lower priority; nothing is broken yet.

If the limit cannot be read at all, nothing is claimed and nothing is raised — but on macOS it is
always logged, so a broken reader cannot silently disable the check.

**Known gap, stated rather than hidden:** this verifies the LIMIT, not the HEADROOM. A machine at
1900 of 2048 reports fine. Measuring headroom means counting processes, which means starting one —
the exact operation that fails when the limit is exhausted — so a check built that way would go
quiet precisely when it mattered.

## Migration Parity

The template change reaches NEW agents via `setup`, so `migrateLaunchdProcessCeiling` reaches the
deployed ones. Both write paths are raise-only — `setup` REGENERATES the plist, so it needed the
same protection or a re-run would have silently reset an operator's deliberate raise. It is:

- **raise-only and floor-gated** — an operator who tuned theirs higher is never clobbered
- **idempotent** on re-run
- **surgical** rather than regenerating the plist, so hand-added keys survive
- deliberately **not** a launchd reload — the raised ceiling applies to what launchd starts next,
  and forcing a reload would restart a running agent mid-update

## Evidence

- `tests/unit/launchd-process-ceiling.test.ts` (24 tests) — raise-from-512, floor-gating a higher
  operator value, idempotency, surgical edit preserving unrelated keys, no-reload, the setup-path
  raise-only rule, and every plist form the change claims to no-op on (malformed XML, unparseable
  blob, decoy key, comments, duplicate keys, Soft/Hard ordering, deeper nesting).
- `tests/unit/process-ceiling-check.test.ts` (31 tests) — the live-process reading, all five
  verdict states, silence on every uncertain branch, and the notice text for each state.
- Confirmed on the affected machine: ceiling 512 → 2048, verified against the **live process** after
  restart rather than against the setting. Background jobs spawn normally again; the full test suite
  (49,478 cases) now runs to completion where it previously took the machine down.

## What to Tell Your User

- **If your agent has been intermittently unable to run commands, or its server has crashed for no
  visible reason, this was very likely the cause — and your other machines are probably still
  carrying it.** The limit only takes effect on a restart, so an affected machine needs one restart
  after updating. You no longer have to remember that: each machine now tells you when it is the
  one waiting.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Process ceiling sized above the host idle floor | Automatic for new agents via `setup`; deployed agents get it from `migrateLaunchdProcessCeiling` on update. Takes effect at the next restart. |
| Raise-only on BOTH write paths | Automatic. An operator-tuned ceiling above 2048 survives migration AND a `setup` re-run; hand-added plist keys survive the edit. |
| Each machine reports its own live limit | Automatic at boot. Raises one deduped notice when a machine still needs its restart, when a restart would not help, or when a restart may lose a currently-safe limit. |
