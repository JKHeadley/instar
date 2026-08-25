---
change_type: fix
---

## What Changed

The two host-level safety limits — the concurrent-test-suite bound and the concurrent-LLM-spawn cap
— trust their shared holders file only after establishing that the file lives on a host-local
filesystem. That question was answered solely from the `df -P` device-source column, which
recognises a filesystem as local only when it names a block device.

Four commonplace **local** Linux filesystems do not name one: `tmpfs` (Ubuntu's default `/tmp`),
`overlay` (every Docker container's root filesystem), `devtmpfs`, and `zfs` (which names a pool,
never a device). All four read as "possibly a shared network volume", and the two lanes then
degraded silently in **opposite directions**: the test-runner lane **fails open** — it admits the run
without a slot, so the bound reports itself present while guarding nothing — and the spawn lane
**fails closed** — it stops reclaiming dead holders, so the cap slowly clogs until it blocks
legitimate work. Neither announces itself.

`probeDfHostLocalDetailed` now takes a Linux-only second opinion: when the source column has not
already settled the question as local, the fstype for the path is resolved from `/proc/self/mounts`
and checked against an explicit allowlist. The new path can only ever **upgrade** `not-local` →
`local`, only for an allowlisted fstype, and only on Linux — macOS never reaches it, and an
unrecognised fstype keeps the existing fail-closed verdict untouched.

The pool-name *shape* is deliberately not pattern-matched. A ZFS pool (`rpool/ROOT/x`) and a FUSE
cloud bucket (`my-bucket`) are shape-identical and one of them is genuinely remote; only the fstype
separates them, which is the argument for fixing this at the fstype layer rather than with a broader
regex. `9p`/`drvfs` (WSL's mount of the Windows drive) and `virtiofs` remain rejected **on purpose**
— same physical machine, but the exclusive-create and rename semantics these limits depend on are
not dependable across them. Previously they were rejected for the wrong reason; now they are absent
from the allowlist with that reason written down.

## Evidence

Found on the first non-CI Linux host — WSL2 / Ubuntu 26.04, where `/tmp` is `tmpfs`. The live
signature is the limiter announcing its own disarmament: `[test-runner-bound] WARN: admitted WITHOUT
a slot (fail-open: df-not-local)`. Before the change that host failed 30 tests across three limiter
files (`host-test-runner-semaphore` 13, `test-runner-bound-meta` 14, `test-runner-limiter-route` 3);
after it, all three pass — 132 unit and 29 integration tests green on that host.

GitHub's Ubuntu runners mount `/tmp` on the ordinary root disk, so `df` reports a `/dev`-backed
source there and the check passes by accident. CI has been green on Linux for as long as it has run
on Linux and has never once exercised this path — which is why the defect needed a real Linux
machine to surface.

Nine unit tests over the new code. Longest-prefix mount resolution (`/` matches everything, so a
shorter match must never win); a same-prefix sibling directory (`/tmp` must not match `/tmpfoo`);
octal-escaped mount points; the four newly-correct local verdicts driven end-to-end through the real
probe with `df` output injected, so the wiring is covered rather than only the pure classifier
beneath it; and the rejections that must **stay** rejections — `fuse.gcsfuse` (the shape-identical
twin of a ZFS pool), `9p`/`drvfs`, `virtiofs`, and an unknown fstype. Two control tests assert macOS
never reads procfs and that a `/dev`-backed source still short-circuits before procfs is consulted —
both by making the procfs reader *throw* if it is reached.

Falsification check: emptying the allowlist makes exactly the two rescue tests fail and leaves the
rest green, confirming the tests detect the defect rather than passing regardless of it. The fix was
authored on macOS and verified on the Linux host that exposed it, so the proof does not come from the
machine it was written on.

## What to Tell Your User

If you run instar on Linux — including inside Docker — two of its safety limits have not been working
the way they report. The one that stops several test suites colliding has been quietly letting runs
through unbounded, and the one that stops runaway model-process storms has been unable to clean up
after itself, which makes it slowly fill up and eventually block work that should be allowed. Both
are fixed. On macOS nothing changes.

## Summary of New Capabilities

No new capabilities. Two existing safety limits now work correctly on Linux and in containers.
