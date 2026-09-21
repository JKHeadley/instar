# Side-Effects Review — Autonomous setup/hook: vault-aware auth + loud registration refusal

**Version / slug:** `autonomous-auth-vault-resolve`
**Date:** `2026-09-21`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see appended section)`

## Summary of the change

`setup-autonomous.sh` and `autonomous-stop-hook.sh` read the server bearer token
with an inline `python3` read of `config.json.authToken`. On a vault-migrated
agent that field is the SecretMigrator placeholder (`{"secret": true}`), so every
server call from both scripts 403'd. On an admission-enforcing install
(windowRunLiveness enforcing), the refused registration left the run `preparing`
forever with no message — the 2026-09-19 silent no-start (ACT-030). This change:

- adds `resolve_auth_token()` (marker `VAULT_AUTH_RESOLVE`) to both scripts:
  config string first, else the vault via `.instar/scripts/secret-get.mjs`;
  replaces 3 reads in setup + 8 in the hook;
- makes a REFUSED registration (401/403) loud, and FATAL only on an
  admission-enforcing install (where an unregistered run structurally cannot
  arm); unreachable-server behaviour is unchanged (best-effort, preparing);
- fixes a pre-existing `set -euo pipefail` + `grep -c` trap in the local
  concurrency fallback that killed the whole setup silently (exit 1, zero
  output) whenever the server was unreachable/refusing and no other topic had a
  state file;
- ships both to existing agents via PostUpdateMigrator: a fingerprint-gated
  marker bump for the setup (`W32_PREPARING_LIVENESS` → `VAULT_AUTH_RESOLVE`)
  and an exact-stock-SHA replacement for the hook (predecessor hash pinned as
  `AUTONOMOUS_STOP_HOOK_PREPARATION_CARRIER_SHA256`). Customized copies are
  skipped by name, never overwritten.

## Decision-point inventory

- `setup-autonomous.sh` registration branch — **modify** — a 401/403 now aborts
  setup on enforcing installs only; everywhere else it prints and proceeds
  exactly as before. No new authority: the server's admission decision already
  governed whether the run could arm; the script now surfaces it instead of
  swallowing it.
- `autonomous-stop-hook.sh` — **no decision change** — same calls, correct
  token; every fail-open/fail-closed path is untouched.
- PostUpdateMigrator — **extend** — two more marker-bump migrations in the
  existing `migrateAutonomousStopHookTopicKeyed` chain.

---

## 1. Over-block

- The new fatal branch triggers only when (a) the install resolved
  admission-enforcing at setup time AND (b) the server answered 401/403. A
  wrong-but-reachable server cannot spuriously abort a non-enforcing agent's
  run (it now prints the two-line ERROR instead of the old "unavailable" line,
  and proceeds). On the enforcing install, aborting IS the correct behaviour: the
  alternative was a run that never arms.
- Config token precedence: a real string in config always wins, so no agent that
  still keeps a plaintext token changes behaviour. No issue identified.

## 2. Under-block

- An enforcing install whose server is UNREACHABLE (not refusing) still writes a
  `preparing` run, as designed — the preparation carrier owns that recovery.
  Deliberately preserved (tested).
- A vault whose `secret-get.mjs` is missing/failing yields an empty token → the
  server refuses → now loud. Previously the same state was silent.

## 3. Level-of-abstraction fit

Token resolution belongs in the scripts themselves: they run standalone (hook
under Claude Code's Stop event, setup from a session) with no TypeScript layer
in-process. The function mirrors the hardened secret-get contract rather than
re-implementing vault decryption.

## 4. Signal vs authority compliance

No new brittle authority. The fatal branch consumes the SERVER's authoritative
admission verdict; the script only stops pretending the verdict was a success.

## 5. Interactions

- `resolve_auth_token()` is called via command substitution, so no memoization:
  each call spawns python3 (+node only when config holds no string). The hook
  already spawns python3 at each of those 8 sites, so the added cost is the node
  startup on vault-migrated agents (~100–200 ms per call, only on paths already
  making a network call).
- The migrations run inside the existing `migrateAutonomousStopHookTopicKeyed`
  chain, AFTER the older bumps: an agent several releases behind is first
  re-deployed by an earlier bump (whose bundled bytes already include this fix),
  and the new bumps early-return on the marker. Order-independent.
- `sign-lockfile`/release hashing consume bundled bytes generically; no test pins
  the setup/hook SHA outside the migration allowlists (checked: the only exact
  hash is the new predecessor constant + the historical allowlist, both
  append-only).

## 6. External surfaces

None. The token still goes only to `localhost:<port>` in an Authorization
header. The vault value is never echoed (stdout of secret-get feeds the variable
only; `set -x` is not used in these scripts). Error messages name the HTTP code,
never the token.

## 7. Multi-machine posture

Machine-local BY DESIGN: each machine's scripts read that machine's config and
vault; runs are per-machine state. The migrations run on every machine's own
update pass, so the fleet converges machine by machine. No user-facing notices
are added beyond the setup's own stderr (read by the session that ran it).

## 8. Rollback cost

Revert the commit and release: the NEXT migration pass does not restore old
bytes (marker bumps only move forward), but the scripts are self-contained —
re-deploying the previous bundle via the same exact-hash path would need one
follow-on migration. Operationally, the fix is strictly additive (correct token,
louder errors); the plausible regression is the fatal branch, whose blast radius
is one refused setup with a printed reason, recoverable by re-running setup.

## Second-pass review

**Reviewer:** independent reviewer subagent
**Verdict:** Concur with the review — no blocking concerns. Two minor notes below (neither warrants a code change).

What was checked:

- **`resolve_auth_token()` leak/hang/wrong-value:** the value only ever reaches the
  function's stdout (captured by `$(…)` at every call site) and a curl
  `Authorization` header; neither script uses `set -x`; `secret-get.mjs` writes the
  value to stdout only (single write, no trailing newline), diagnostics to stderr
  (redirected to /dev/null here), and reads nothing from stdin — no prompt, no hang
  path (python3 `-c` likewise cannot prompt). The placeholder is a real JSON object
  (`SecretMigrator` line 89: `{ secret: true }`), so `isinstance(v,str)` correctly
  yields empty rather than a printed dict; the vault key path is exactly `authToken`
  (KNOWN_SECRET_FIELDS), matching the script's argument. Trailing newlines are
  stripped by command substitution at every caller. Guard placement is safe in both
  scripts: setup runs `set -euo pipefail` and every failure inside the function is
  absorbed (`|| echo ""`, `|| true`, and a false `[[ -f … ]]` inside `if` returns 0,
  so the function always exits 0); the stop hook runs `set -uo pipefail` (no `-e`,
  confirmed at line 26), where the same guards are harmless.
- **Registration branch:** empirically verified that a connection-refused curl under
  `-s … -w '\n%{http_code}' … || echo ""` yields `REG_CODE=000` and an empty body —
  never 401/403 — so an unreachable server still lands in the unchanged
  "registration unavailable" path (also covered by the fourth setup test). The fatal
  branch requires `RUN_STATUS == "preparing"`, which at that point can only come from
  the pre-existing LOCAL enforcing resolution (a 401/403 body carries no
  `initialStatus`), so only admission-enforcing installs abort. The whole block is
  inside `if [[ -n "$REPORT_TOPIC" ]]` — empty-topic behaviour untouched.
- **COUNT pipefail fix:** empirically verified under `set -euo pipefail` that
  `COUNT=$(ls … | grep -cv …) || true` captures grep's `0` stdout on zero matches
  (assignment happens regardless of exit status) and counts correctly (2) when other
  topics' state files exist; the cap comparison then proceeds normally.
- **Migrations:** both are idempotent (marker-presence early-return; re-run asserted
  byte-identical in the tests). Ordering is sound: the earlier hook/setup bumps
  deploy the CURRENT bundled bytes (which contain `VAULT_AUTH_RESOLVE`), so the new
  migrations early-return after them; conversely a PREPARATION_CARRIER-era stock hook
  no-ops through `upgradePreparationCarrier` (marker present) and is caught by the
  new exact-hash gate. Verified the pinned SHA `72027309…` equals the hook blob at
  HEAD/origin-main AND at every other carrier-era commit touching the file
  (bc5453d32, f7ee6efc6, 4272bda3b — all byte-identical), and older stock bytes are
  in the append-only allowlist, which the new upgrade also accepts — so no
  legitimately-stock lineage is stranded; only genuinely customized/unknown bytes
  are skipped, with a named `result.skipped` row (visible, not silent). Executable
  bit: temp-file written `mode: 0o755` + rename (hook) and `chmodSync 0o755` (setup
  helper); asserted in the tests. Label and skip strings in the code match the test
  expectations exactly. Both new test files run green (9/9).
- **Artifact accuracy:** the replaced-read counts (3 setup + 8 hook) match the diff;
  the enforcing-only fatality, unreachable-server preservation, no-new-authority,
  and rollback claims all match the code. Bonus not claimed by the artifact: the
  hook's verification leak-scrub now greps for the REAL token on vault-migrated
  agents instead of the placeholder string — a strict improvement.

Minor notes (non-blocking):

1. §1's "everywhere else it prints and proceeds exactly as before" is right about
   *proceeding*, but the printed text on a non-enforcing 401/403 changes from the
   "registration unavailable" line to the new two-line ERROR — intended loudness,
   just not literally "as before".
2. The new setup comment says the local cap fallback ran "whenever the server was
   unreachable/refusing"; a *refusing* server that returns JSON (`{"error":…}`)
   actually parses `allowed` as `None`, which skips the `unknown` fallback branch —
   pre-existing behaviour, unchanged by this diff; only the comment's wording is
   slightly broad.
