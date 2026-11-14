---
title: "Mac desktop permission survives an update that leaves the helper unchanged"
slug: "desktop-grant-survives-update"
author: "echo"
created: "2026-11-01"
eli16-overview: "desktop-grant-survives-update.eli16.md"
parent-principle: "The Agent Is Always Reachable"
---

# Mac desktop permission survives an update that leaves the helper unchanged

## Measured cause

On 2026-11-01 the Mini and the M5 Pro read `screenGrant: own, inputGrant: own` on 1.3.1576 and `none` on 1.3.1580.

| npm version | binary sha256 | arm64 cdhash | x86_64 cdhash | Swift blob |
|---|---|---|---|---|
| 1.3.1575 to 1.3.1579 | `f9308272f9da0566` | `b53e90d6…` | `9f81bf5c…` | `1e1cd3ba7` |
| 1.3.1580 | `79da72a1840a8b19` | `57e088dc…` | `bdf3f699…` | `c0c305fd9` |

The helper did not change on each build. Five consecutive releases, built on separate runners, are byte-identical. It changed once, at 1.3.1580, because #2531 changed its Swift source (55 insertions, 33 deletions). The signature is ad-hoc (`TeamIdentifier` not set), so macOS's grant is tied to the cdhash, and the new cdhash lost it.

Two local builds of the 1.3.1579 source with the same output name are identical. The same source on this Mac's toolchain gives bytes that differ from the published ones. So a toolchain change can move the bytes without a source change, and `release-local.mjs` builds on a Mac rather than the publish runner.

Each agent also runs its own installed copy (`<agent>/.instar/shadow-install/node_modules/instar/dist/native/`), so agents on one Mac hold separate macOS entries. That, more likely than one entry per build, explains several entries on one Mac. TCC.db is not readable, so this is not measured.

## Design

1. **Source hash.** The build writes `dist/native/instar-desktop-host.json` with a hash of the Swift source and a build recipe, on every platform, because the publish job builds the package on Linux. The release check refuses a package without it.
2. **One kept copy per Mac.** `DesktopHelperRetention` keeps `~/.instar/desktop-helper/instar-desktop-host` and `retained.json`. Same source hash: the file is never touched, whatever bytes the package carries. Different source hash from a newer package: atomic rename, so a running helper keeps its old file.
3. **Who may replace it.** Only a universal release build in a real `node_modules/instar` install, unless `remoteDesktop.retainedHelper` is explicitly set. An older agent on the same Mac never replaces it and runs its installed copy. A same-version source difference is a development build and never replaces it.
4. **A working grant is never taken away.** While the kept copy lacks a grant, the loader also probes the installed copy and serves from whichever holds more. A Mac on an inherited grant is unaffected. A held input stays with the program that pressed it. A kept copy that fails one start is skipped for that check, and abandoned for the life of the process only after three consecutive failures.
5. **Plain statement.** `helperChange` on the probe distinguishes `source-changed` (a proven grant no longer applies) from `first-grant` (the move to the kept copy). The unavailable reason says what happened, that it will not fix itself, and the exact steps. It reaches `/desktop/availability`, `/desktop/diagnostics` and the pool. One Attention item per helper per Mac is raised within a minute of start, rechecked every 15 minutes, and closes itself when permission returns.

The kept copy's integrity is checked by hash against its own record, and it must be a plain non-symlink file this user owns with no group or world write. A same-user attacker can edit both file and record, as they already can with the installed copy today. This adds no new boundary and removes none.

## Decision points touched

Which of two copies of one program to launch, chosen from macOS's own answer and a source hash. Readiness is unchanged. The notice is a signal with no authority.

## Honest limits

- This would not have prevented the 1.3.1580 loss, because the source really changed. Only a stable signing identity does. Open PRs #2557 and #2558 change the Swift source again.
- Every Mac needs one grant for the kept copy, except that a Mac with a working installed-copy grant keeps using it until its next helper change.
- How System Settings behaves with a stale entry at an unchanged path is not measured here; the steps give both the toggle and the remove-and-add path.

## Rollback

`remoteDesktop.retainedHelper: false` returns to the installed copy at the next server start. A revert does the same. Nothing else reads the kept folder.

## Relationship to the locked-screen spec

`docs/specs/desktop-locked-screen.md` (unapproved, on its own branch) plans digest-named directories with a `current` pointer. This uses one fixed path because a helper with no app bundle is matched by path, so a stable identity needs a stable path. That spec should adopt this path when it lands.

## Long-term fix

Developer ID signing on team AG9AE2H87X, already wired in `build-native-desktop-host.mjs` and `publish.yml` behind `INSTAR_MACOS_SIGNING_IDENTITY`. It needs only the certificate.
