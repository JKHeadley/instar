---
title: "Working-Set Handoff — topic moves carry their files (P2 of multi-machine coherence)"
slug: "working-set-handoff"
author: "echo"
eli16-overview: "WORKING-SET-HANDOFF-SPEC.eli16.md"
status: "converged-approved"
approved: true
approved-by: "justin (standing directive)"
approved-evidence: "Topic 13481, 2026-06-06 ~03:05 PDT: 'Yes, please enter a 24 hour autonomy session and continue to proceed through each project step making sure you implement each one and tested extremely thoroughly' — covers per-step convergence, build, all-tier testing, live verify on the echo pair. ELI16 sent to topic 13481 at approval."
layer: "core-instar-primitive"
parent-principle: "Structure beats Willpower — a moved topic's workspace follows it by machinery, not by anyone remembering to copy files"
parent-spec: "MULTI-MACHINE-COHERENCE-MASTER-SPEC.md"
project: "multimachine-coherence"
project-items: "P2.1 topic-working-set-manifest, P2.2 working-set-pull-on-move"
supervision: "tier0 — deterministic file transfer with jailed paths, chunked bounded responses, and content verification; no policy decisions. Justified per LLM-Supervised Execution."
inherited-invariants: >
  This spec INHERITS the converged P1 invariants by reference
  (COHERENCE-JOURNAL-SPEC, review-convergence 2026-06-06): no synchronous
  I/O in hot paths; canonicalized path jails enforced at the data's birth;
  first-hop-only trust; bounded loops/backoff/breaker on every repeating
  behavior; ack-after-durable-commit on receive; observability never
  endangers the observed operation; replicated/remote data is SIGNAL, never
  actuation authority; operation-keyed idempotency that survives restarts.
  Reviewers: treat violations of these as material without re-deriving them.
review-convergence: "2026-06-06T10:36:47.927Z"
review-iterations: 4
review-completed-at: "2026-06-06T10:36:47.927Z"
review-report: "docs/specs/reports/working-set-handoff-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
---

# Working-Set Handoff (P2)

> **One sentence:** when a topic moves between machines, the receiving
> machine PULLS the topic's working files from whichever machines produced
> them — durably, in small chunks, surviving the producer being asleep —
> so transfer stops meaning "you get the conversation but lose the
> workspace."

## 1. Motivation (inherited)

Master spec §5-P2. The EXO incident, mechanized away: the Mini's overnight
gap-analysis lived in machine-local autonomous files; the topic's
conversation moved but its workspace did not — **and the machine holding
the files was asleep when they were wanted** (the durable pending-pull in
§3.4 exists because of exactly this). P1 made the files' location knowable
(live-proven 2026-06-06); P2 makes the files follow. Justin's locked
decision: peer-HTTP pull primary (git unavailable on dev-agent homes).

## 2. Scope

**In (P2.1–P2.2):**
- P2.1 — the **working-set manifest**: pure, on-demand computation of a
  topic's working files on this machine.
- P2.2 — **pull-on-move**: a chunked `working-set-pull` mesh verb, the
  receiver-side trigger, a **durable pending-pull ledger** (the
  offline-producer case), and the **evidence-driven fetch reflex**
  (`POST /coherence/fetch-working-set`).
- The **peer-visibility guard** (rider, earned 2026-06-06): improper
  revocations and silently-missing peers must surface loudly. Kept in P2
  because it shares the implementation area (machines registry +
  presence-pull) and the pending-pull ledger depends on its re-peer signal.

**Out (explicitly):**
- Background digest/anti-entropy over all state categories
  <!-- tracked: multimachine-coherence-pool-wide-cross-topic-awareness -->.
- Semantic merging of diverged file contents (whole-file never-clobber
  only, §3.5).
- Sync of categories beyond topic working sets.
- Live `artifacts-updated` declarations — SUPERSEDED: the manifest
  computes from durable evidence + a filesystem convention (§3.1), not
  willpower-dependent declarations.
