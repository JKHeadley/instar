# Side-Effects Review — Linux fstype second opinion for host-local classification

**Version / slug:** `linux-fstype-host-local-classification`
**Date:** `2026-08-25`
**Author:** `Echo`
**Second-pass reviewer:** `not run — see the Second-pass section for why, and the gap it leaves`

## Summary of the change

Two host-level safety semaphores — `HostTestRunnerSemaphore` (concurrent test suites) and `HostSpawnSemaphore` (concurrent LLM subprocesses, the fork-bomb floor) — coordinate through a holders file and must first establish that the file lives on a HOST-LOCAL filesystem. That question was answered solely by `classifyDfSourceLocal`, which reads the `df -P` *device-source* column and only recognises a filesystem as local when it names a block device (`/dev/...`).

Several ordinary LOCAL Linux filesystems do not name a device in that column — `tmpfs` (Ubuntu's default `/tmp`), `overlay` (every Docker container's root), `devtmpfs`, and `zfs` (which names a pool, never a device). All four were therefore classified "possibly a shared network volume", and the two semaphores degraded silently in OPPOSITE directions (see §5).

This change adds a Linux-only **second opinion**: when the df-source column does not already settle the question as local, the fstype for the path is resolved from `/proc/self/mounts` and checked against an explicit allowlist. It can only ever UPGRADE `not-local → local`, only for an allowlisted fstype, and only on Linux. macOS never reaches the new code path.

Files touched: `src/core/hostSemaphoreCore.ts` (new `fstypeForPath`, `classifyLinuxMountLocal`, `LINUX_HOST_LOCAL_FSTYPES`, injectable `ProcMountsReader` + `DfRunner`; `probeDfHostLocalDetailed` consults them), `tests/unit/host-semaphore-core.test.ts` (+9 tests).

## Decision-point inventory

- `probeDfHostLocalDetailed` (`src/core/hostSemaphoreCore.ts`) — **modify** — the host-local verdict that gates holder-file trust for both semaphores. The verdict domain is unchanged (`local` / `not-local` / `unknown`); only its accuracy on Linux changes.
- `classifyDfSourceLocal` — **pass-through** — byte-identical. It remains the first and only test on macOS, and still the fallback on Linux.
- `HostTestRunnerSemaphore` admission / `HostSpawnSemaphore` reclaim — **pass-through** — both consume the verdict unchanged; neither is edited.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None — the change cannot reject anything it did not already reject. The new code path is reachable only after `classifyDfSourceLocal(source)` has returned false, and its only possible effect is to return `local` instead of `not-local`. There is no input for which this change produces a *more* restrictive verdict than the current code.

---

## 2. Under-block

**What failure modes does this still miss?**

Concrete cases that remain classified not-local, all deliberately:

