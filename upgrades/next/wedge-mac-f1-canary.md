## What Changed

- Wedge detection (dry-run) now reads the GUI path on macOS. Each sample opens a tiny background app that ships in the package, `dist/native/InstarWedgeCanary.app`, with `open -g -j`. The app has no window and no Dock icon, and it quits at once. A zero exit is a healthy reading. A nonzero exit (for example LaunchServices error -600) or a 10-second timeout is evidence. That evidence counts only after the app has opened successfully once since this boot, and never while the screen reads `locked` or the console belongs to the login window or another person. Before this, F1 always read `unknown` on a Mac.
- The process-table family (F2) on macOS also reads the `data.kalloc.1024` kernel zone with `zprint`, without root: the zone's in-use element count times its element size. Over 4 GiB counts as evidence. If the zone cannot be read, the reading says so (`kernelZoneRead: false` and a reason); it never counts as zero.
- The canary is built and signed by the same script as the desktop helper. It uses the same signing identity when the release has one, and it is not notarized. Local builds sign it ad-hoc. Files installed by npm carry no quarantine mark, so macOS opens it without a notarization check. The helper's source hash and its macOS permissions are unchanged.
- Nothing acts on the machine. Wedge restart stays dry-run, and sampling cadence, single-flight and probe timeouts are unchanged. Linux and WSL are unchanged.

## What to Tell Your User

On a Mac, the check for a frozen machine can now see whether the Mac can still start a program. It opens a tiny invisible app that closes immediately, and it reads one kernel memory counter. It still only watches: it never restarts or closes anything.

## Evidence

- Live on the Mac Studio (macOS 26.5.2): `open -g -j` of the built canary ran 25 times; 24 exited 0 in 18–75 ms, with no process left behind. The one failure came when a run was started within milliseconds of the previous one: LaunchServices error -1712 after 2.1 s. Eight runs 3 s apart all passed, and the sampler runs at most every 2 minutes.
- Live on the same Mac, unprivileged `zprint -L data.kalloc.1024` read 332,120 in-use 1 KiB elements (about 324 MiB). Root's `cur size` a moment later read 333,072 K, so the unprivileged figure is within 0.3% and never above it.
- Unit, integration (`GET /machine-maintenance` shows the canary and zone readings) and e2e (real canary through a real `AgentServer`) tests.

## Summary of New Capabilities

- `wedge.families.F1` on macOS: `canary-passed` / `canary-failed` / `canary-timed-out`, plus `-never-passed-this-boot`, `-screen-locked` and `-no-console-session` ineligible forms, and `launchServicesError` in the detail.
- `wedge.families.F2.detail` on macOS: `kallocInUseBytes`, `kernelZoneRead`, `kernelZoneReason`; reason `kernel-zone-over-limit` when over 4 GiB.
