---
title: "Local Verify: borrowed machines run unit-test slices in shadow (results never count)"
slug: "local-verify-borrowed-unit-slices"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "docs/specs/local-verify-capacity.md"
eli16-overview: "docs/specs/local-verify-borrowed-unit-slices.eli16.md"
tier: 2
supervision: tier0
topic: 145097
depends-on: "PR 3451 (SEC-113: machine signatures for Local Verify exchanges) merged"
review-convergence: "2026-11-18T22:57:52.355Z"
review-iterations: 6
review-completed-at: "2026-11-18T22:57:52.355Z"
review-report: "docs/specs/reports/local-verify-borrowed-unit-slices-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 1
contested-then-cleared: 18
---

# Local Verify: borrowed machines run unit-test slices in shadow (results never count)

## Problem

Justin (topic 130715, #143933, #143942, #143952, #142464) asked for a system that uses spare compute and memory on machines he connects, starting with his laptop and an old Windows PC (through WSL). It must work even while he uses the machine, pull back when his demand rises, and be robust and judged on evidence rather than fixed limits.

### Measured so far (2026-11-18)

- **Laptop trials** (`.instar/state/laptop-pieces-trial-1118-0619.txt`, `-trial-2-1118.txt`):
  - 200 unit files in 13.0 min at 2 workers while he worked;
  - 400 files in 8.5 min at up to 5 workers, with 4 of 16 cores always kept free;
  - one slice handed back 0.01 s after the stop decision;
  - about one sixth of an M5 on unit tests;
  - two files failed because they need the Mac desktop helper.
- **Lane balance:**
  - M5, with its 3-way shard trial: unit 15.2 min, integration about 18, e2e about 15.
  - Studio: unit 22.7, integration 36, e2e 28.
  - So unit work is not the last lane on either machine. With 4 integration shards, e2e (~15) would cap the M5 gain at about 0.2 min a run. On the Studio, moving about 18% of the unit lane frees roughly 0.7 cores.
- **Unit timings are not recorded.** `orchestrator.ts` writes `file-durations.json` only for the integration and e2e lanes (the `lane.name !== 'unit'` guard). So no projection or slice plan can be computed today.

### Review round 1 findings

Round 1 (six internal reviewers plus codex-cli) found that letting a borrowed machine's results count has three problems:

- It would run PR code, including `npm ci` install scripts and test code, as Justin on his own laptop, reachable by anything holding the pool Bearer token.
- It needs result-validity facts the answer did not carry: exit code, unhandled errors, counts.
- Its quarantine and sampling rules did not hold.

### Therefore

This spec builds the borrowed-machine path in **shadow only**. A helper's results are compared and recorded, never used for a verdict, so a helper has **no merge authority**.

Because nothing counts, **a helper in this spec runs only code already merged to `main`**. Its slices are compared with the unit lane of a `main` verify on the same commit. Agreement, throughput and owner impact are measured just as well on merged code. And the hardest risk, running someone's unmerged change on Justin's machine, does not arise in this spec. The sandbox and every wall below are still built and proven, because the later count spec would need them for PR code.

It also adds what any later step needs:

- unit-file duration recording;
- an owner-first helper that is safe on a personal machine;
- measured speed, agreement and owner impact per helper.

Counting helper results is a later spec. It opens only when three conditions hold (see Maturation plan):

- the lane balance makes unit the last lane, or a matched comparison shows a Studio benefit;
- shadow agreement holds;
- Justin says yes to results from his machine counting.

## Proposed design

Terms:

- **Run machine:** the machine running a verify (the Studio, or the M5 as a peer).
- **Helper:** a borrowed machine: the laptop, which is already pool machine `m_cc2ec651…`; or the Windows PC, through the Echo agent already enrolled there and a dedicated WSL2 distro.
- **Slice:** a set of unit test files sized to a time budget.

### A. Record unit-file durations (run machines)

`file-durations.json` gains unit files. The orchestrator records per-file `ms` for the unit lane the same way it does for the other lanes (one change at the `lane.name !== 'unit'` guard), plus each unit run's wall-to-sum factor (lane wall time ÷ (sum of file times ÷ workers)). The Studio measured 1.22 on 11-18.

This has no behaviour change and is useful alone: later sharding and slice work need it.

### B. The helper role, and the sandbox it runs tests in

A separate setting on the helper machine:

```
monitoring.localVerify.helper = {
  enabled, reserveCores, pinnedRepoUrl,
  pinnedRequesters: [machineId], stopOnBattery (default true),
  sandbox: { cpus, memoryGb, diskGb }
}
```

- **Default.** An absent or malformed setting means disabled. It is not written by config defaults or migration.
- **Who turns it on.** The helper machine's own agent turns it on, after Justin's yes and after telling the throughput session.

  Justin's yes is asked once by the laptop's agent, in plain words, and can be given from his phone. Under his standing rule (2026-11-18) the ask states:
  1. **The problem:** his laptop's spare capacity could help test changes, but we do not yet know how fast or reliable it is.
  2. **Exactly what changes:** a small Linux virtual machine is installed on the laptop (its disk size, CPU and memory limits). It cannot see his files or reach his other programs or home network, and it is paused whenever he is busy.
  3. **If yes:** about 20 practice runs; nothing it reports counts toward any change; a report follows. He can pause it from his phone, and `instar helper uninstall` removes it completely.
  4. **If no or he waits:** nothing is installed and nothing else changes. There is no deadline. The Windows PC's practice runs can go first instead.

  Nothing needs an administrator password, so the agent does the rest.
- **Why a sandbox machine.** Tests never run on the helper's own operating system. They run inside a dedicated Linux sandbox:
  - **macOS:** a Lima virtual machine (`instar-helper`, Apple Virtualization framework). It is installed and run at user level, with no administrator rights.
  - **Windows:** a dedicated WSL2 distro (`instar-helper`), separate from the Echo distro already on the Mama PC. The existing enrolled Echo agent on that PC is the helper service, so there is no second machine identity. It imports the distro at user level and drives it with `wsl -d instar-helper`.

    WSL2 distros share one kernel and, in WSL's default NAT mode, one network. The Windows boundary is therefore container-level, weaker than the Mac's virtual machine, and B2's per-process network walls are what separate the tests from the Echo distro.

  A virtual machine is the standard isolation for running untrusted CI work (ephemeral self-hosted runners). It replaces a hand-built per-user sandbox, and it gives what a second OS user could not:
  - a hard memory ceiling;
  - no access to the owner's files;
  - its own network, which the sandbox's root controls;
  - disposal by deletion.
- **What the helper service builds.** Only the helper routes (`POST /local-verify/helper-slice`, `/cancel`, `/helper-learned`, `GET /local-verify/helper-status`). It does not start the run-machine Local Verify service. While disabled, the routes answer 404. The service runs as the owner and drives the sandbox through its control channel: `limactl shell` on macOS, `wsl -d` on Windows.
- **Uninstall.** `instar helper uninstall` removes:
  - **on macOS:** the Lima binary and its folder, the virtual machine and its disk under `~/.instar-helper/`, cached images, the learned list and the setting;
  - **on Windows:** `wsl --unregister instar-helper` (never Echo's distro), the owner-signal scheduled task, its signal file, and the setting.
- **GitHub credential.** A read-only fine-grained token (contents read on the pinned repository), held in the helper machine's secret store and used only by the helper service on the host. It is never copied into the sandbox.
- **Pause control on the helper.** `instar helper pause|resume` from the CLI, and a toggle on the helper's dashboard; both are reachable from the phone through the dashboard. A paused helper refuses new work and stops current work at once.

### B2. The sandbox's walls are checked at every start

Configuration (applied when the sandbox is created, re-checked at every start):

1. **No host folders are mounted, and no ports are forwarded.**
   - **Lima:** created with `mounts: []` (overriding its default read-only home mount), `portForwards: [{guestPortRange: [1, 65535], ignore: true}]` and `ssh.forwardAgent: false`.
   - **WSL:** the helper distro has automount and Windows interop off in `/etc/wsl.conf`.
   - Trees enter only by copy (E).
2. **Fixed resources.**
   - **macOS:** `cpus`, `memoryGb` and `diskGb` are set on the virtual machine.
   - **WSL:** they are a `systemd-run` scope's `CPUQuota`, `MemoryMax` and `TasksMax`, inside which both `builder` and `tester` run, and the distro's virtual disk is capped with `wsl --manage instar-helper --resize <diskGb>`. If that command cannot set the size on the installed WSL version, the distro is imported with a disk created at that size.
   - **Starting values on the laptop:** 8 CPUs, `min(8 GB, RAM / 4)` of memory, and 30 GB of disk. That is half its 16 cores, and the trials used at most 5 workers. Workers are also capped at 1 per GB of memory.
   - The operator changes these from the recorded `ownerCoresMax`, the sandbox's peak host memory and Justin's word.
3. **The network, enforced per process:**
   - **Tests and the build have no network and a private file view.** The root runner starts the build and every test slice inside new network and mount namespaces (`unshare -m -n`, then `ip link set lo up`).
     - The network namespace has only its own loopback, which is up, so tests that listen on `127.0.0.1` still work.
     - The mount namespace shows only the tree overlay, a private `/tmp`, `/proc` and a minimal `/dev`. Socket files elsewhere are therefore not visible: WSLg's X11, Wayland and audio sockets under `/mnt/wslg` and `/tmp/.X11-unix`, `/run/WSL` interop sockets, any `docker.sock`.
     - A seccomp filter refuses the `AF_VSOCK` socket family for `builder` and `tester`, so the guest-to-Windows channel cannot be opened.
     - Unit tests and the build need no network. A unit test that needs DNS or the internet fails there and enters the learned list.

     A test therefore cannot reach the host, Echo's distro on Windows (whose `localhost` is the shared namespace's, not the test's), the LAN, the tailnet, the internet, or a port the owner's tools connect to. Nothing a test listens on is visible outside its namespace, so no forwarding setting can publish it.
   - **Only `npm ci` has network**, run as `builder` under `unshare -m` with the same minimal file view (so WSLg and interop sockets are not visible to install scripts either), in the shared network so the `builder` rules apply, with the merged commit's own install scripts (C.1). Its traffic is matched by user id (nftables `meta skuid builder`). The rules allow DNS to the configured resolver and TCP 443 to public addresses. They drop everything else: host loopback beyond the DNS stub, private ranges, `100.64.0.0/10` (Tailscale), link-local, multicast, `fc00::/7`, `fe80::/10`, and all other IPv6.

     Because the rules match only `builder`, they do not touch Echo's own traffic in the shared WSL network.
   - `builder` and `tester` have user ids no account in any other distro uses.
   - On WSL the helper's rules live in their own nftables table, which runs before other tables' accepts for `builder`. Its hash is re-checked before every `npm ci`, since a firewall tool in another distro could flush shared rules.
   - All `builder` processes are killed after every build and before every `npm ci`. A process left by a build cannot then rewrite packages before install scripts run with network.
4. **Users inside the sandbox.** `builder` runs `npm ci` and the build; `tester` runs tests. Neither can use `sudo` (Lima's default guest user keeps its sudo, but tests never run as it), and neither can change the network rules or read the other's private folders.
5. **Pinned software.** Lima is installed from a pinned release archive into the agent's home, not through Homebrew, so no administrator prompt can appear.
   - Its virtual machine disk lives under `~/.instar-helper/`, outside the agent home, so nothing syncs, indexes or shows it.
   - The base images are minimal (no containerd), pinned by digest, and checked at every daily recreate.

Checks (the helper refuses to start, `helper-containment-unproven`, shown on its dashboard with the reason):

- **Mounts:** the configuration shows no mounts and no forwards. Inside the sandbox, `/proc/mounts` has no virtiofs, 9p, sshfs or drvfs entries. A marker file created in the owner's home is not visible.
- **Network:** the helper service opens one-shot probe listeners on host loopback, on the host's interface toward the sandbox, on a LAN address and (on Windows) in Echo's distro, and confirms each answers from its own side. Then:
  - Inside a test namespace, a connection to each of them, to a tailnet address and to an IPv6 address must fail with "no route", while each listener's positive control still answers. A listener on the namespace's own `127.0.0.1` must work.
  - As `builder`, connections to those must fail too, and fetching the npm registry must work. Each `builder` probe reads the drop rule's counter before and after, and the counter must rise.
  - The helper's own table hash must match the installed one.
  - Inside a test namespace, and inside `builder`'s install view, no socket file outside the overlay is visible, `/mnt/wslg` and `/tmp/.X11-unix` are absent, and opening an `AF_VSOCK` socket fails.
- **No forwarding:** a listener started inside a test namespace, and one started as the guest user, cannot be reached from the host's `127.0.0.1`.
- **Users and limits:** as `tester` and `builder`, `sudo -n true` fails, writing to a prepared tree fails, and changing the network rules fails. On WSL, a process the runner started reports the scope's memory, CPU and task limits (`MemoryMax`, `CPUQuota`, `TasksMax`).
- **Windows only:** `/mnt/c` and `/mnt/wsl` are absent for `tester` and `builder`, and running a Windows binary fails.
- **Host disk:** host free space must be at least the sandbox disk's remaining possible growth (`diskGb` minus its current file size) plus 5 GB. Otherwise the helper refuses (`host-disk-low`). Both sandbox disks are files that grow on the owner's disk up to their cap.

### C. What a helper accepts (it checks for itself)

A request is `{ attemptId, runAttemptId, headSha, files, deadlineAt, budgetMs, expiresAt }`. `attemptId` is unique per slice, and `deadlineAt` is an absolute time, so a laptop that slept mid-slice stops on waking.

- **Signature.** It must be signed by a machine on `pinnedRequesters`, with PR 3451's `MachineSigner` over the canonical request (domain `instar-lv-helper-request-v1`), in addition to Bearer.
- **Replay.** It is refused after `expiresAt` (at most 60 s after signing, with 30 s tolerated for clock difference; `expired` refusals are audited separately). An `attemptId` already seen is refused, and the seen set persists across helper restarts for 10 min.
- **Route.** It is refused when it came through the Cloudflare tunnel (the `cf-connecting-ip` header is present). It is only served on the Tailscale or LAN interface address.

The helper then checks, itself, before running anything:

1. **The commit is merged.** The helper service asks GitHub, against `pinnedRepoUrl`, whether `headSha` is reachable from `main` (the compare API reports `identical` or `behind`). Otherwise it refuses (`not-merged`).

   It uses a read-only GitHub token held in the helper machine's secret store (a fine-grained token with contents read on the one repository). It stays on the host and never enters the sandbox. The answer is cached for the prepared tree's life.
2. **The files:** every requested file exists in that commit, is a unit test file, and passes D. A request marked `retrial: true` (signed like any other) may name files on the learned list. It bypasses only that one exclusion, carries at most 5 such files, and follows D's re-trial schedule.

Any failed check answers with its refusal reason, and nothing runs. What remains is the merged code's own tests and install scripts, which every run machine already runs, executing inside the sandbox.

### D. Which files may go

A file may go to a helper only if it passes all three checks:

- **Not on the fixed exclude list** `BORROWED_EXCLUDE`, in code: the Mac desktop helper, Chrome/CDP, Codex CLI, launchd, and tmux-driving tests.
- **No scan hit in the test file or its direct imports** (an efficiency hint, like the fixed list: it only keeps a file local). The scan matches call sites and string literals only, not identifiers or comments: a spawn or exec whose command literal is `launchctl`, `osascript`, `tmux`, `open` or `security`; literal paths under `/Library/` or `~/`; `homedir()` calls; `process.env.HOME` reads.
  - Hits deeper in the import closure are recorded (`scanDeepHits`) but do not exclude. The sandbox has no access to the owner's desktop or system services; a test that needs `launchctl` or `osascript` fails on Linux and enters the learned list.
  - The time-weighted `scanIneligibleShare` is audited every run. Before the narrowing, a plain-text closure scan made 80% of unit files ineligible, about 85% of unit time.

  The scan is a signal that keeps a file local. It never stops a run. Every file runs locally anyway, so a false hit costs nothing.
- **Not on that helper's learned exclude list.**
  - **One list per helper, kept on the helper** (`state/local-verify/helper-learned.json` on the helper machine).
    - Run machines report entries through `POST /local-verify/helper-learned`, signed and checked like C. Every run machine reads the list from `GET /local-verify/helper-status`.
    - Each entry names the run machine and the two runs that added it, and the run machines' audit rows remain the source of truth if the helper is reinstalled.
    - The list is capped at the number of eligible unit files in the current tree (about 3,850 today). Reaching it means the helper agrees on nothing, which is reported as "incompatible". A quarter of eligible files is already the incompatibility line.
  - **Added** when a file fails, or skips differently, on the helper while passing on the run machine in the same run, twice.
  - **Re-tried** in a trial slice when the helper's Instar version changes, when the file's content changes, or every 10th run of that helper. It is removed when that trial agrees.

### E. How a helper runs a slice (owner-first)

**One queue per helper.** Preparations and slices run one at a time, in order. In shadow trials each helper is paired with one run machine at a time: the Studio first (about 7.6 `main` verifies a day), and the M5 only when the coordinator's main-on-peers switch has it running `main` verifies.

**Prepare first.** At unit-lane start the run machine sends `POST /local-verify/helper-slice` with `prepare: true` and no files. The helper answers `preparing`. The run machine polls `GET /local-verify/helper-status` every 5 s and sends slices only once the tree is `ready`. It stops waiting at unit-lane end, cancels, and audits `prepNotReady`. The wait is audited (`prepWaitMs`); `busy` during a preparation is not counted as a refusal.

**Preparation:**

1. **On the host,** the owner service fetches `headSha` from `pinnedRepoUrl` into its own bare clone. Fetching runs no code. It exports the commit with `git archive`: a plain file tree with no `.git`.
2. **Into the sandbox,** the tree is streamed as a tar from `git archive` through `limactl shell` (or `wsl -d`) into `/srv/trees/<tree-id>`. The copy time is audited.
   - **As `builder`,** `npm ci` runs with the filtered network inside the private mount view.
   - **Then,** with `node_modules` locked read-only, the build runs inside a no-network namespace.
   - **Priority:** both run at low priority inside the sandbox (`nice 19`), under the same governor stops as slices.
   - **Fresh home:** `builder`'s home and npm cache are reset at each preparation.
   - `node_modules` is reused between trees with the same lockfile hash; `main` heads usually share a lockfile, so most preparations skip `npm ci`.
   - The sandbox's root then makes the whole tree read-only (`chown root`, `chmod a-w`), so code run later cannot change a tree another slice will use.
   - Unit tests that need the repository's own git state, or that only pass on macOS, fail in the sandbox. A full dry run lists them before the 20 counted runs, so they do not distort the agreement numbers.
     - It is one shadow run of every eligible file, driven by a run machine on a tree that run machine verified green. It runs under the governor and may span several idle windows.
     - It happens on the Linux proof and at each helper's first enable.
     - Its entries are tagged `source: dry-run` and count from one paired failure. They are counted toward the "incompatible" share and the "without the list" agreement figure, so a broken sandbox cannot hide itself.
3. **Limits on prepared trees.** At most 2 are kept, evicted least recently used and deleted on cancel. The second covers a newer `main` head arriving while the previous tree is still in use. Inside the sandbox, the helper refuses (`disk-low`) when free space is below the measured peak preparation size. The host-disk check is in B2.

**Running.** A root-owned runner inside the sandbox starts vitest as `tester` on the slice's files, built with `filterOverlapGroups` from `shardPlan.ts` so no path pulls in another.

- **Working space.** Each slice gets its own overlay on the read-only tree: a fresh writable upper folder for whatever tests write. The overlay is discarded after the slice, so nothing a slice writes reaches another slice.
- **Environment.** `HOME` and `TMPDIR` point inside the overlay.
- **Results.** The runner collects results as root, from a pipe it opened (never from files in the overlay), and prints them on a separate pipe. The owner service reads at most 4 MB, then refuses. That is 40x the largest per-slice result in the trials, and it parses in well under 100 ms.
- **Clean-up after every slice:** the runner kills every `tester` process (`pkill -KILL -u tester`, repeated at most 3 times, 1 s apart). If any survive, the sandbox is restarted.
- **Fresh sandbox:** it is recreated from its base image once a day while idle, and at once after any failed check.

**The governor**, every 2 s. The reserve is a sampled target enforced by these rules; the sandbox's fixed CPU and memory size is the hard ceiling.

- **Owner use.** `ownerCores` is host CPU use minus the sandbox's own CPU: Apple's Virtualization XPC process on macOS; on Windows, the helper scope's own `cpu.stat`, not all of `vmmemWSL`, so Echo's own load still counts as the owner's. Workers allowed in the next slice = min(`cpus`, `ncpu − reserveCores − ownerCores`), floored at 0.
- **Reserve.** `reserveCores` is 4 of 16 on the laptop, the trial value, and a quarter of the cores elsewhere to start.
- **The worker count** is fixed when a slice starts. If the allowance falls but stays at least 1, the slice finishes, which takes about one slice budget.
- **Stops.** It stops at once on any of the conditions below. A stop kills every process in the runner's scope, `builder`'s preparation as well as `tester`'s slice, and confirms none are left before answering `handed-back` (or `prep-stopped`):
  - zero workers allowed;
  - host memory pressure warn or worse;
  - battery, when `stopOnBattery` is on;
  - `deadlineAt`;
  - a cancel;
  - a pause.
- **Giving memory back.** Killing tests does not return memory a virtual machine has touched. So host memory pressure warn or worse, battery (when `stopOnBattery` is on), a pause, or 15 min without work all stop the sandbox itself (`limactl stop`; `wsl --terminate instar-helper`, never `wsl --shutdown`). The sandbox's peak host memory is audited. Restarting costs a boot, measured and audited (`sandboxStartMs`).
  - On Windows, terminating the helper distro frees its memory inside WSL's shared virtual machine. Windows itself gets it back only through WSL's global memory reclaim, which is shared with Echo and left untouched. There the bound is the scope's `MemoryMax`, a named residual.
- **No restart loop.** After a memory-pressure stop, the helper answers `owner-busy` and does not boot the sandbox until host memory has stayed normal for a hold-off period. The period starts at 5 min, doubles on each further pressure stop within the hour, and is capped at 1 h. Stops and starts per day are audited and included in the report to Justin.
- **Windows.** The Windows rung needs a Windows-side owner signal. A per-user scheduled task, installed by that machine's agent from `scripts/helper/windows-owner-signal.ps1`, writes Windows CPU use, available memory and power state into Echo's own distro (where the helper service and governor run), at `~/.instar/state/helper-owner-signal.json`. It is never written into the helper distro, so its writes do not restart a stopped sandbox. `tester` and `builder` live in another distro and cannot reach the file. A check confirms the file updates within 10 s. A missing or stale signal (older than 10 s) means the helper does not run.

**Answer.** It is built with the existing `parseVitestJson` (which caps each failure message at 400 characters, bounding the producer side too) and signed by the helper service on the host (domain `instar-lv-helper-slice-v1`). The signature shows which machine answered; it does not make the untrusted run honest, and in shadow mode it does not need to:

```
{ state, attemptId, runAttemptId, headSha, requestedFiles,
  perFile: [{ file, tests, passed, failed, skipped, todo, ms }],
  slice: { exitCode, unhandledErrors, collected, vitestStartMs },
  ownerCoresMax, handBackMs, prepMs, progress, sig }
```

`handBackMs` runs from the first governor sample that called for a stop to the exit of the last `tester` process.

### F. The run machine's side (shadow only)

With `monitoring.localVerify.borrowed = { mode: 'off' | 'shadow', helpers: [{ machineId, url }] }` set to `shadow` on a run machine:

- **Which runs.** `main` verifies only: the Studio's, and the M5's when it runs main verifies. Their head is merged by definition, and their local unit lane is the comparison. PR verifies never send slices in this spec.
- **When slices are sent.** From the start of the unit lane, so the helper prepares while the run machine works.
- **Which files.** Eligible files only, chosen from recorded durations.
  - A file longer than the slice budget goes alone in its own slice if it fits within 3x the budget. Otherwise it is not sent, and the share of unit time that is never eligible is audited.
  - The slice budget starts at 10 s of the helper's measured time. It is enlarged when the audited `vitestStartMs` is more than a quarter of a slice, so startup cost stays a small share.
- **How much is sent.** The helper's throughput, in local file-seconds per helper-second, × (projected unit lane time − the helper's `prepMs` p90).
  - Before a helper has measurements, the run machine uses the trial figures: about 0.17 of an M5 (about 0.27 of the Studio) at the laptop's allowed workers, and 3 minutes of preparation. It sends only that much.
  - Measured values replace these after 5 runs.
- **The run machine's unit lane is unchanged:** it runs every file, as today.
- **The shadow client cannot disturb the verify it rides on.** `main` verifies decide main health and the main-red hold, which blocks merges, so:
  - the borrowed client runs in the Local Verify service as a detached task the run never awaits, not in the orchestrator's lane flow;
  - every failure in prepare, poll, slice, cancel, compare, learned-list post or audit is caught and audited (`borrowed-shadow-error`), and never thrown into the run;
  - comparison happens only after the run's record is written;
  - a client that hangs is abandoned at the end of the unit lane.

  A test runs a `main` verify with a throwing client and with a silent one, and checks that the record, its outcome and its finish time are identical to borrowed mode `off`.
- **Known-red canary.** `main` is almost always green, which cannot show a helper reporting green for a file that really fails. So every shadow run adds one canary slice of seeded fixture files with known outcomes (`tests/fixtures/borrowed-canary/`: passes, assertion failures, a thrown error, an unhandled rejection, skips). The helper does not know which slice is the canary. Its false-green rate on the canary is reported separately.
- **When the unit lane ends,** the run machine cancels outstanding slices and compares, file by file.
  - **Answer validity first.** The answer must carry the request's `attemptId`, `runAttemptId`, `headSha` and exact `requestedFiles`, signed. Its `perFile` must list each requested file exactly once. Otherwise the slice is recorded as `invalid-answer` and compared not at all; it never feeds the learned list.
  - **A file agrees** when its passed, failed, skipped and todo counts are equal and `collected` is true.
  - **Slice-level problems are judged once per slice:** a nonzero `exitCode` that the slice's failed files do not explain, or `unhandledErrors` above 0. Such a slice is counted once as a `slice-error`; it does not turn its passing files into disagreements.
  - **Each disagreement records its direction:** helper-red / local-green, helper-green / local-red, or a skip difference.
- **Each run writes one audit row** to the rotated Local Verify audit log:

  ```
  borrowed-shadow { helper, slicesSent, done, handedBack, busy,
    refused(reason), agree, disagree(files, direction), sliceErrors,
    helperSec, localSec, prepMs, handBackMs, ownerCoresMax,
    vitestStartMs, prepWaitMs, copyMs, sandboxStartMs, sandboxPeakMemMb,
    neverEligibleShare, scanIneligibleShare, helperVersion, runVersion }
  ```

  Different Instar versions are recorded, not refused.
- **The state file** `state/local-verify/borrowed-helpers.json` on the run machine keeps only the breaker state and rolling counters for each helper's last 50 runs. It is registered in the state-coherence registry, and not backed up, since it is rebuildable.
- **A disagreement has no effect on any verdict.** It feeds the helper's learned list (D) and the report.
- **Unreachable helpers.** A helper that does not answer, or answers with a bad signature, three runs in a row is skipped. The wait doubles from 30 min up to 8 h, and resets on the first good answer. A sleeping laptop is therefore not asked on every run, and a long outage costs a probe at most every 8 h. The degradation is reported once (`helper-unreachable since <t>`), not on every probe.

### G. Visibility

- `GET /local-verify` shows the borrowed mode, the helpers, each helper's last shadow summary, and the learned exclude lists.
- The helper's own dashboard shows the helper state (enabled, paused, running a slice, last refusal) and the pause toggle.
- The awareness entry file `src/data/awareness/local-verify-borrowed-helpers.md` explains both sides and the pause control.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a helper accepts a request (C) | invariant; basis: irreversible-consequence; evidence: running code on a personal machine cannot be undone. So the checks are exact: pinned requester and repo, unexpired single-use request, a commit reachable from `main` on GitHub, and the file rules. Any unknown value means refuse. | |
| Whether the sandbox's walls allow the helper to run (B2) | invariant; basis: irreversible-consequence; evidence: a sandbox with a host mount or a route to the host gateway exposes the owner's files and services. Each check is a pass or fail fact; a failed or unrunnable check means refuse. | |
| Whether a file may go (D) | judgment-candidate; floor: unit test files that exist in the merged commit; arbiter: the fixed list, the scan and the learned list, which are now efficiency hints, since the sandbox, not the file list, protects the owner; conservative default: a file that any hint flags runs locally only, as every file does anyway. | |
| When the helper stops for its owner (E) | judgment-candidate; floor: the sandbox's fixed CPU and memory size as a hard ceiling; `reserveCores` as the sampled target; host memory pressure, deadline, cancel and pause always stop; battery stops unless the owner turns that off; Windows without a fresh owner signal never runs. Arbiter: the measured owner load. Conservative default: stop. | |
| Which files a run machine sends (F) | judgment-candidate; floor: eligible files only; arbiter: recorded durations and the helper's measured throughput (seeded from the trials until measured); conservative default: send only the seeded amount. | |
| Using helper results | invariant; basis: enumerable-domain; evidence: shadow mode has exactly one use for a result, comparison. No code path feeds a helper result into `evaluateRun`, and a test asserts it. | |

## Fixed limits

| Limit | Value | Reason |
|---|---|---|
| Slice budget | starts at 10 s of helper time; enlarged while vitest startup is over a quarter of a slice | The trials' median slices were 5 to 11 s, so a hand-back loses seconds. Measured startup cost sets the final size. |
| Single long file | alone, up to 3x the budget, else not sent | A hand-back reaps at once whatever the file length, so this only limits wasted helper work when a long file is handed back. Its share of unit time is audited. |
| Reserve cores | 4 of 16 on the laptop; a quarter of the cores elsewhere to start | The laptop value is the trial value, with no measured owner impact at load average 115. Others start conservative and are revised from the recorded `ownerCoresMax` and the owner's word. |
| Governor period | 2 s | The trials' sampling interval. Memory no longer depends on sampling: the sandbox's memory size is a hard ceiling. |
| Windows signal staleness | 10 s | Five governor periods: one missed write is tolerated, a stopped sampler is not. |
| Request expiry | at most 60 s, plus 30 s clock tolerance | A request is acted on at once. The expiry and a single-use id kept 10 min across restarts stop replay of a sniffed request. |
| Sandbox size on the laptop | 8 CPUs, min(8 GB, RAM/4) memory, 30 GB disk to start; workers at most 1 per GB | Half the cores, above the trials' 5 workers with 4 kept free. Memory for 5 vitest workers plus the build. Disk for two trees, `node_modules` and the base image. Set by the operator and revised from `ownerCoresMax`, peak memory and Justin's word. |
| Result size read | 4 MB | 40x the largest per-slice result in the trials; more is refused, never cut. |
| Clean-up retries | kill up to 3 times, 1 s apart, then restart the sandbox | Bounded: a process that survives a kill ends the sandbox instead of looping. |
| Idle stop | 15 min without work (and at once on memory pressure or pause) | A stopped sandbox returns all its memory; a restart is one boot, audited. |
| Host disk margin | the sandbox disk's remaining growth + 5 GB | The sandbox's disk file grows on the owner's disk; the margin keeps his disk from filling even when the sandbox reaches its cap. |
| Prepared trees | 2 | The second covers a newer `main` head arriving while the previous tree is still in use; evicted least recently used and deleted on cancel. |
| Sandbox disk floor | measured peak preparation size | A preparation never starts without room inside the sandbox; the owner's disk is protected by the host-disk margin. |
| Learned list | 2 same-run differences in (1 in the dry run); re-tried on version or content change or every 10th run; capped at the eligible-file count | Environment failures repeat every run (trial 2), so two separates them from one flaky event; the dry run is a deliberate full comparison on a green tree. The re-trials give every entry a way back. |
| Memory-pressure hold-off | 5 min, doubling per repeat within an hour, cap 1 h | It breaks a stop-boot-stop loop while the owner works; a stopped sandbox already gave its memory back. |
| Unreachable helper | skipped after 3 runs; wait doubles from 30 min to 8 h; reset on success | It follows the existing peer breaker, with growing backoff added so a long outage is probed rarely. |
| Shadow sample sizes | report at 20 runs per helper; Windows after the laptop's 20th run, unless the throughput session starts it earlier | 20 runs give a per-file agreement rate and a hand-back distribution worth reporting. The Windows owner-signal dry run runs no tests, so it may start in parallel. |

## Multi-machine posture

- `monitoring.localVerify.helper` (helper machine): machine-local. machine-local-justification: hardware-bound-resource. It describes that machine's own cores, memory, disk, sandbox and owner, and its operator sets it.
- The helper's learned exclude list (`helper-learned.json`, on the helper machine): unified by placement. There is one list per helper, kept on that helper and read by every run machine through `GET /local-verify/helper-status`. No replication is needed.
- `monitoring.localVerify.borrowed` and `borrowed-helpers.json` (run machine): machine-local. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: run-machine dispatch is machine-local). Shadow results authorize nothing, and the file holds only that machine's breaker and counters.

## Maturation plan

- **ladder:** local-verify-borrowed-unit-slices
- **test-agent-live:** split by platform, because no spare Mac exists.
  - **Linux side:** a throwaway WSL distro on the Mama PC, created and removed by that machine's agent.
  - **macOS side:** a throwaway Lima sandbox on the laptop, created after Justin's yes and deleted after the proof. A Lima sandbox needs no administrator rights and touches nothing outside its own files.

  Neither proof touches the Studio or the M5. They must show:
  - the B2 checks pass, and fail when a host mount is added, a forward is enabled, `builder`'s drop rule is removed, `lo` is left down, or a tree is made writable;
  - a signed request is accepted, a slice runs, and it is compared file by file;
  - each refusal fires: a commit not on `main`, unsigned, expired and replayed requests, tunnel;
  - a detached process is killed, and a surviving one restarts the sandbox;
  - a test that allocates past the memory size is stopped by the sandbox without host impact;
  - a slice's writes do not reach the next slice (overlay);
  - a governor stop gives a measured `handBackMs`;
  - cancel reaps the prepared tree;
  - no helper result reaches the verdict (assertion test).
- **dev-agent-live:** the laptop first, then the Windows PC, in shadow from the Studio (and from the M5 whenever it runs a `main` verify).
  - **Before the laptop:** Justin's one yes to installing the sandbox (asked by the laptop's agent; phone is fine), and the throughput session is told.
  - **Each trial:** one at a time; nothing left running; `reap` confirms.
  - **Windows:** set up by the existing Echo agent on the Mama PC, after its own four-part ask, which it sends to Justin in this topic, since the PC is his to lend. Setup covers the helper distro and its users, the owner-signal task and the systemd caps.
    - Its first run only reports the owner signal.
    - Before that rung, the Mama PC's Echo is confirmed enrolled in the pool with a machine key the run machines can verify, and reachable from them by the route the Studio already uses for that agent's API.
    - If that route relies on WSL's mirrored networking, WSL's loopback is Windows' loopback, and the B2 network check adds a listener on Windows loopback.