- **`9p` / `drvfs`** (WSL's mount of the Windows drive, verified live on this host as fstype `9p` with `aname=drvfs`). Same physical machine, but exclusive-create and rename semantics are not dependable across the translation layer, so it must not hold the lock. Rejecting it is correct; before this change it was rejected for the wrong reason (no `/dev/` prefix) and now it is rejected deliberately (absent from the allowlist).
- **`virtiofs`** — a host-shared directory that sibling guests may also mount. Genuinely ambiguous; fail-closed is right.
- **An unlisted local fstype** (e.g. a new filesystem, or `fuseblk` NTFS) still reads not-local. The failure mode is the pre-existing one, unchanged.
- **A bind-mount whose underlying device is remote** is classified by the *mount's* fstype. `/proc/self/mounts` reports the real fstype for bind mounts, so an NFS bind still reports `nfs4` and stays rejected.
- **The `unknown` status is untouched.** A `df` timeout still yields `unknown`, never a positive verdict — the 2026-07-01 §1.2 distinction is preserved.

---

## 3. Level-of-abstraction fit

This is a **detector accuracy** fix at exactly the layer that already owns the question. `hostSemaphoreCore` is the extracted shared primitive both lanes already call; the change adds no new layer and no new caller.

The deeper point the review surfaced: the existing check asks *"does this look like a block device?"* as a proxy for the real question, which is *"is this filesystem mine, and does exclusive locking work on it?"*. The proxy is what fails. On Linux the real question has a direct answer (the fstype), so the fix consults it rather than improving the proxy. Notably, the ZFS case **cannot** be fixed at the proxy layer at all: a ZFS pool name (`rpool/ROOT/x`) is shape-identical to a FUSE cloud-bucket source (`my-bucket`), which is genuinely remote. Only the fstype separates them — which is the argument for this layer rather than a better regex.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing gate.

The verdict is a **signal** consumed by the two semaphores, which hold the authority. This change does not move authority, does not add a decision point, and does not change what either semaphore does with a given verdict. It makes an existing brittle detector *less* brittle on one platform while leaving its fail-closed default intact for everything it does not positively recognise. The allowlist is a closed, enumerated set — not a heuristic.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The domain here is **enumerable by construction**: a filesystem type is a finite, named kind, and the invariant ("this fstype supports exclusive-create + atomic-rename and cannot be mounted by another host") is a property of the kind, not a weighing of live signals. There are no competing signals to arbitrate — one path, one fstype, one answer. The allowlist is the enumeration; anything outside it falls to the pre-existing fail-closed floor.

---

## 5. Interactions

- **Shadowing:** the new path runs strictly AFTER `classifyDfSourceLocal` and only when that returned false. It cannot shadow the source classifier; the `/dev/`-backed short-circuit is covered by a test that makes procfs *throw* if consulted.
- **Double-fire:** none. The probe is a pure read; both callers already memoize it (spawn lane on success only). No new writes, no new spawns — the new path reads one file and does no I/O beyond it.
- **Races:** none introduced. `/proc/self/mounts` is a kernel-synthesised read; a mount changing mid-read yields a stale-but-consistent line, and the worst outcome is one probe returning the pre-existing verdict.
- **Feedback loops:** none. The verdict does not feed anything that changes mounts.
- **The interaction that motivated the fix** is the pre-existing one this repairs: the same misclassification degraded the two lanes in OPPOSITE directions — the test-runner lane **fails open** (admits the run unslotted; the bound reports itself present while guarding nothing — observed as `admitted WITHOUT a slot (fail-open: df-not-local)` on this host, producing 30 test failures across 3 files), and the spawn lane **fails closed** (stops reclaiming dead holders, so the cap clogs until it blocks legitimate work). Restoring an accurate verdict repairs both without touching either lane's logic.

---

## 6. External surfaces

- **Other agents on the same machine:** yes, beneficially — the host spawn cap is host-wide across every compliant instar process. On a Linux host whose `~/.instar` sits on an allowlisted-but-previously-misjudged filesystem, dead-holder reclaim starts working again for all of them.
- **Install base:** any Linux or containerised install. `overlay` means **every Docker-hosted instar** was in the misjudged set.
- **External systems:** none.
- **Persistent state:** none added. The probe writes nothing.
- **Return shape:** `probeDfHostLocalDetailed` gains an OPTIONAL `fstype` field. Additive — no existing caller reads it, and `probeDfHostLocal` (the boolean wrapper) is unchanged.
- **New optional `deps` third parameter:** default `{}`, so every existing two-argument call is untouched.
- **Timing:** one extra `readFileSync('/proc/self/mounts')` on the cold path only (after df has already run, and only when df did not settle it). Not on the hot acquire path.
- **Operator surface:** no operator-facing actions added or touched — not applicable.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, approval page, or grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, and the reason is the feature's whole point: the holders file is a *host-local* coordination file, and this verdict exists precisely to establish that a given filesystem belongs to exactly one machine. Replicating it would be a category error — the correct answer genuinely differs per machine (a Mac reports `/dev/disk3s5`, a WSL2 host reports `ext4`, a container reports `overlay`), and a peer's verdict about its own disk carries no information about mine.

- **User-facing notices:** none — the change emits nothing. One-voice gating not applicable.
- **Durable state:** none held, so nothing strands on topic transfer.
- **Generated URLs:** none.
- **Pool-wide read:** the existing `GET /spawn-limiter` and `GET /test-runner-limiter` already report per-machine state, and those surfaces are unchanged.

---

## 8. Rollback cost

- **Hot-fix release:** revert the code change, ship as next patch. Pure code, no schema.
- **Data migration:** none — no persistent state is written or read beyond `/proc/self/mounts`.
- **Agent state repair:** none. Reverting restores the previous (fail-open on the test lane, no-reclaim on the spawn lane) behaviour, which is the status quo every Linux agent is running today.
- **User visibility:** none during the rollback window. The verdict is internal; no user-facing surface renders it.

---

## Conclusion

This review produced one design change and one correction to my own initial finding.

The **design change**: my first instinct was to widen the source-column pattern to accept `tmpfs`/`overlay`/pool-shaped names. Working through §3 showed that cannot be made safe — a ZFS pool name and a FUSE cloud-bucket name are shape-identical, so any regex broad enough to admit ZFS admits genuinely-remote mounts too. Consulting the fstype is not merely tidier; it is the only formulation that separates them.

The **correction**: I initially reported `drvfs` as a fifth false rejection. It is not. Verified live on this host, `/mnt/c` is fstype `9p`, and exclusive-locking semantics across it are not dependable — so the rejection is correct and is now deliberate (documented absence from the allowlist) rather than accidental.

The change is bounded in the safe direction by construction: Linux-only, upgrade-only, allowlist-only. Clear to ship pending second-pass review.

---

## Second-pass review (if required)

**Reviewer:** none — not spawned.
**Independent read of the artifact: NOT PERFORMED.**

Stating the gap plainly rather than papering over it. This change is adjacent to the Phase-5 trigger list without landing squarely on it: it touches no messaging block/allow decision, no session lifecycle, no coherence/idempotency/trust surface, and the module is not a sentinel, guard, gate, or watchdog by name. It *is* the accuracy of a signal two safety limiters consume, which is the spirit of the rule even if not its letter.

A dedicated reviewer subagent was not spawned because a standing operator instruction in this session forbids delegating to subagents unless explicitly asked. I did not want to record a concurrence that never happened, so this section says so. The PR is therefore the review surface, and the strongest independent evidence available is empirical rather than a second opinion: the tests were falsified against a deliberately-broken fix, and verification ran on the Linux host that exposed the defect rather than the macOS host it was authored on.

If an independent read is wanted before merge, say so and I will run one.

---

## Evidence pointers

- Live reproduction (WSL2 / Ubuntu 26.04, `/tmp` on `tmpfs`): `[test-runner-bound] WARN: admitted WITHOUT a slot (fail-open: df-not-local) — posture: dry-run.`
- Before: 30 failures across `tests/unit/host-test-runner-semaphore.test.ts` (13), `tests/integration/test-runner-bound-meta.test.ts` (14), `tests/integration/test-runner-limiter-route.test.ts` (3).
- After, same host: all three files pass — 132 unit + 29 integration tests green.
- Falsification check: emptying `LINUX_HOST_LOCAL_FSTYPES` makes exactly the two new rescue tests fail, confirming the tests detect the defect rather than passing regardless.
- Cross-platform: the fix was authored on macOS and verified on the Linux host that exposed the defect, so the proof does not come from the machine it was written on.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This fixes a hand-written classifier in TypeScript source, not an LLM prompt, hook, config, skill, or standards text; and it adds no self-triggered controller (no loop, monitor, sentinel, reaper, scheduler, or recovery path — the change is a pure read consulted by two existing semaphores whose control logic is untouched).
