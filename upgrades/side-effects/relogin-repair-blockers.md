# Side-Effects Review — why a sign-in repair did not start (repair blockers)

**Version / slug:** `relogin-repair-blockers`
**Date:** `2026-10-26`
**Author:** `Echo`
**Second-pass reviewer:** `codex (GPT family), see end`

## Summary of the change

Tier 1. On 2026-10-26 five Claude accounts on the Mac Mini read needs-reauth and no repair ever started; every refusal was silent. `src/core/SubscriptionReloginRuntime.ts` adds a read-only `blockers()` that, for each needs-reauth account on this machine on a supported provider path, reports `no-open-incident` (no open login-ledger incident on this machine) or the admission refusal from the existing `admissionFor` (same function the scan uses). Accounts whose incident already has a repair row are skipped (the episode already shows its state). `src/core/SubscriptionReloginPolicy.ts` exports `isReloginSupportedPath`. `src/server/routes.ts`: `GET /subscription-relogin` returns `blockers` (local) and merges peers' `blockers` in `?scope=pool`. `dashboard/subscriptions.js`: plain-language line under a needs-reauth cell's Sign in button; machines in `pool.unavailable` say repair is not running there. Template bullet + `migrateClaudeMd()` migration.

## Decision-point inventory

- `SubscriptionReloginRuntime.blockers` — add — observability only; reuses `admissionFor`, no new decision.
- No existing decision point changes.

## 1. Over-block

None: nothing is gated by the new read.

## 2. Under-block

None introduced. The underlying gaps (unreadable credential never corroborates; missing per-machine browser profiles) are now visible but unchanged, on purpose.

## 3. Level-of-abstraction fit

The reason comes from the same admission function the repair scan uses, in the runtime that owns that function; the route only serializes it, the dashboard only words it.

## 4. Signal vs authority compliance

Pure signal. No authority added. Ref `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No judgment point added.

## 5. Interactions

`admissionFor` is called with no current episode, so its one side effect (pinning a leftover login on an existing row) cannot fire. Passkey cell state, backup-code count and evidence reads are the same reads the 5-minute scan already does, once more per dashboard poll; the dashboard polls the pool view, which fans out once per machine. Cost: one ledger list + per needs-reauth account one admission evaluation; bounded by pool size.

## 6. External surfaces

New response field `blockers` on `GET /subscription-relogin` (additive). Dashboard Subscriptions grid gains one text line per blocked needs-reauth cell.

## 6b. Operator-surface quality

The line is plain language, one sentence, no ids; the Sign in button stays.

## 7. Multi-machine posture

Each machine reports its own cells (blockers are machine-local facts); the pool view merges them tagged with machine id and nickname; an older peer without the field contributes none (unknown, not "clear").

## 8. Rollback cost

Pure code; revert removes the field and the line. No persisted state.

## Conclusion

Additive read-only observability; clear to ship after the second pass below.

## Second-pass review

Reviewer (Codex, GPT family, read-only, 2026-10-26), first read: **Changes needed** —
1. The read can write: `admissionFor` → `profileContext` → the profile registry's `listProfiles()`/`resolve()` seed `playwright-profiles.json` when it is absent. → Accepted, recorded: the repair scan (`scanCandidates`) already makes exactly these calls on every service tick, so this read adds no new write class; the seed is the registry's own idempotent default file, not repair state. No repair row, ledger write or login is ever produced (test asserts all three).
2. The pool view turned a failed blocker read (or an older peer without the field) into `[]`, indistinguishable from "nothing blocked". → Fixed: `pool.blockersUnknown` lists those machine ids; the local view omits the field on a failed read.
Re-read after the fix: **Concur.** The reported reason reuses the scan's own policy and no repair-start path was found.