- **graduation criterion:** there is no graduation to counting in this spec. This rung ends with a report to Justin and the throughput session after at least 20 shadow runs per helper that each had at least one finished slice (runs that ended not ready, owner-busy, refused or unreachable are audited but not counted), covering:
  - throughput (local file-seconds per helper-second);
  - `prepMs` p50 and p90 and `vitestStartMs`;
  - agreement with and without the learned list, the learned list's share of eligible files, and disagreements by direction;
  - the canary's false-green and false-red rates;
  - agreement split by local outcome, with the number of locally failing files compared. On `main` nearly every local result is a pass, so the count of helper-green / local-red comparisons is reported separately, and a count spec must require a minimum of them;
  - refusals by reason;
  - `handBackMs` p50 and max;
  - `ownerCoresMax` against the reserve;
  - the never-eligible share of unit time;
  - Justin's own account of any slowdown.

  A helper whose learned list covers more than a quarter of eligible files is reported as incompatible rather than as agreeing. A count-mode spec is opened only if all three hold:
  - recorded durations show unit as the last lane on some run machine, or a matched comparison shows a Studio benefit;
  - agreement holds with and without the learned list;
  - Justin says yes to his machine's results counting.
- **fleet:** shadow stays operator-enabled per helper. A helper is someone's personal machine, and only its owner enables it.
- **dark-window:** from merge until the laptop's agent enables its helper role after Justin's approval, and the throughput session sets `shadow` on the Studio.
- **owner:** echo (scaling session, topic 145097). **Review date:** at the laptop's 20th counted shadow run. At about 3 usable Studio `main` verifies a day that is roughly a week. If it has not come within 3 weeks of enabling, the review happens anyway on whatever was collected.

