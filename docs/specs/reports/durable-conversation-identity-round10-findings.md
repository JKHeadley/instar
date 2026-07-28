# Round-10 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `dd9c56742`
("round-10 revision — resolve round-9 findings (0 CRITICAL + 1 MAJOR + 1 MINOR + 3 LOW) +
two cross-verified residuals").
**Report commit:** this file.
**Round-10 status: NOT CONVERGED.** 0 CRITICAL + 1 MAJOR + 2 MINOR + 1 LOW.

Round 10 verified that **all round-9 findings and both cross-verified residuals are
genuinely resolved in the body** — BOTH externals confirmed every site: the R9-M1
watermark floor with its §10 shape; the R9-minor-1 missing-lane retry rule; the three R9
LOWs (Appendix A provenance, the deploy stamp in the backup manifest, staged post-compose
appends); the per-lane restatement of the §10 composite-key shape; and the three appendix
REFINED markers. Gemini additionally walked the watermark floor's interactions with
rotation, pruning, journal-only rebuild, and the backup manifest and found them consistent.

The one blocker is the round-10 fix's own remaining seam — the fourth consecutive round in
which the finding surface sits entirely on the newest machinery (now two levels deep in
repairs of the R8-minor-2 unknown-op rule). The registry core is finding-free for the
fourth consecutive round.

---

## Reviewers who ran this round

**Internal pass (one consolidated multi-lens review by the folding agent, run against the
committed revision; nothing was folded pre-external):** adversarial,
crash/replay-composition, fail-direction, decision-completeness perspectives. Confirmed
the external MAJOR by independent re-derivation — including the analysis that the current
op enum's unconditional record-install semantics happen to converge under re-application,
so the hazard's live victims are FUTURE (conditional) ops, which is exactly the population
the unknown-op rule exists for — and derived the simpler fix the round-11 revision adopts
(suspension) rather than the external's first two heavier arms. Contributed one editorial
item folded into round 11 (an UNRECOGNIZED `lane` value gets the same treatment as a
missing one).

**External cross-model passes (one bounded pass each), both EXECUTED by this session
against the committed spec file immediately after the dd9c56742 revision commit:**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`, `--no-session --no-tools
  -p`, spec inlined** — RAN (exit 0). Verdict line:
  `VERDICT: 0 CRITICAL + 1 MAJOR + 1 MINOR + 1 LOW`. It explicitly verified the full
  round-9 fold table landed. Its MAJOR is confirmed by internal re-derivation as R10-M1;
  its MINOR and LOW are confirmed as MINOR-1 and LOW-1.
- **gemini-cli, `-o json -m gemini-2.5-pro`, spec on stdin** — RAN (exit 0; 1 API
  request). Serving model captured from the run's own stats block: **gemini-2.5-pro**.
  Verdict line: `VERDICT: 0 CRITICAL + 0 MAJOR + 1 MINOR + 0 LOW`. It verified the fold
  table AND the watermark floor's interaction matrix (rotation, prune, journal-only
  rebuild, backup) — but did not probe the order-dependence hazard pi found (single-pass
  variance, the recurring datum of this ceremony). Its MINOR is confirmed as MINOR-2.
- **codex-cli** — NOT RUN: not installed on this machine (unchanged since round 3).

---

## MAJOR findings (blocking)

1. **The watermark floor fixes replay SELECTION but not snapshot STATE — the snapshot
   still materializes effects of records above the held floor, so an order-dependent
   formerly-unknown op composes wrongly on re-upgrade** `[pi-ext #1; CONFIRMED by internal
   re-derivation]`. Walk: unknown op at seq 100 → known 101…120 apply → snapshot persists
   with watermark HELD at 99 but state ALREADY INCLUDING 101…120's effects → re-upgrade →
   replay applies 100, then RE-applies 101…120 over a state that already contains them.
   For the CURRENT op enum (unconditional record-install transitions) this happens to
   converge to fresh order — but nothing pins that mechanism (§3.4's "replay is
   idempotent" is a property both re-application and skip-if-present satisfy, and
   skip-if-present diverges), and a FUTURE op with conditional semantics (the exact
   population the unknown-op rule serves) breaks even under re-application, because op
   100's transition would read a state that already reflects its own future. Internal
   analysis adopted the simplest of the external's three proposed arms, strengthened:
   **while any unknown-op record remains unapplied, snapshot FLUSHING IS SUSPENDED
   entirely** — the on-disk snapshot stays the pre-floor one (its watermark precedes the
   first unapplied unknown op BY CONSTRUCTION: had the watermark been past it, the op
   would never have been replayed and no suspension would engage). Boot under suspension =
   pre-floor snapshot + full ordered tail replay (unknown ops skipped, deterministic);
   re-upgrade = the SAME pre-floor snapshot + fresh ordered application of the whole tail
   with the formerly-unknown op IN POSITION — correct global order with NO reliance on
   re-application semantics at all. Prune keys on the static pre-floor watermark, so every
   needed file is retained mechanically. Serving is untouched (in-memory state still
   applies known records live; only the CACHE flush suspends). The honest-cost clause
   extends: snapshot staleness + boot-replay length grow for the suspension's duration.
   The watermark-floor §10 shape is REPLACED by the suspension shape (assert NO snapshot
   flush while suspended; assert an order-dependence probe — the formerly-unknown op's
   effect correctly overwritten/preserved relative to later known records under fresh
   ordered replay).

## MINOR findings (polish — batch)

1. **The staged conversion appends' durability class and serving boundary are implicit**
   `[pi-ext #2; confirmed]`. §5.0(a) says the staged appends are written post-compose
   "durably" but §3.4's fsync-class inventory does not name them, and nothing pins
   whether serving may begin before they are durable. A crash after serving starts but
   before the staged append lands re-decides identically at next boot (deterministic), so
   the seam is implementation DIVERGENCE, not loss. Fix: pin the class — staged
   conversion appends are fsynced BEFORE the registry begins serving (boot-time,
   off-hot-path; the same durable-binding class as the intent they resolve).
2. **The §10 unknown-op shape does not assert the attention item's REQUIRED content**
   `[gemini-ext #1; confirmed]`. §3.4 normatively requires the deduped unknown-op item to
   name the held state and unapplied count (the honest-cost observability), but the §10
   shape never asserts it — the guarantee could regress silently. Fix: extend the §10
   suspension shape to assert the item is raised naming the suspension, the pre-floor
   watermark, and the unapplied count.

## LOW findings (cosmetic — batch)

1. Multiple-unknown-op progression deserves its own §10 shape (partial re-upgrade:
   recognize the op at seq 100 but not the one at 150 → suspension PERSISTS; a later
   re-upgrade recognizing 150 ends it) `[pi-ext #3; restated under the suspension
   mechanism]`.
2. A parseable `send-intent` record with an UNRECOGNIZED `lane` value gets the same
   retry-plus-attention treatment as a missing one (the R9-minor-1 rule keyed on "missing"
   only) `[internal]`.

---

## Convergence recommendation

**NOT CONVERGED.**

Blocking: 1 MAJOR — R10-M1, resolved by REPLACING the round-10 watermark-floor mechanism
with the strictly simpler suspension mechanism (less machinery: no held-watermark
snapshots, no re-application-semantics contract; boot under skew = old snapshot + ordered
tail, the composition the spec already trusts everywhere else). Zero CRITICAL for the
fifth consecutive round; the registry core finding-free for the fourth; the finding
surface is a single regime (rollback-with-newer-journal) two repair-levels deep.

What is settled and must NOT be re-litigated next round: everything the round-9 report's
settled list carries; the full round-9 fold table (verified by both externals); the
unknown-op skip-preserve-alert rule; the missing-lane retry direction; the per-lane
composite shape; the appendix markers; gemini's interaction matrix for
rotation/prune/rebuild/backup (which transfers to the suspension mechanism unchanged —
the static watermark only strengthens it).

Recommended next step: a round-11 revision replacing the watermark floor with suspension
(+ the two MINORs and two LOWs — all §3.4/§5.0(a)/§10 pin edits), then Round 11 focused on
the suspension mechanism's seams and a final fresh sweep.

**Verdict: NOT CONVERGED** (0 CRITICAL + 1 MAJOR remaining; converged requires zero MAJOR).
