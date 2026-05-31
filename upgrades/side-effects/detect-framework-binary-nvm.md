# Side-Effects Review — detectFrameworkBinary scans nvm version dirs (bug #10)

**Version / slug:** `detect-framework-binary-nvm`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`detectFrameworkBinaryUncached` now scans `~/.nvm/versions/node/<ver>/bin/<name>`
(running node's version first, then any installed version) after the existing
`NVM_BIN` check. A framework CLI installed only under nvm is now found even when the
server runs under launchd (no nvm shell init → `NVM_BIN` unset, nvm bin off PATH).
Closes bug #10: the mini's session spawn crashed because `claudePath` resolved to
null.

## Decision-point inventory

- **nvm scan** — `~/.nvm/versions/node` exists? push running-version + all-version
  `bin/<name>` candidates : skip. The existing candidate loop returns the first that
  exists. Best-effort try/catch (unreadable dir → no-op).

## 1. Over-block

**What legitimate inputs does this reject?** Nothing. It only ADDS candidates; the
existing candidate loop short-circuits on the first existing path, so machines that
already resolved a binary (homebrew, npm prefix, NVM_BIN, asdf, PATH) return the same
result as before. It cannot make detection return a worse/wrong path — every
candidate is `fs.existsSync`-checked.

## 2. Under-block

**What does this still miss?** It scans the default `~/.nvm` root only (honors no
`$NVM_DIR` override — nvm's standard location; an exotic relocated nvm is still
covered by the `which`/NVM_BIN fallbacks if those are reachable). It does not address
bug #7 (standby outbound mute). It picks the running node's version first, then
directory order — adequate for locating a globally-installed CLI (the same binary is
typically linked across versions).

## 3. Level-of-abstraction fit

**Right layer?** Yes. The scan sits in the single framework-binary detector beside
the asdf-shim handling it mirrors (same launchd-PATH-exclusion rationale), feeding
the same candidate loop. No duplication; benefits every framework name + every
caller (claude/codex/gemini/…).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority. Pure detection widening; gates nothing, blocks nothing. A
failure to scan (unreadable dir) is swallowed and falls through to the existing
fallbacks.

## 5. Interactions

Memoized via the existing `_frameworkBinaryCache` (positive + negative), so the dir
scan runs at most once per binary name per process. Feeds `claudePath`/`codexPath`
resolution at config load, which feeds `SessionManager` spawn. No interaction with
the lease/pool/state paths.

## 6. External surfaces

None. No HTTP routes, config, or notifications. The visible effect is a non-null
`claudePath` on an nvm-only machine (so a spawned session has a binary to run).

## 7. Rollback cost

Trivial. Remove the nvm-scan block; an nvm-only machine reverts to null detection
(re-introducing bug #10). No schema, no state, no migration.

## Conclusion

Minimal additive detection widening, mirroring the existing asdf-shim handling for
the same launchd-PATH-exclusion reason, both the functional (NVM_BIN-deleted) case
and a source guard unit-tested, no behavior change for already-resolving machines,
trivial revert. Lets a moved session actually start on an nvm-only machine.

## Second-pass review (if required)

Not required — additive detection only, existsSync-guarded, memoized, no authority,
reversible; the functional test proves it resolves WITHOUT NVM_BIN (the launchd case).
The live two-machine re-test is the Tier-3 gate that follows.

## Evidence pointers

- `tests/unit/detectFrameworkBinary.test.ts` — resolves a binary in a temp nvm
  version dir with NVM_BIN DELETED; source-guard that Config.ts scans the nvm dirs.
- 24 detection + loadConfig tests green; `tsc --noEmit` clean.
- Verified live in the mini server's node env: `detectClaudePath() => null`,
  `NVM_BIN: (unset)`, PATH has no nvm bin — the spawned session died at startup.
- Spec: `docs/specs/detect-framework-binary-nvm.md` (+ `.eli16.md`).
