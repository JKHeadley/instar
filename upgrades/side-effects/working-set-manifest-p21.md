# Side-Effects Review — Working-Set Manifest (P2.1 of multi-machine coherence)

**Version / slug:** `working-set-manifest-p21`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (pure read-only module + reader method; no actuation, no routes, no persistence)`

## Summary of the change

P2.1 of the converged WORKING-SET-HANDOFF-SPEC: the pure, on-demand computation
of "what files make up topic T's workspace on THIS machine". Two pieces:

1. `src/core/WorkingSetManifest.ts` — `computeWorkingSet()`: candidates from the
   filesystem convention (`autonomous/<topic>.*`, bounded readdir) + the topic's
   own-stream journal `artifactPaths`; every candidate compute-time jailed
   (realpath containment + final-component symlink refusal), hashed, scanned for
   credential shapes (reusing the versioned `redactForLiveTail` enum), capped
   (per-file / headline-exempt / maxFiles), and listed with honest flags
   (`tooLarge`, `secretFlagged`, `liveSource`) — never silently skipped.
2. `CoherenceJournalReader.readOwnAutonomousRuns(topic, ownMachineId)` — the
   own-stream-only journal evidence source (replicas nominate, they never feed
   this machine's manifest), with `liveRun` derived from the NEWEST run's state.

Ships as a pure module: nothing constructs it at boot yet (the P2.2 verb +
trigger wire it). Zero behavior change for any running agent.

## Decision-point inventory

- **Jail verdict** (escape vs contained): mirrored from the P1 write-time jail;
  both the realpathed ancestor AND the final path must sit under
  `[autonomous/, stateDir]`. Jail runs BEFORE existence checks so an
  escape-shaped path is `jailRejected` even when nothing exists at it; only an
  in-jail vanished path counts `goneFromDisk` (benign evolution, never an attack
  log).
- **Final-component symlink**: refused via lstat on the ORIGINAL path even when
  its target realpaths inside the jail — the manifest must not promise what the
  serve-side `O_NOFOLLOW` will refuse.
- **liveRun**: the NEWEST runId's first-seen action decides (started→live,
  stopped→not). An older crashed run (started, never stopped) does NOT
  resurrect liveness — newest evidence wins; the §3.4 pending-pull re-fire on
  `stopped` covers the re-arm.
- **secretFlagged**: scan only what could transfer (tooLarge files never move,
  so they are hashed for disclosure but not scanned).

## 1. Over-block

**What legitimate inputs does this change reject?** A symlink whose target is a
legitimate in-jail file is refused (deliberate — serve-time parity). A topic's
file larger than its cap is listed-not-transferable (deliberate; headline gets
the 16MiB exemption + the §3.1 Agent-Health notice lands with P2.2). Files past
maxFiles=64 are dropped from the manifest with a count — deterministic order
keeps the headline always inside the cap.

## 2. Under-block

**What does this still miss?** The credential-shape scan is a LEAK-REDUCTION
filter, not a boundary (stated in spec §3.1/§5) — content-shaped secrets pass
it; acceptable strictly under the same-operator peer posture. `sha256: null`
above the 64MiB hash ceiling keeps compute bounded at the cost of disclosure
completeness for absurd files (which never transfer anyway). TOCTOU between
manifest compute and serve-time read is NOT this module's job — §3.2's
O_NOFOLLOW + fd-verify at the verb layer (P2.2) is.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The manifest is a pure function over (stateDir, topic,
injected journal evidence) — the reader call happens at the caller so the
module has no journal dependency; the jail logic mirrors `CoherenceJournal`'s
write-time jail (same rules at every boundary, P1 invariant). The reader
method lives on `CoherenceJournalReader` because that is the ONLY module the
§3.9 actuation-ban lint tracks for journal reads.

## 4. Blast radius

Nothing imports either addition yet. No routes, no config, no persistence, no
hooks, no migrations. A bug here can only mis-list files once P2.2 wires it —
and the pull layer re-verifies every byte against served hashes.

## Evidence

- `tests/unit/WorkingSetManifest.test.ts` — 18 passing: sources+dedupe (incl.
  topic-prefix exactness: 134 never matches 13481), jail matrix (escape,
  final-component symlink, symlinked-parent), caps (tooLarge, headline
  exemption, maxFiles keeps headline), secretFlagged honest listing, mtime
  display-only, liveSource covers ALL live-run entries, reader own-stream-only
  + liveRun semantics + artifactPaths union.
- `tests/unit/CoherenceJournalReader.test.ts` — 15 passing unchanged (no
  regression from the new method).
- Full typecheck clean.
