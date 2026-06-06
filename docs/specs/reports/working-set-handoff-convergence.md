# Convergence Report — Working-Set Handoff (P2)

Spec: `docs/specs/WORKING-SET-HANDOFF-SPEC.md`
Converged: 2026-06-06 (4 rounds)
Reviewers: 4 internal lenses (security, adversarial, integration,
lessons-aware+scalability — lessons mandatory every round) + cross-model
`codex-cli:gpt-5.5`.

## Round summary

| Round | Material findings | Outcome |
|-------|-------------------|---------|
| 1 | ~25 across 5 reviewers + codex (MINOR ISSUES) | Full spec rewrite |
| 2 | 5 material + 1 minor (integration CONVERGED) | 6 fixes folded |
| 3 | 2 material (interaction-induced) + 6 codex folds | 8 deltas folded |
| 4 | 0 | **CONVERGED** |

## Material findings caught on paper (would have been production bugs)

**Round 1 (criticals):**
- Offline-prior-owner = the EXO case itself: a pull that dies at the
  breaker while the producer is asleep is the incident, unrecovered →
  durable pending-pull ledger (§3.4).
- Single 32 MiB JSON response = the host's documented event-loop
  starvation root cause re-created → 1 MiB chunked transport (§3.2).
- 12mb body-parser + 5s MeshRpcClient timeout would reject/abort large
  transfers → chunk size pinned far under both, near-cap test through
  the REAL express path (§6).
- Wrong trigger seam (ownAction/confirmClaim run on the ROUTER in the
  single-router topology) → pull scheduled on the wrong machine; fixed
  to the receiver's deliverMessage onAccepted hook (§3.3).
- TOCTOU symlink swap between manifest computation and serve-time read
  → O_NOFOLLOW + fd-verify (§3.2).

**Round 2:**
- Secret-scan overclaim: P1 declared the credential-shape enum
  "not the boundary"; P2 had silently promoted it to primary content
  barrier → honesty block: leak-reduction filter; boundary = the
  same-operator posture (§3.1/§5).
- Re-arm thundering herd: one returning machine holding N topics' files
  would take N concurrent pulls while booting → staggered drain
  (rearmConcurrency 1) + serve-side serveConcurrency 2 (§3.2/§3.4).
- Cross-chunk chimera: chunk 1 of version A + chunk 3 of version B
  assembles a file matching NO real version, livelocking on re-pull →
  generation anchor + bounded restart-from-0 + `unstable` surfacing
  (§3.2); liveSource skip extended to ALL of a live run's entries.
- pending-pulls.json lost-update race — the EXACT shape that caused
  topic-flood #3 → serialized mutate() funnel + corrupt-parse
  quarantine, never silent-empty (§3.4).
- Puller chunk cadence unspecified → pinned: sequential, yield, 
  chunksPerTick 8, pressure-stretched delay (§3.2).
- Supersede granularity: plural nominees per epoch; partial clear could
  strand a sibling record → clears ALL lower-epoch records (§3.4).

**Round 3 (interaction-induced by the round-2 fixes):**
- `busy` counting against the (peer,topic,epoch) attempt cap would let
  the staggered drain exhaust the very records it exists to recover →
  busy = retry-without-penalty, busyRetryCap 10, exhaustion re-files
  intact (§3.2).
- maxTotalBytes on wire-bytes basis + restart-from-0 double-counts
  discarded chunks, starving never-attempted files → pinned to
  assembled, verification-passed bytes (§3.2).
- Codex: generation anchor implied a whole-file hash per chunk request
  → offset-0-only full hash + cheap fstat anchor per chunk, assembly
  hash authoritative (§3.2). Plus: glossary, why-not-standard-protocols
  note, cappedNominees disclosure, eviction-is-deletion honesty.

**Round 4:** all deltas verified present + coherent; emergent
interactions (busy-exhaustion ↔ drain, offset-0 hash cost under
serveConcurrency, restart re-hash worst case 4×16 MiB bounded by
chunkRestartCap) all resolve sanely. No material findings.

## Approval

Standing directive (Justin, topic 13481, 2026-06-06 ~03:05 PDT): "Yes,
please enter a 24 hour autonomy session and continue to proceed through
each project step making sure you implement each one and tested
extremely thoroughly." — covers spec convergence, build, all-tier
testing, and live verification on the echo pair for each project step.
ELI16 companion rendered and sent to topic 13481 at approval time.