## Tests

- **Unit:**
  - unit duration recording;
  - each acceptance check in C, both sides, including merged-commit, expiry, replay and tunnel;
  - containment probe results (pass, fail and unrunnable);
  - D's rules: fixed list, scan through the import closure, and the learned list in, re-trial and out, with the cap;
  - the governor: owner cores excluding the sandbox's process, reserve, memory, the battery setting, deadline, cancel, pause, stale Windows signal;
  - admission and `busy`;
  - tree eviction, the sandbox disk floor and the host-disk margin;
  - slice planning: seeded, measured, long file, startup enlargement, overlap groups;
  - the comparison: per file, slice-level errors judged once, directions;
  - the breaker's growing backoff;
  - a guard test that no helper result reaches `evaluateRun`.
  - the sandbox: creation with no mounts, no forwards and fixed size; each B2 check, with its positive control and counter; the no-network test namespace; `builder`'s egress rules; the read-only tree and per-slice overlay; the bounded clean-up; stopping on memory pressure, pause and idle; the host-disk check;
  - the Windows owner-signal: this PR ships the scheduled-task script (`scripts/helper/windows-owner-signal.ps1`) and its installer; the helper-side parser is unit-tested (fresh, stale, malformed, forged-owner); the Windows rung's dry run checks the live script.