- Per-response envelope signatures (responses inherit transport auth;
  stated honestly in §5 — per-entry signatures remain P1's named upgrade
  path <!-- tracked: multimachine-coherence-threadline-conversation-registry -->).

## 3. Design

**Glossary (cross-model reviewer ask):** *first-hop* = data is accepted
only from the machine that produced it, never relayed peer-to-peer-to-peer
(P1 §3.9). *OWN-stream* = a machine's own journal entries (`entry.machine
=== ownMachineId`), as opposed to replicas of peers' streams. *same-
operator* = every registered peer belongs to the same human operator —
the trust posture all disclosure acceptances in this spec rest on.
*liveOwner authority* = the live ownership store (SessionOwnershipRegistry
CAS state) is the only actuation authority; journal/replica data only
nominates (Signal vs Authority).

**Why a custom verb, not a standard transfer protocol:** HTTP range
requests + ETags, rsync, tus, or SFTP would each need a NEW
transport/auth surface alongside the mesh (new port/daemon/credential
class — a second boundary to harden). The mesh RPC path already carries
machine-auth Ed25519 envelopes, RBAC, registered-peer gating, and the
P1-proven bounded-batch pattern; `working-set-pull` reuses ALL of it.
The offset-cursor + fstat-anchor design IS range-GET + ETag semantics,
expressed over the existing authenticated channel. (Standard protocols
revisited if a non-mesh peer class ever exists.)

### 3.1 The manifest (P2.1) — computed, never declared

`computeWorkingSet(stateDir, topic): WorkingSetEntry[]` — pure function,
no new persistent store. Sources, deduped:

1. **Filesystem convention** (freshness-independent of the journal — a
   file created after the journaled `started` is still found):
   `autonomous/<topic>.local.md` and any file matching
   `autonomous/<topic>.*` (bounded glob, no recursion outside the
   convention dir).
2. **Journal evidence**: `artifactPaths` from the topic's OWN-stream
   `autonomous-run` entries — read via a new
   `CoherenceJournalReader.readOwnAutonomousRuns(topic)` method (own
   stream only by construction; `query()`'s merged own+replica view is NOT
   used here), the machine's own id threaded from the server's
   `cjOwnMachineId`.
3. Every candidate canonicalized + jailed (P1 §3.1 jail, same roots); each
   surviving entry = `{ relPath, bytes, sha256, mtime }` where **mtime is
   DISPLAY-ONLY** (P1's `ts` treatment) — every diff/skip decision keys on
   sha256 exclusively, never mtime/bytes.
4. **Secret-content posture** (category intent ≠ content reality: working
   files can contain pasted credentials): the serve side runs the
   credential-shape scan over each file's BYTES; a flagged file is listed
   `secretFlagged: true` and NOT transferred — an honest, surfaced refusal
   (counted + named in the pull report), never a silent skip.
   **Honesty about what the scan is (Signal vs Authority, P1 §3.1
   verbatim):** the credential-shape enum is BEST-EFFORT — it matches
   shaped credentials (token/key patterns) and cannot see content-shaped
   secrets (a password in prose, a key body, a high-entropy blob). P1
   could declare it a secondary pass because the typed-schema boundary
   upstream structurally excluded free text; P2 has NO such upstream
   boundary (working files are arbitrary content). The scan is therefore
   a LEAK-REDUCTION filter, never the security boundary — **the actual
   boundary is the same-operator peer posture itself** (the peer is the
   same operator's machine, not an untrusted exfiltration target). That
   posture, not the scanner, is what makes the residual content-leak
   risk acceptable — restated in §5 and revisited before any
   non-same-operator peer class exists.

Caps: `maxFileBytes` 4 MiB — except the autonomous `<topic>.local.md`,
exempt up to 16 MiB (it is the headline artifact); `maxFiles` 64;
`maxTotalBytes` 32 MiB (a TOTAL-SET budget across chunked requests, never
a single-response size — §3.2). Over-cap entries are LISTED
`tooLarge: true`; a tooLarge HEADLINE file additionally raises one
Agent-Health notice naming the source machine + path — observability is
not delivery, and the operator must know the deliverable did not move.

**Disclosure note (see §5):** the manifest (including tooLarge /
secretFlagged entries) reveals relPath + size + sha256 of jailed working
files to any registered peer. Acceptable: first-hop, own-files-only,
same-operator peers. Revisit if non-same-operator peers become a class.

### 3.2 The verb (P2.2) — `working-set-pull`, chunked and bounded

New MeshCommand
`{ type: 'working-set-pull'; topic: number; manifestOnly?: boolean; want?: { relPath: string; offset: number }[] }`.
**Three lockstep edits**, mirroring journal-sync: the `MeshCommand` union
member, the RBAC read/observe case (alongside `journal-sync`), and the
dispatcher `handlers` registration. Mixed-version: an old peer answers
**403 OR 501** (RBAC default-deny vs no-handler) — the caller treats both
as "verb unsupported, quiet back-off" (P1 rule 6).

**Chunking (the load-bearing transport rule):** every response carries at
most `workingSetPullMaxBatchBytes` (default **1 MiB**) of base64 content —
deliberately far under the mesh endpoint's `express.json({limit:'12mb'})`
body ceiling and the MeshRpcClient 5s per-attempt timeout. The named
reason: a single 32 MiB JSON.stringify is the host's DOCUMENTED
event-loop-starvation root cause, and P1 capped journal-sync at 256 KB for
exactly this. A large file transfers as multiple `want` requests with
`offset` cursors; the receiver assembles chunks and verifies the whole
file's sha256 before any write. `maxTotalBytes` is the TOTAL-SET budget
across all chunks, never one response.

**Cross-chunk consistency anchor (a multi-chunk file is one snapshot,
not N):** per-chunk atomic-read-then-hash protects one chunk, not the
assembly — chunk 1 at version A + chunk 3 at version B assembles a
chimera matching NO real version. Anchor mechanics (cheap by
construction — the serve side stays stateless and never re-reads the
whole file per chunk): the **offset-0 response alone** carries the
whole-file `sha256` (ONE full read+hash, amortized across the transfer)
plus a **cheap fstat anchor** `{ bytes, mtimeNs, ino }`; every
subsequent chunk response carries ONLY the fstat anchor re-read from the
open fd (`O_NOFOLLOW` + fd-verify per §TOCTOU, then `fstat` — no
content re-hash). The puller compares anchors per chunk: mismatch →
abort the file and restart FROM OFFSET 0 (never a blind re-pull of the
failed chunk), bounded at `chunkRestartCap` (default 3) per file per
pull attempt — exhausted restarts mark the file `unstable` in the pull
report (counted, surfaced) rather than livelocking against a file being
actively rewritten. The assembled whole is verified against the
offset-0 `sha256` before any write — the fstat anchor is a fast
tear-detector, the assembly hash is the authority (an mtime-preserving
rewrite that dodges fstat still fails assembly verification and
restarts, bounded).

**Puller-side chunk cadence (pinned, not assumed):** chunk requests are
sequential (never parallel per file), with an event-loop yield between
chunks and a `chunksPerTick` cap (default 8 — ~8 MiB per scheduler tick);
under measured host pressure (the same load signal §3.3 uses) the
inter-chunk delay stretches (base 50ms, ×4 under pressure). The serve
side protects itself symmetrically: at most `serveConcurrency` (default
2) working-set-pull requests are served concurrently; excess requests
get an honest `busy` response (the caller backs off — bounded, counted).
**`busy` is a retry-without-penalty signal**: it does NOT increment the
`(peer,topic,epoch)` attempt cap and does not advance the breaker —
only genuine failures (offline / unreachable / refused / verify-failed)
consume failure budget. Otherwise the staggered drain's own throttling
would exhaust the very records it exists to recover (the just-woke
producer answers `busy` by design). `busy` retries are themselves
bounded (`busyRetryCap` 10 per pull attempt, exponential back-off);
exhaustion re-files the pending-pull intact, breaker untouched. Both
bounds are asserted in the §6 storm test.

**Budget accounting (pinned):** `maxTotalBytes` counts **assembled,
verification-passed file bytes** — never raw wire bytes. Chunks of a
file later discarded by an anchor restart do not count; up to 3
restarts of a near-budget file cannot starve the set's remaining,
never-attempted files.

**Serve-side rules:**
- The manifest is the allowlist and is **recomputed fresh on every
  request** (never cached across calls) — `want` paths outside the fresh
  manifest are refused per-entry (`refusedPolicy`, counted). There is no
  generic file-read surface.
- **TOCTOU defense at read time**: the compute-time jail verdict is not
  trusted at read time. Files are opened `O_NOFOLLOW` via root-relative
  traversal (no symlink component), then `fstat`-verified (regular file;
  the OPEN FD's realpath still inside the jail) BEFORE bytes are read — a
  symlink swapped in after manifest computation reads nothing.
- **Atomic read-then-hash**: bytes are read once and hashed from those
  exact bytes (never stat-hash-then-reread). If the file changed since the
  requester's manifest, the response carries the CURRENT bytes + hash +
  `changedSinceManifest: true` — the served hash is authoritative for
  verification; the manifest hash was advisory for selection. A path that
  vanished between calls returns `goneSinceManifest` (distinct from
  `refusedPolicy` — benign evolution is never logged as an attack).
- **Live-source honesty**: if the topic's OWN journal stream shows the
  autonomous run still active, EVERY manifest entry for that topic — the
  headline `<topic>.local.md` AND any convention-glob or `artifactPaths`
  file (all are plausibly mid-write by the live run) — is listed
  `liveSource: true` and not transferred — a mid-run snapshot would be a
  torn fork of a still-growing file. The pending-pull (§3.4) re-fires
  when the run's `stopped` lands. (The generation anchor above is the
  backstop for files that change WITHOUT a live run — e.g. an editor —
  not a substitute for this skip.)

**Receive-side rules:**
- **Response ceiling BEFORE parse**: the raw response body is bounded at
  the transport layer (`workingSetPullMaxBatchBytes × 4/3 + slack`);
  oversize aborts the read before JSON.parse. Per-blob ordering is
  bound → decode → verify declared bytes → hash → write; never
  decode-everything-then-measure.
- **Peer-supplied relPath is hostile input**: validated BEFORE any join —
  relative only, no `..` segment, no absolute/drive/UNC prefix (P1 §3.1
  rules verbatim); destination resolved under the jail root with
  parent-directory realpath containment; never create-through a
  peer-supplied symlink/junction chain (`O_NOFOLLOW`, temp-file + rename
  inside the jail). The absent-destination write is subject to the FULL
  jail, not only the divergent case.
- Hash verified before the rename lands the file; mismatch discards
  (counted), never a partial write.

### 3.3 The trigger — receiver-side, epoch-gated, single-flight

The pull is scheduled on the RECEIVING machine's **owner-side
`deliverMessage` `onAccepted` resume hook** (the
`createDeliverMessageHandler` seam) — the one place the receiver knows it
now owns the topic. NOT `ownAction`/`confirmClaim`: those run on the
ROUTER, which confirms claims on the target's behalf in the single-router
topology; instrumenting them would schedule the pull on the wrong machine.

Discipline (all inherited-invariant applications):
- **Quiet-topic ownership fallback (issue #926, live-earned):** ownership
  only CASes when traffic flows, so a topic just MOVED here is
  `owner: null` + pinned — the exact state the reflex exists for. The
  ownerOf seam therefore falls back to the placement pin when no
  ownership record exists (`pinned && preferredMachine === self` ⇒
  self-owned at epoch 0); the pin is the live placement authority for
  unowned topics, and a real claim bumping past epoch 0 aborts an
  in-flight pull as superseded, by design.
- **Operation key `(topic, epoch)`** — at most one pull scheduled per key,
  deduped against a durable recent-key window (restart-proof). Skipped
  entirely when `owner === prevOwner` (placing-confirm, no real move) or
  `prevOwner === thisMachine` (nothing to fetch from ourselves).
- **Single-flight per topic** — a superseding transfer cancels/supersedes
  the in-flight pull; before EVERY file write the puller rechecks
  `liveOwner(topic) === thisMachine && currentEpoch === scheduledEpoch`
  against the live ownership store (the authority). Ownership advanced →
  abort quietly (counted) — the newer owner's own pull covers current
  truth. This kills the ping-pong races (stale writes onto a non-owner,
  mutual alongside-copy generation).
- **Load-aware**: scheduling defers under host pressure (master §6.2);
  the pull is always async, NEVER in the message-delivery path.

**Nomination — plural, bounded, reconciled:** candidates are EVERY machine
the journal (own + replicas) shows as an artifact-producer for the topic,
deduped, capped at 3, ordered most-recent-first — NOT "the prior owner"
(a pass-through owner may never have produced anything; the producer may
be two hops back). When the cap excludes producers, the pull report
names them (`cappedNominees` — "not contacted", honestly distinct from
"contacted, nothing found"); the REFLEX route may expand past the cap on
explicit demand (still bounded by the registered-peer ∩
journal-evidenced set — never a fan-out beyond machines the records
actually name). Replicas NOMINATE only (P1 §3.9); each nominee's LIVE
manifest is the authority. When a journal-nominated path is absent from
the live manifest, ONE honest signal is recorded ("journal expected
<path> on <machine>; live manifest does not list it — rotated, deleted,
or never durable"), counted, distinct from a clean nothing-to-fetch — the
operator can distinguish "work is gone" from "work transferred".

**The reflex**: `POST /coherence/fetch-working-set { topic }` (Bearer;
503 when the journal is dark; rate-limited per topic with concurrent
calls coalesced into the single-flight pull) runs the same
nominate→verify→pull pipeline on demand. The contact set is bounded to
the topic's ownership history ∪ journal-nominated producers — a poisoned
replica can never widen the fan-out beyond registered peers that actually
appear in those records.

### 3.4 The durable pending-pull ledger (the EXO case, solved)

A pull whose nominee is offline/unreachable/revoked does NOT die at the
breaker — it persists as a pending-pull record
(`state/coherence-journal/pending-pulls.json`, registered in the
State-Coherence Registry, machine-local):
`{ topic, epoch, nominee, reason, createdAt, attempts, lastAttemptAt }`.

**Single-writer discipline (the flood-#3 lesson, applied at birth):** the
ledger has SIX mutators (onAccepted scheduler, reappearance re-arm,
run-stopped re-arm, attempt/breaker update, reflex route, TTL sweep) that
can overlap on one tick. ALL mutations route through ONE in-process
serialized `mutate(fn)` funnel (async queue; read-modify-write never
interleaves) with temp-file + atomic-rename persistence — the same CAS
chokepoint posture P1's sibling store earned from the lost-update race
that caused topic-flood #3. **Parse-failure posture** (the flood's second
root): a corrupt/unparseable ledger is NEVER read as "no pending pulls" —
the file is quarantined aside (`.corrupt-<ts>`), ONE agent-health notice
fires ("pending-pull ledger unreadable — stranded-recovery records may be
lost"), and a fresh ledger starts. A unit test asserts concurrent
`mutate()` calls drop no record.

- **Re-armed by reappearance — staggered, never a herd**: when the
  presence-pull records a peer coming online (the same 30s cadence
  journal-sync rides) — INCLUDING after an un-revocation — outstanding
  pending-pulls for that peer re-fire as a **staggered drain**: at most
  `rearmConcurrency` (default 1) topic-pull in flight per peer, the rest
  queued behind it most-recent-epoch-first. The EXO shape is ONE machine
  holding MANY topics' files; N simultaneous pulls would slam a box that
  just woke (and is busy booting) — the serve-side `serveConcurrency`
  bound (§3.2) is the producer's own backstop. The 2026-06-06 incident
  shape (files on a machine improperly revoked for 10 hours) still
  recovers automatically the moment the peer is back — sequentially.
- **Re-armed by run-completion**: a `liveSource` skip re-fires when the
  topic's journal shows the run `stopped`.
- **Bounded**: superseded by a newer epoch for the topic — supersession
  clears **ALL records for that topic with `epoch < new`, across all
  nominees** (plural nominees per epoch exist by §3.3; a partial clear
  must never strand a sibling record); TTL 7 days; per-record attempt cap
  with the breaker keyed `(peer, topic, epoch)` — a NEW epoch resets it,
  so an old move's exhausted breaker never suppresses a fresh, warranted
  pull. Episodes surfaced once on TTL-expiry ("topic T's working set on
  <machine> was never recovered") via the Agent-Health lane.

### 3.5 Never-clobber (the one conflict rule)

The receiving side NEVER overwrites a local file that differs:

- Destination absent → write (fully jailed, §3.2).
- Destination byte-identical (sha256) → skip (`skippedExisting`).
- Destination differs → write alongside as
  `<sanitizedBasename>.from-<senderShortId>-<hash8><ext>` — the basename
  sanitized (no path separators), the sender id derived ONLY from
  `env.sender`, the 8-char content-hash suffix making repeated divergent
  arrivals naturally idempotent (the same divergent content produces ONE
  alongside file, not N) — plus the full jail recheck on the final
  alongside path. Surfaced as ONE Agent-Health notice per topic per
  episode listing the divergent files.
- **Bounded (resolves old OQ1)**: at most 2 alongside copies retained per
  base file (oldest evicted); a degradation counter watches `.from-*`
  count + bytes (the P1 archive-growth-watch pattern). An eviction IS a
  deletion of divergent content and is treated as one: it is counted and
  named in the same per-topic Agent-Health divergence notice (never
  silent), and is acceptable only because the evicted copy's content
  still exists on its producer machine (first-hop provenance — nothing
  is lost to the fleet, only to this replica).
- No deletion path exists anywhere in this feature (eviction of alongside
  copies above is the single, narrow exception — alongside files only,
  inside the jail, through SafeFsExecutor).

### 3.6 Peer-visibility guard (the rider)

Earned 2026-06-06 (the Mini: revoked with NO `revokedBy`/`revokeReason`,
invisible for ~10 hours):

1. **Pure detection, surfaced by the right consumer**: a pure helper
   `detectImproperRevocations(registry)` (an entry with `revokedAt` set
   but `revokedBy`/`revokeReason` missing) — NOT inside `loadRegistry()`
   (a hot, dependency-free read called 41+ times per boot; it stays
   pure). The MultiMachineCoordinator's boot/refresh path calls the
   helper and surfaces findings via `POST /attention` with
   `lane: 'agent-health'` (the existing coalescing lane — never a
   topic-per-event), deduped ACROSS boots keyed on the entry's
   `revokedAt` (a crash-loop cannot re-spam it). HYGIENE SIGNAL ONLY: it
   detects sloppy revocation, not malicious revocation — populated
   fields are NOT authenticated and must never be read as "this
   revocation is legitimate".
2. **Peer-disappearance notice**: pool transitions from N≥2 online to
   fewer and stays past a 30-min grace → ONE agent-health-lane notice
   naming the machine + last known reason (revoked / heartbeat-silent /
   url-unreachable), and — when pending-pulls reference that machine —
   naming the stranded topic working sets ("topic T's files are on
   <machine>; recover by bringing it back / un-revoking"). Coalesced per
   machine per episode; **flap-bounded**: after 3 episodes for one
   machine in 24h, collapse to a single "machine X is flapping" notice
   and stop re-notifying until operator ack (Bounded Notification
   Surface). Clears silently on stable re-peer.

### 3.7 Config & rollout

Two concrete edits (Migration Parity): `CoherenceJournalUserConfig` in
`types.ts` gains `workingSet?: {...}`, and the `coherenceJournal` literal
in `ConfigDefaults.ts` gains:
`workingSet: { maxFileBytes: 4194304, headlineFileBytes: 16777216, maxFiles: 64, maxTotalBytes: 33554432, pullMaxBatchBytes: 1048576, pullOnMove: true, pendingPullTtlDays: 7, chunkRestartCap: 3, chunksPerTick: 8, serveConcurrency: 2, rearmConcurrency: 1, busyRetryCap: 10 }`.
**Gate (unambiguous):** the working-set feature activates IFF
`multiMachine.coherenceJournal.replication.enabled === true` — the same
explicit gate as the replication transport it rides (NOT the journal's
`?? developmentAgent` dark-ship gate; the pull is meaningless without
replication's mesh path and must never out-activate it). Live on the echo
pair (replication on since the 2026-06-06 proof); dark everywhere else.
Single-machine agents: manifest + reflex API answer locally; pull paths
no-op. `applyDefaults` add-missing backfills existing agents; no new
hooks; CLAUDE.md template gains the reflex-API entry + the proactive
trigger ("user references files/work not on this machine →
POST /coherence/fetch-working-set") + migrateClaudeMd content-sniffed
section, in the same PR as the route.

## 4. Degradation requirements (inherited P1 §4, plus)

1. A pull failure NEVER affects the transfer itself; retries are bounded
   per `(peer, topic, epoch)` with the durable pending-pull (§3.4) as the
   long-tail recovery — never an infinite loop, never a silent abandon.
2. Every byte written passes hash verification first; temp-file + rename;
   no partial writes survive kill-9 (re-pull is idempotent via
   skippedExisting).
3. Serve side bounded per response (1 MiB batch), per file, per set;
   manifest computation is O(topic's journal entries + convention-dir
   listing), never a scan outside the jail.
4. Mixed-version: 403 OR 501 → quiet back-off (P1 rule 6).
5. Integrity honesty: responses are NOT envelope-signed; content integrity
   rests on (a) the authenticated, registered-peer transport and (b)
   per-file/per-chunk sha256 against transport corruption. A transport
   able to rewrite bytes AND hashes together is detected only by the
   transport's own auth — acceptable because §3.9 (nothing actuates off
   pulled files), first-hop, same-operator; per-entry signatures are the
   named upgrade path (§2 Out).

## 5. Security

- FIRST-HOP + fresh-manifest-as-allowlist: no generic remote file read;
  own files only; jailed paths only; TOCTOU defeated at read time via
  `O_NOFOLLOW` + fd-verify (§3.2).
- Receive side treats relPath as hostile (full validation before join;
  jail on absent-destination writes; sanitized alongside naming derived
  from `env.sender` only).
- Response ceiling enforced before parse; bound → decode → hash → write.
- Secret-content scan over served BYTES (not category intent);
  `secretFlagged` files never transferred, refusal surfaced. **The scan
  is best-effort, not a boundary** (§3.1 item 4): shaped credentials
  only; content-shaped secrets pass it. Unlike P1 there is no upstream
  typed-schema boundary, so the residual content-leak risk is accepted
  strictly under the first-hop + same-operator posture and MUST be
  re-evaluated before any non-same-operator peer class.
- The reflex route is Bearer-gated, rate-limited, single-flight, and its
  contact set is bounded to ownership-history ∪ journal-producers.
- Manifest metadata disclosure acknowledged (§3.1 note).
- No deletion capability (single narrow alongside-eviction exception via
  SafeFsExecutor inside the jail).

## 6. Testing (all three tiers + independent oracles)

- **Unit:** manifest (convention + journal sources, jail cases, caps,
  tooLarge + headline exemption, secretFlagged listing, dedupe, mtime
  display-only, liveSource covering ALL of a live run's entries); chunk
  assembly + whole-file hash; **generation-anchor matrix** (mid-file
  anchor change → restart-from-0; chunkRestartCap exhausted → `unstable`
  surfaced, never a livelock); relPath hostile-input matrix (`..`,
  absolute, separators-in-basename, symlinked parent); alongside naming
  (sanitization, hash-suffix idempotency, cap-2 eviction); never-clobber
  matrix; operation-key dedupe surviving restart; pending-pull ledger
  (persist, re-arm on reappearance + on run-stopped + after un-revoke,
  **staggered drain honors rearmConcurrency**, supersede clears ALL
  lower-epoch records across nominees, TTL expiry notice, breaker keyed
  per (peer,topic,epoch) + reset on new epoch, **concurrent mutate()
  drops no record**, **corrupt ledger → quarantine + notice, never
  silent-empty**); detectImproperRevocations (improper flagged, proper
  not, cross-boot dedupe key).
- **Integration:** full chunked round-trip through the REAL
  `express.json` + MeshRpcClient path at near-cap sizes (the body-parser
  and 5s-timeout interaction exercised for real, not mocked);
  TOCTOU symlink-swap between manifest and read → nothing leaves the
  jail; want-outside-fresh-manifest refused; changedSinceManifest /
  goneSinceManifest semantics; oversized response aborted pre-parse
  without OOM; declared-bytes mismatch discarded; liveSource skip;
  mixed-version 403/501 back-off; reflex route (200 + report / 503 dark /
  rate-limit coalescing); ping-pong storm → single-flight + bounded
  concurrent pulls + ownership-recheck aborts; **storm bounds asserted**:
  serve side answers `busy` above serveConcurrency, puller honors
  chunksPerTick + pressure-stretched inter-chunk delay, reappearance with
  N pending topics drains sequentially (rearmConcurrency), never N-wide;
  **`busy` responses leave the (peer,topic,epoch) attempt cap untouched**
  (drain against a busy producer never exhausts its own records);
  **maxTotalBytes counts assembled bytes only** (anchor restarts of a
  near-budget file don't starve the set's remaining files).
- **E2E:** two production-shaped servers; transfer a topic with a real
  working file → receiving side holds it, content cross-checked against
  the SOURCE machine's on-disk original read directly by the test (an
  oracle independent of both the puller's report and the server's
  self-reported hash); divergent-file case surfaces the alongside copy;
  kill-9 mid-pull → re-pull idempotent, no partial files; offline-nominee
  → pending-pull persists a restart and re-fires on the peer's return.
- **Wiring-integrity:** drive the receiver's `onAccepted` seam and assert
  the pull was scheduled by observing FILES + counters (not the puller's
  report); peer-visibility guard fires on a synthetic improper revocation
  in a temp registry and routes through the agent-health lane exactly
  once across two simulated boots.

## 7. Work breakdown

1. **P2.1** `WorkingSetManifest` (pure module) +
   `CoherenceJournalReader.readOwnAutonomousRuns` + unit tests.
2. **P2.2a** `working-set-pull` verb (three lockstep edits) + chunked
   serve/receive + never-clobber + pending-pull ledger + integration
   tests.
3. **P2.2b** the `onAccepted` trigger + reflex route + CLAUDE.md template
   + migrateClaudeMd + e2e + peer-visibility guard + live two-machine
   verification on the echo pair (move a quiet test topic with a real
   working file; show the file arriving on the receiving machine,
   hash-verified against the source).

## 8. Open questions for Justin

1. ~~Alongside-copy accumulation~~ — RESOLVED in convergence: cap 2 per
   base file + content-hash idempotent naming + growth counter (§3.5).
2. ~~Live verification approval~~ — RESOLVED: covered by the standing
   24h full-sweep directive (2026-06-06): each step implemented, tested
   thoroughly, live-verified. The P2 live proof uses a quiet test topic,
   never 13481.
