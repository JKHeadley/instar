# Side-Effects Review — Instar Documents, step A: the core library

**Version / slug:** `instar-documents-core`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see end)`

## Summary of the change

Adds `src/documents/` — the pure core of Instar Documents (spec `docs/specs/instar-document-viewer.md`, approved by Justin 2026-11-10, message 141587): the replicated row format and validator (`rows.ts`), machine-signed per-origin chains (`chain.ts`), salted content blobs (`blobs.ts`), the deterministic fold with per-reader visibility (`fold.ts`), the access rule (`access.ts`), the on-disk store with ingest pipeline, pending re-check, purge, prune, export and merge-restore (`store.ts`), and the text algorithms: projection (`projection.ts`), anchoring with Bitap (`anchor.ts`), two-level Myers diff (`diff.ts`) and content-defined chunking (`chunker.ts`). Eight unit test files, 63 tests.

Nothing imports this library yet: no route, no server wiring, no config, no migration, no hook. It ships fully inert. Steps B–D (routes and sync, people and devices, the page and agent awareness) wire it behind the `documents` dark gate.

Tier 2 (part of a Tier-2 spec). Size: about 2,300 lines of source and tests across 18 files. Effort: spec 6 rounds + verification pass; this step 1 commit attempt so far.

## Decision-point inventory

- `mayDoDocument` (access.ts) — **add** — invariant, deterministic access control (spec §6, irreversible-consequence). Not wired to any route in this step.
- `validateRow` writer table — **add** — invariant format check.
- Re-anchor thresholds (anchor.ts) — **add** — judgment-candidate with floor (never drop a comment, orphan instead).

## 1. Over-block

The validator refuses any row over 4 KiB serialized, any unknown kind and any writer not in the table. A legitimate row can't exceed this because all text lives in blobs; the largest metadata row (a version with 8 parents) is under 1 KiB. No other over-block identified.

## 2. Under-block

The standing re-check is injected (`StandingCheck`); this step supplies no production implementation, so a row's standing is only as good as the check step B wires in. Rows are inert until then.

## 3. Level-of-abstraction fit

Pure library under `src/documents/`, consumed later by routes and sync. Access reuses the team model through an injected `TeamView` (`mayUseConversation`, `sendReachesOwner`, `teamRefusal`, `placeOf`) instead of re-deriving it, which is the layer that already owns those facts.

## 4. Signal vs authority compliance

`mayDoDocument` holds authority over document access, and is deterministic, exhaustive and fail-closed (unknown principal or op → refused). It is not brittle detection: it reads signed facts. Compliant per `docs/signal-vs-authority.md` (authority for an access invariant, not a heuristic gate).

## 4b. Judgment-point check

The only competing-signals point is re-anchoring, declared judgment-candidate in the spec with the never-drop floor and the comment author as arbiter.

## 5. Interactions

None at runtime: nothing calls this code. It imports only `AppRecordSignatures` (verify/sign helpers) and `SafeFsExecutor` (all deletes and atomic writes go through it).

## 6. External surfaces

None in this step. On-disk layout is defined (`<stateDir>/documents/`) but nothing creates it until step B.

## 7. Multi-machine posture

The row format is built for unified replication by vector pull (per-origin chains across documents, `have()`/`rowsBeyond()` paging by bytes); the sync transport itself lands in step B. No machine-local state is introduced except the store's derived indexes, which are rebuilt from the rows.

## 8. Rollback cost

Revert the commit. No data is written by anything in production, so there is nothing to migrate or repair.

## Notes

- Spec §3.5 and §13a wording was aligned after approval with what was built: the test oracle is a brute-force LCS and edit-distance reference written in the tests, not a diff-match-patch test fixture, so no package is added even for tests. Behaviour and format are unchanged.
- The shared worktree `node_modules` was missing `nodemailer` (added on main since that clone was installed); it was installed into the shared clone's `node_modules` without saving, to make `tsc` pass. No repo file changed for it.

## Second-pass review

**Reviewer:** independent reviewer subagent, 2026-11-10 15:32 PST.

Concern raised (four defects), all fixed in this commit with regression tests:
1. A refused row stalled its origin's whole chain → refused rows now keep their chain position and hash (content discarded, `refused.jsonl`), so later rows apply. Test: "a refused row keeps its place…".
2. A person granted the new place lost the history the move disclosed → rows the signed move discloses skip the 2b check. Test: "a person granted the new place sees the history the move disclosed".
3. A PIN-approved owner browser could read shared documents → it is treated exactly as a PIN session.
4. Agent sessions could not reply, and confined sessions saw other places' metadata → `reply` op added; confined sessions see only their own place, metadata included.

Minor notes fixed: owner tombstone needs the phone; a document's owner person may resolve any comment; "own conversation" is an explicit reader kind (no fail-open on empty grants); a second `created` row is refused; agent author keys carry the place; merge-restore starts a new incarnation; restore keeps a blob if any version using it is kept; a fork is detected and counted on ingest; the key-validity time is clamped to now.

Built in step B of this series (the routes and sync step, which wires this library): verifying the phone and browser device signatures in `signedOrigin`, checking that a `primary-set`'s signed `docDeps` names only rows this machine holds and none that descend from or are concurrent with it, and the production standing check from the team log. Step B is on this run's completion bar (topic 141469 autonomous task 5).

Concur after fixes: the four defects are resolved and covered by the new tests.

## Release note review

The fragment `upgrades/next/instar-documents-core.md` was written for this same change after the review above. It claims no user-visible behaviour ("Nothing changes yet"), which matches the review: nothing imports the library. It is not marked internal-only because the change adds runtime source under `src/`, which the gate requires to carry the user-facing sections.