- **Integration:**
  - the helper routes absent while disabled;
  - refusals with reasons;
  - signed answers verified;
  - `POST /local-verify/helper-learned` (signed, pinned requesters only) and the prepare-then-poll protocol;
  - `helper-status` serving the learned list;
  - the `GET /local-verify` fields;
  - the pause CLI.
- **E2E lifecycle:** run machine and helper on the production path (as in `server.ts`), on one host. In the suite, the helper runs slices directly on the host with `HOME` pointed elsewhere, through a named test-only seam (`sandbox: 'test-bypass'`). A wiring test proves production setup can never use that seam. The real sandbox proof belongs to the throwaway rung, because the Local Verify machines must not need a sandbox. A wiring test checks that the signer, the GitHub reader, the sandbox driver and the governor are wired, not no-ops.

## Risks

- **Code on a personal machine.** The helper runs only code already merged to `main`, minus excluded files. It runs inside a Linux sandbox with no host mounts, no route to the host or the local network, fixed CPU and memory, read-only trees and a per-slice overlay. The walls are checked at every start. Named residuals:
  - merged code and its install scripts, inside the sandbox;
  - `npm ci`'s filtered reach to the public internet as `builder`;
  - on Windows, the shared WSL2 kernel with Echo's distro (container-level boundary; a guest kernel exploit would cross it);
  - a flaw in the virtualization layer itself (Apple Virtualization framework, WSL2), outside this spec's control.
