---
title: "Bounded Accumulation — Every Persistent Store Carries Its Own Ceiling: Spec"
slug: "bounded-accumulation-standard"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "bounded-accumulation-standard.eli16.md"
status: "draft"
approved: false
parent-spec: "docs/STANDARDS-REGISTRY.md (new standard in the family of 'No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes' [P19] and 'Bounded Notification Surface' [P17]); docs/specs/STATE-COHERENCE-REGISTRY.md (the EXISTING registry this EXTENDS, not replaces); docs/planning/2026-06-20-forkbomb-prevention-plan.md (Bounded Blast Radius — the compute/capacity twin whose lint+burst-test-same-PR enforcement this mirrors)"
lessons-engaged:
  - "Structure beats Willpower: the 'leverage trees / avoid single accumulation points' value existed but was enforced nowhere — a wish. This gives it teeth (lint + growth-burst test that fail the build), as Bounded Blast Radius did for compute mass."
  - "No Silent Degradation / honest coverage: a lint that LOOKS complete but is statically evadable is worse than none. §3 states the evasion class explicitly and pairs the (incomplete) lint with the runtime burst-test (complete for what it exercises) and an accessor-funnel that makes raw persistence itself a lint failure."
  - "Migration Parity (NON-NEGOTIABLE): deployed agents already hold the bloat — the retrofit reaches them via PostUpdateMigrator + migrateConfig, not only new installs (§4.5). A fix that only helps new agents is broken."
  - "Cross-Machine Coherence: the WS2 coherence-journals are the replication substrate (seq watermarks + inline tombstones); naive rotation breaks sync and resurrects deleted PII. They are CARVED OUT and handled by their own protocol-aware mechanism (§4 C-class)."
  - "Self-Unblock 'verified, not self-asserted': the boundedByResolution exemption is a VERIFIED kind (allowlist + drain invariant + backstop ceiling), not a self-applied label — mirrors BlockerLedger.settleTrueBlocker requiring a persisted verified run, not a caller claim."
  - "Signal vs Authority + Maturation Path: the lints are deterministic STRUCTURAL checks (allowed to block, like the funnel lints) but ship warn-then-ratchet; the semantic 'is this store actionable?' judgment stays with author/reviewer, never the regex."
  - "P4 Testing Integrity: three tiers incl. a Tier-3 'feature-alive' E2E (rotation fires in a real server-boot lifecycle) + a NAMED growth-burst invariant asserting ON-DISK bytes stay bounded."
---

# Bounded Accumulation — Every Persistent Store Carries Its Own Ceiling

> **Convergence note (round 1, 2026-06-21):** five-reviewer round 1 found the v1 draft had
> stale prior-art claims and missed major integration realities. This v2 corrects them. The
> single biggest correction: this standard **extends and FIXES existing machinery**
> (`state-coherence-registry.json`, `src/utils/jsonl-rotation.ts`, `CoherenceJournal`), it
> does not invent parallel registries/rotators.

## 1. Problem (the live incident)

Echo's data dir accumulated without bound (measured 2026-06-21):

