# Working-set manifest (P2.1) — a topic's workspace becomes computable

## What Changed

First slice of the converged Working-Set Handoff spec (P2 of multi-machine
coherence): a machine can now compute, on demand and from durable evidence,
"what files make up topic T's workspace here" — never from anyone remembering
to declare anything.

- `src/core/WorkingSetManifest.ts` — `computeWorkingSet()`: candidates from
  the filesystem convention (`autonomous/<topic>.*`, bounded readdir, exact
  topic-prefix so 134 never matches 13481) + the topic's own-stream journal
  `artifactPaths`; every candidate compute-time jailed (realpath containment,
  final-component symlinks refused), sha256-hashed, scanned for credential
  shapes via the versioned redaction enum, and capped (4MiB per file, 16MiB
  headline exemption for `<topic>.local.md`, 64 files). Over-cap and flagged
  entries are LISTED with honest flags (`tooLarge` / `secretFlagged` /
  `liveSource`) — never silently skipped. `mtime` is display-only; sha256 is
  the only decision key.
- `CoherenceJournalReader.readOwnAutonomousRuns(topic, ownMachineId)` — the
  own-stream-only evidence source (replicas nominate; they never feed THIS
  machine's manifest). `liveRun` derives from the newest run's state, so a
  still-writing run marks every entry "still being written" rather than
  serving a torn snapshot.

Pure module — nothing constructs it at boot yet. The P2.2 transfer verb,
receiver trigger, and pending-pull ledger wire it into the move path next.

## What to Tell Your User

Nothing user-visible yet. This is the foundation slice of "moving a
conversation between your machines moves its working files too" — the part
that lets a machine reliably answer what those files are. The transfer itself
lands in the next slice.

## Summary of New Capabilities

- `computeWorkingSet(opts)` (`src/core/WorkingSetManifest.ts`) — pure,
  bounded, jailed manifest computation for one topic's working files, with
  honest per-entry flags and counted degradations (`jailRejected`,
  `goneFromDisk`, `filesTruncated`).
- `CoherenceJournalReader.readOwnAutonomousRuns(topic, ownMachineId)` —
  own-stream autonomous-run evidence: newest-first entries, `liveRun`,
  deduped `artifactPaths`, bounded with `truncated` honesty.
- Spec: `docs/specs/WORKING-SET-HANDOFF-SPEC.md` (converged 2026-06-06,
  4 rounds, cross-model codex-cli:gpt-5.5; report at
  `docs/specs/reports/working-set-handoff-convergence.md`).

## Evidence

- `tests/unit/WorkingSetManifest.test.ts` — 18 passing: sources + canonical
  dedupe, jail matrix (escape-shaped path, final-component symlink,
  symlinked-parent escape), caps (tooLarge listed+hashed, headline exemption,
  maxFiles truncation keeps the headline), secretFlagged honest listing +
  transferableBytes exclusion, mtime display-only, liveSource covers ALL of a
  live run's entries, reader own-stream-only + liveRun semantics.
- `tests/unit/CoherenceJournalReader.test.ts` — 15 passing unchanged.
- Full typecheck clean.