- **Owner impact.** The reserve floor, the measured governor, memory and battery stops, and a pause control on his machine. The ladder report includes his own account.
- **No gain yet.** By design: shadow yields measurements and machinery, not merges.
- **Version skew.** Recorded per run.
- **Ordering.** It depends on PR 3451 (`MachineSigner`, key lookup). The orchestrator change in A is claim-checked against open Local Verify work (PRs 3451, 3455, 3460) before the build. A rotates `verifierVersion` once, which the upgrade note states.

## Frontloaded Decisions

1. Shadow only in this spec. Counting is a separate later spec with the three stated preconditions.
2. The helper role is enabled only by the helper machine's own agent, after Justin's one yes (phone is fine) to the sandbox on that machine, and after telling the throughput session. It is never set by migration. The Windows PC gets its own four-part ask, from its agent, before its sandbox is created.
3. Tests run in a Linux sandbox: Lima on macOS, a dedicated WSL distro on Windows driven by the existing Echo agent there. They never run on the helper's own operating system. A per-user sandbox on macOS was rejected: it cannot cap memory, needs an administrator command, and needs several hand-built walls.
4. The Windows PC joins after the laptop's 20th shadow run, or earlier if the throughput session starts it. It needs the Windows-side owner signal.
5. A helper runs only commits merged to `main`, compared against `main` verifies. Running PR code is left to the later count spec, which inherits this spec's sandbox and walls and must add its own PR checks.
6. Unit duration recording (A) ships live: it is observability only.
7. **Build order.** Two PRs. The first ships A (unit durations) alone, live, at once. The second ships B to G (dark).
   - **Why the sandbox is built now** rather than only for a later count spec: Justin asked for this direction by name (#143933, #143952). The owner-protection claims he cares about most need measuring on his real machines: backing off when he is busy, giving memory back, never touching his files. And any count spec must reuse exactly these walls.
   - The second PR's shadow report also gives the first measured answer to whether borrowed machines can pay at all.
8. **Where the build run ends:** the build, the Linux throwaway proof on the Mama PC, and sending the laptop ask to Justin. The macOS proof starts when he says yes, so nothing in the run waits on him.

## Open questions

*(none)*