| Store | Size | Shape | Retention today |
|-------|------|-------|------|
| `server-data/token-ledger.db` | 256 MB | SQLite (queried, not slurped) | **none** |
| `cartographer/index.json` | 91 MB | whole-file JSON | read-path already byte-bounded (`loadIndexBounded`, instar#1069); on-disk still unbounded |
| `semantic.db` / `topic-memory.db` | 27 / 24 MB | SQLite | none |
| `ledger/job-runs.jsonl` | 12 MB | append JSONL | "permanent" |
| `telegram-messages.jsonl`, `feedback.jsonl` | 12–14 MB | append JSONL | none |
| `audit/destructive-ops.jsonl`, `security.jsonl` | 5–9.5 MB | append JSONL (audit trail) | none |
| `state/coherence-journal/peers/*.jsonl` | 5.7 MB | WS2 replication journal (peer-replica) | own-streams rotate; **peer-replica side does not** |

Two structural failures, **neither caught by any existing guard**:

1. **Unbounded append-only logs** — one line per event forever, no rotation/cap.
2. **Whole-file synchronous reads of multi-MB snapshots block the single Node event loop**
   — a *direct cause* of the residual low-CPU `/health=000` event-loop stalls (#1239 proved
   this mechanism on the 1.6 MB commitments store). The cartographer index was the original
   wedge of this class; its read path is now byte-bounded (instar#1069) — this standard
   *generalizes* that point-fix into a rule, rather than re-discovering it.

The efficiency VALUE ("leverage trees, avoid single accumulation points") exists as lore but
is enforced by **nothing** — the "Structure beats Willpower" gap Bounded Blast Radius named
for compute mass. This is the storage-dimension twin.

## 2. The standard (proposed registry text, P-number reserved next-in-sequence)

> ### Bounded Accumulation — Every Persistent Store Carries Its Own Ceiling
> **Rule.** Any store persisting across sessions MUST declare, at creation, a retention
> policy bounding its size — a maximum age, entry count, OR byte ceiling — and MUST enforce
> it. A store with no declared ceiling is a defect, like a loop with no brake. No code path
> may read or write a possibly-unbounded file *whole and synchronously* on the server event
> loop; unbounded data is accessed by streaming, segment rotation, or an indexed store
> (SQLite). Retention drops OLDEST-first and LOGS what it dropped — never silent — and NEVER
> deletes an audit/forensic trail (those are archived, not dropped) nor an un-acted
> actionable item (those are bounded by RESOLUTION + a loud backstop ceiling, never silent
> truncation).
> **In practice.** Every persistent store is a row in the existing State-Coherence Registry,
> extended with `retention` + `access` + `coherenceScope` fields. One lint fails any
> persistence primitive whose target is not a registered store with a retention policy; a
> second forbids whole-file synchronous IO of a store marked `streamed`/`sqlite`. A
> growth-burst test asserts on-disk size stays under the ceiling. Rotation is segment-based
> (rename + new file + unlink-oldest), never read-filter-rewrite.
> **Earned from.** 2026-06-21: Echo reached a 256 MB token-ledger, a 91 MB cartographer
> index, and a dozen unbounded JSONL logs; the whole-file reads were a direct cause of
> recurring event-loop stalls (proven on the commitments store #1239; the cartographer index
> guarded by instar#1069 — this standard generalizes those point-fixes).
> **Traces to the goal.** A self-evolving agent runs for months; anything that only grows is
> a slow-motion outage. Coherence over TIME requires every accumulation have a structural
> ceiling, not a hope someone prunes it.
> **Applied through.** `scripts/lint-store-retention-declared.js`,
> `scripts/lint-no-wholefile-sync-read.js`, `tests/integration/store-growth-burst-invariant.test.ts`,
> the extended `src/data/state-coherence-registry.json`, and the segment-rotation fix to
> `src/utils/jsonl-rotation.ts`.

## 3. Enforcement (the teeth — ship SAME PR, graded ratchet)

### 3a. Extend the EXISTING registry (do NOT create a parallel one)
The repo already has `src/data/state-coherence-registry.json` (~85 entries) + `lint-state-registry.js`
classifying every state path by `scope`/`conflictShape`/`transport`. Bounded Accumulation
**extends** each entry with `retention: { maxAgeMs? | maxRows? | maxBytes? | boundedByResolution? | complianceHold? }`,
`access: 'streamed'|'whole-sync'|'sqlite'`, and reuses the existing `scope` as the
`coherenceScope`. One registry, one census, the two new lints read it. (Closes the
two-registry drift finding.)

### 3b. Lint 1 — retention declared (`lint-store-retention-declared.js`)
**The registry can only EXEMPT, never DEFINE, the scan surface.** Lint 1 flags any
**persistence primitive by call-shape** — `fs.appendFileSync`/`writeFileSync`/`createWriteStream`
to a non-temp path, `new Database(...)`/`better-sqlite3(...)` — regardless of whether the path
is a static literal, and fails the build if the resolved store is not a registry member with a
non-empty `retention`. **Not-registering a store is the failure, not an escape.** To make
dynamic-path stores tractable, all persistence MUST route through a registered accessor
(`JsonlStore`/`SqliteStore` in `src/core/storage/`); raw `fs`/`Database` in `src/` outside that
module is itself a Lint-1 failure (the accessor is the funnel the lint matches, closing the
wrapper/dynamic-path evasion). **Coverage honesty (No Silent Degradation):** static analysis
cannot reach every runtime-/template-emitted writer; Lint 1 is a guardrail, the runtime
burst-test (§3d) is the complete check for stores it exercises, and the accessor-funnel is what
makes the guardrail load-bearing. Scope: `src/` + `templates/` writers; purely user-authored
custom hooks are an accepted, documented gap.

### 3c. Lint 2 — no whole-file sync read of a bounded path (`lint-no-wholefile-sync-read.js`)
Annotation-driven (no magic MB number): fails any `readFileSync`/`writeFileSync`/
`JSON.parse(fs.readFileSync(...))` whose store is registry-marked `access:'streamed'`/`'sqlite'`.
A store MUST be marked `streamed` once it can exceed **8 MB** (the declared rule for "too big for
whole-sync"; below that whole-sync is permitted). This **subsumes and generalizes** the existing
hardcoded `lint-no-mainthread-cartographer-walk.js` `.loadIndex(` ban into one path-keyed lint
(cited as prior art, not a gap). Matching strategy: match the registered accessor / declared
path-suffix against string literals in the call expression; residual false-negatives for fully
dynamic paths are a documented limitation backstopped by the accessor-funnel.

### 3d. Growth-burst invariant test (`store-growth-burst-invariant.test.ts`)
Storage analog of `notification-flood-burst-invariant.test.ts`: per retention KIND, construct a
store with a SMALL injected ceiling (`maxBytes: 64 KB`), write M=2000 entries, and assert (a)
on-disk bytes (active file + retained segments via `statSync`) ≤ ceiling + one-segment slack,
(b) retained rows are NON-EMPTY after a normal-rate write (catches a too-aggressive `maxAgeMs`
typo nuking the store), and (c) the rotation code path issues **zero** `readFileSync`/whole-file
`writeFileSync` of the active store (asserts §3.5). Sub-second, deterministic.

## 3.5. Rotation machinery MUST NOT itself block the loop (the load-bearing fix)
The existing `src/utils/jsonl-rotation.ts` `maybeRotateJsonl` rotates via
`readFileSync`+`split`+`writeFileSync` — **exactly the whole-file sync IO this standard
forbids** (a 14 MB `telegram-messages.jsonl` rotation = a multi-hundred-ms freeze on the hot
append path). This standard FIXES it: rotation is **segment-based** — `renameSync(active,
active.NNN)` + open a fresh empty active file (an O(1) metadata op, no read), and trimming
unlinks the oldest closed segment. The read-filter-rewrite path is retired for any
`streamed` store. The per-append retention CHECK is a **cached byte-counter** (bump in memory
on append, `statSync` only every N appends/seconds), never a per-event `statSync` and never a
row-count read. `maxRows` on JSONL is forbidden (it implies a whole-file scan); JSONL bounds
are byte/age segment rotation only.

## 4. Retrofit (Increment 2 — reuse existing machinery; concrete ceilings frontloaded)

Reuse `src/utils/jsonl-rotation.ts` (post-§3.5 fix) and the existing `CoherenceJournal.maybeRotate`,
`ThreadLog`, `AuditTrail` rotators — do NOT fork new ones. **Concrete per-store ceilings:**

| Store | Class | Ceiling (default) |
|-------|-------|-------|
| `token-ledger.db` | sqlite | `maxAgeMs` = 30 days (see §6 D1; SQLite mechanics below) |
| `telegram-messages.jsonl` | streamed | `maxBytes` = 32 MB, 4 segments |
| `ledger/job-runs.jsonl` | streamed | `maxBytes` = 32 MB, 4 segments |
| `feedback.jsonl` (factory) | streamed | `maxBytes` = 32 MB, 4 segments |
| `semantic.jsonl` | streamed | `maxBytes` = 32 MB, 4 segments |
| `audit/destructive-ops.jsonl`, `security.jsonl` | **complianceHold** | gzip-archive segments, **never deleted** (§4 C-class) |
| `state/coherence-journal/**` | **must-be-coherent** | handled by the existing protocol, EXCLUDED from generic rotation (§4 R-class) |
| `cartographer/index.json` | streamed | already `loadIndexBounded`; on-disk segmentation = its own increment (§4, M2) |

**A-class (generic streamed JSONL):** segment rotation via the fixed `maybeRotateJsonl`, before
dropping a segment a **low-watermark check** ensures no registered reader/replicator
(TokenLedgerPoller byte-offset, WS2 replication cursor) is below it.
**C-class (compliance / audit):** `security.jsonl`, `destructive-ops.jsonl` are forensic trails —
rotated segments are **gzipped and retained (cold archive), never drop-deleted**. The standard
forbids drop-deletion of any audit-classified log. (Closes the silent-audit-loss CRITICAL.)
**R-class (replication substrate):** `state/coherence-journal/` own-streams AND `peers/*.jsonl`
are EXCLUDED from external rotation — they carry seq watermarks + inline tombstones; naive
truncation breaks peer sync and resurrects deleted PII. Size pressure there is handled by
LOWERING `KindRetention.maxFileBytes` inside the existing protocol (which already guards with
`oldestRetainedSeq` + tombstone-horizon). The real measured bloat — the **peer-replica** side —
is bounded by a receive-side cap in `JournalSyncApplier` (drop-and-re-pull / compact-to-folded-head),
NOT an external `.gz` rotator.
**SQLite (token-ledger.db):** set `PRAGMA auto_vacuum=INCREMENTAL` at creation; retention =
batched `DELETE WHERE ts < cutoff LIMIT N` + bounded `PRAGMA incremental_vacuum` on a 6 h timer
(mirroring the real feature-metrics prune at `AgentServer.ts`), never on the request path. The
existing 256 MB file needs the §5 one-time VACUUM to convert. (Corrects the false
"feature-metrics already does this for token-ledger" attribution — feature-metrics is a separate
store; token-ledger has zero retention today.)
**Readers-of-bounded-files inventory:** the dashboard File Viewer download, backup tooling, the
cartographer loader — each must tolerate segmentation; the cartographer on-disk segmentation is
its own increment (an architecture change, the only one tied to the live event-loop incident).

## 4.5. Migration Parity (NON-NEGOTIABLE — reaches deployed agents)
Deployed agents already hold the bloat. The retrofit ships to them: (a) per-store retention
config defaults land via `migrateConfig()` (existence-checked); (b) the StoreRegistry retention
fields + the rotation code path ship in the server, so they apply to existing stores on next boot
(dark-then-ratcheted); (c) a `PostUpdateMigrator.registerStep` idempotent backfill arms per-store
rotation; (d) the lint ratchet baseline is a **static repo snapshot** (build-time CI), distinct
from the per-agent runtime retrofit, so a deployed agent's extra stores don't fail the repo
ratchet. (Closes the "only-new-installs" gap.)

## 5. One-time cleanup (Increment 3 — IRREVERSIBLE, operator-gated, SafeFs-routed)
Trim the current on-disk bloat (token-ledger.db VACUUM-convert, cartographer index migrate,
oversized A-class JSONLs). Guards: (a) routes through **`SafeFsExecutor`**, never raw `rmSync`;
(b) runs with the store's owning module's **close→truncate→reopen** path or server-stopped — never
a raw delete against a live SQLite/file handle (avoids the unlinked-inode / torn-parse hazard);
(c) ships as a **manual operator-run route that refuses without an explicit confirmation token** —
never a scheduled job, never auto-fired by the ratchet; (d) a store may be labeled "re-derivable"
ONLY if its source (e.g. Claude Code transcripts for token-ledger) is retained at least as long —
else the loss is surfaced to the operator at cleanup time, never silent. **Held for explicit
operator go** — the one step this spec does not self-authorize (the rising tide is gated).

## 6. Decisions frontloaded (so this completes in one build — zero open questions)
- **D1 token-ledger window = 30 days** (grounded in the feature-metrics `retentionDays:30`
  precedent). *Operator-tunable at approval; safe default chosen.*
- **D2 audit logs (security/destructive-ops) = complianceHold (archive, never delete).** The
  SAFE default — aging out a forensic trail is a compliance defect, so no operator decision is
  forced; archived segments are bounded by archive policy, not dropped.
- **D3 Registry = EXTEND `state-coherence-registry.json`**, not a parallel one.
- **D4 Rotation = segment rename+unlink** (§3.5); read-filter-rewrite retired; `maxRows`-on-JSONL
  forbidden.
- **D5 boundedByResolution is a VERIFIED kind, with a CLOSED allowlist:** `attention-queue`,
  `resume-queue`, `commitments`, `pending-relay`, `pending-inject`, `spawn-requests`, `secret-store`,
  `blocker-ledger`. Each MUST declare a **drain invariant** (a terminal-state field the store can
  prune on) AND a **backstop**: a max-OPEN-item ceiling that, when breached, raises a LOUD
  attention item (never a silent drop, never infinite); terminal/resolved rows ARE truncatable
  oldest-first. Such stores MUST be `access:'sqlite'|'streamed'` (never whole-sync). Adding a
  store to the allowlist is a ratcheted, reviewed change — not a free self-applied tag.
- **D6 Ratchet = SET monotonicity over a FROZEN/generated baseline snapshot** (the baseline set
  never gains members; a new undeclared store fails). Per-PR gate = **non-increase**; strict
  decrease is the tracked retrofit cadence (§4), not a per-PR merge condition (so unrelated PRs
  don't deadlock and a count-swap can't game it).
- **D7 Increment 1 (registry extension + 2 lints + §3.5 rotation fix + burst test) is
  non-behavioral** and ships first. Increment 2 = A/C/R-class retrofit + SQLite + migration.
  **Increment 2b = cartographer on-disk segmentation** (split out — the only true architecture
  change). Increment 3 = operator-gated cleanup.
- **D8 The standard applies to its OWN machinery:** the drop-log and the gz archive dir are
  registered stores with their own ceilings (archive-total-bytes cap, compliance-hold excepted).
- **D9 Sane-floor guard:** Lint 1 flags a suspiciously small `maxAgeMs` (< 1 h) / `maxBytes`
  (< few KB) requiring an override comment (catches a units typo that would nuke a store).

## 7. Testing (three tiers, NON-NEGOTIABLE)
- **Unit:** registry retention/access/scope validation; each lint's pure matcher (declared
  passes / undeclared fails; whole-sync of a `streamed` path fails / streamed passes; the
  accessor-funnel catches raw-fs-in-src); the segment rotator issues zero whole-file IO; the
  low-watermark check blocks a premature segment drop; the boundedByResolution backstop fires.
- **Integration:** the growth-burst invariant (§3d) per retention kind; JSONL segment rotation
  bounds on-disk bytes; the C-class never drop-deletes; the R-class carve-out leaves
  coherence-journal sync intact (seq contiguity + a tombstone survives).
- **E2E (feature-alive, the load-bearing tier):** boot the server with a registered
  over-ceiling store and assert the rotation/retention sweep FIRED in the real lifecycle
  (bounded state, 200 not 503) — the storage analog of the "feature is alive" alive-test.
- **Ratchet:** CI fails on a new undeclared store or a new whole-file-sync read of a `streamed`
  path; baseline set membership is monotonic-non-increasing.

## 8. Open questions
*(none — all decisions frontloaded in §6 with safe defaults; D1/D2 are operator-tunable at the
approval checkpoint but ship with safe defaults so the build is not blocked.)*
