# Side-Effects Review — native desktop release package

**Version / slug:** `native-remote-desktop-publish-package`
**Date:** 2026-10-28
**Author:** Echo
**Second-pass reviewer:** not required (release artifact validation, no agent decision path)

## Summary of the change

The first Mac desktop branch built its Swift helper only when `npm run build` ran on macOS, while Instar publishes npm packages from Ubuntu with install scripts disabled. A normal update would therefore omit the helper even though Echo's local overlay worked. PR CI now builds and checks a universal Apple silicon/Intel helper. The publish workflow independently builds that helper on a macOS runner from a pinned source commit, transfers it into the Ubuntu package build, and checks binary architecture, executable mode, and npm tarball inclusion before publishing. The local release command now makes the same universal package; ordinary local builds retain native-architecture behavior.

## Decision-point inventory

- `scripts/build-native-desktop-host.mjs` — modify — release mode demands macOS and both CPU architectures; ordinary Linux build still skips the Mac-only helper.
- `scripts/check-native-desktop-release.mjs`, `.github/workflows/ci.yml`, and `.github/workflows/publish.yml` — add — hard artifact invariants fail PR CI or publish when the helper is missing or malformed.
- `scripts/release-local.mjs` — modify — the fallback local release builds and checks the same universal helper and npm file list.
- Remote desktop grant, input, tunnel, and operator authority — pass-through — no policy or runtime admission change.

## 1. Over-block

A macOS runner outage or a Swift toolchain change blocks an otherwise valid PR or Instar npm release. A workstation without macOS can no longer use the local release fallback. These are real availability costs. They are preferable to silently publishing a package whose advertised Mac desktop button cannot work. A runner/toolchain failure is visible in CI and can be repaired or reverted; the currently installed version remains usable.

## 2. Under-block

The checks prove two Mach-O architectures, executable mode, and tarball presence. They do not prove that every future Mac version grants ScreenCaptureKit/Accessibility permission or that a physical iPhone decodes H.264. The local universal helper probe and gated live Mac test cover this development host; fleet and phone behavior still need deployment evidence. An npm lifecycle step added later could mutate `dist/` after the pre-publish check, so the workflow should be revisited if publish scripts change.

## 3. Level-of-abstraction fit

The release workflow owns package assembly, so the native binary artifact is built and verified there. The dashboard and per-agent update code should not compile Swift at PIN entry or assume developer tools are installed on every Mac. The runtime adapter remains responsible for permission and active-session checks.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The new publish checks are structural hard invariants over bytes and file mode. They have no conversational judgment surface. `docs/signal-vs-authority.md` explicitly exempts hard-invariant validation from the detector/authority separation. They never decide whether a user may access a desktop; the existing scoped grant remains that authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals judgment point is added. A release either contains a valid universal Mac executable at the declared path or it does not.

## 5. Interactions

The Ubuntu `npm run build` runs before artifact download, so it cannot replace the downloaded helper. The Mac job and Ubuntu job use the same pinned source SHA, avoiding a binary built from a different main revision. `scripts/release-local.mjs` builds universal after its ordinary `npm run build`, then checks the same architecture and pack-list invariants; the existing parity test enforces the relative script order. `UpdateChecker` installs with `--ignore-scripts`, so this does not rely on npm postinstall. The existing dark gate still returns 503 on Windows/Linux and on a Mac without runtime permissions.

## 6. External surfaces

PR CI and publishing now consume a macOS GitHub runner; publish transfers one workflow artifact. A failure delays merging or the next npm version and is visible in GitHub Actions. Users do not see a new prompt; the dashboard continues to require only its PIN. The npm tarball grows by the universal helper. The build jobs do not access user screens, PINs, or agent state.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator step or page is introduced. The Machines panel now explains the PIN-only flow and links directly to the chosen machine. A release artifact failure is a developer workflow error, not a user-facing blocker message.

## 7. Multi-machine posture (Cross-Machine Coherence)

The executable is replicated by the same npm package to every installed Mac, and each Mac still checks its own permissions and issues machine-local grants. Windows and Linux remain explicitly dark until their own adapters are implemented and tested. No desktop frame or input is replicated through the agent mesh.

## 8. Rollback cost

Revert the workflow and helper-build changes in a patch release if the macOS artifact path fails. Existing installed versions and local grants require no data migration. A rollback removes the new Mac desktop capability from subsequent packages; current sessions end at their normal grant deadline or server restart.

## Conclusion

The package path now matches the approved first-Mac architecture. Local universal build, architecture check, executable probe, and npm pack-list check passed. The GitHub publish workflow has not yet run; CI and the first normal release will verify it in the production runner environment.

## Second-pass review (if required)

Not required: this change validates a release artifact and leaves messaging, session lifecycle, dispatch, grant policy, and information flow unchanged.

## Evidence pointers

- `node scripts/build-native-desktop-host.mjs --release-universal`
- `node scripts/check-native-desktop-release.mjs`
- `dist/native/instar-desktop-host probe` returned screen/input permissions and active session on Echo's Mac.
- `npm pack --dry-run --json --ignore-scripts` included `dist/native/instar-desktop-host`.
- `npm run lint:parallel` passed all 49 checks.
- `tests/unit/release-local-parity.test.ts` passed all five checks after local release parity was restored.

## Class-Closure Declaration (display-only mirror)

No shipped agent-authored-artifact defect: this packaging gap was found before the native desktop branch released. No self-triggered controller is added. Not applicable.
