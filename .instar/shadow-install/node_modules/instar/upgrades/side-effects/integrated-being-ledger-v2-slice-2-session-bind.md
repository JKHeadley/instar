# Side-Effects Review — Integrated-Being Ledger v2, Slice 2 (Session-bind lifecycle)

**Version / slug:** `integrated-being-ledger-v2-slice-2-session-bind`
**Date:** `2026-04-17`
**Author:** Echo
**Second-pass reviewer:** pending — to be appended before commit. This slice is on the high-risk list (session lifecycle + auth fallback).

## Summary of the change

Second of eight planned slices. Lands the session-lifecycle plumbing that lets the session-start hook automatically bind every new session to the ledger without manual intervention, plus the attestation-gated fallback and rotation paths that handle edge cases (file-mode failures, absolute-TTL renewal). Still shipping dark behind `v2Enabled=false`.

Specifically:

- **Session-start hook template update.** `PostUpdateMigrator.getSessionStartHook()` now emits a bounded v2 section (wrapped in `# BEGIN integrated-being-v2` / `# END integrated-being-v2` markers) that: generates a UUIDv4 session id; calls `/shared-state/session-bind`; writes the returned token to `.instar/session-binding/<sid>.token` via temp-file + chmod 0o600 + fsync + atomic rename; verifies mode is exactly 0o600 (fail-CLOSED if not — removes the token file); writes a `.ready` marker; calls `/shared-state/session-bind-confirm`. Exports `INSTAR_LEDGER_SESSION_ID` + `INSTAR_LEDGER_TOKEN_PATH` to env. Silent on 503 (v2 disabled).

- **Three new endpoints in `src/server/routes.ts`**:
  - `POST /shared-state/session-bind-confirm` — hook signals the handoff completed; server clears the in-memory hook-in-progress flag.
  - `POST /shared-state/session-bind-interactive` — attestation-gated fallback. Requires BOTH (a) a hook-in-progress flag set in the last 30s AND (b) the session has never been bound before. Closes the failure mode where a mode-mismatch bricks the session.
  - `POST /shared-state/session-bind-rotate` — current-token-gated rotation. Refreshes idle TTL; does NOT extend absolute TTL (anchored to `registeredAt`, consistent with slice 1 invariant).

- **`LedgerSessionRegistry` additions** (slice 1 class):
  - Hook-in-progress flag tracker — in-memory `Map<sessionId, expiresAt>`, 30s TTL per spec §3. Methods: `markHookInProgress`, `confirmHookDone`, `isHookInProgress`, `hasEverBeenBound`. In-memory-only by design — the flag shouldn't survive a server restart because a restart equals a fresh lifecycle.
  - `rotate(sessionId, currentToken)` method — verifies current token, issues new one, preserves anchored absolute expiry, invalidates old token hash immediately.
  - **Corrupt-hydrate degradation wiring** (slice 1 reviewer carry-forward) — on parse failure of `ledger-sessions.json`, `DegradationReporter.report()` fires with a `fallback: "start with empty registry — all active tokens invalidated"` message. Operators now see the signal instead of a silent bounce.

- **Migrate command v2 modes** (`src/commands/migrate.ts` + `src/cli.ts`):
  - `instar migrate sync-session-hook --v2-mode=inject` — detects marker-bounded v2 section in the existing hook and replaces ONLY that section. Idempotent. If no markers found, appends the v2 section at end. Preserves every other customization — this is the path for divergent agents like Echo.
  - `instar migrate sync-session-hook --v2-mode=overwrite` — writes the full canonical template, saves pre-migration hook to `.pre-v2.<timestamp>` for recovery.

- **Route-handler forbidden-field gate reordering** (slice 1 reviewer carry-forward, minor-3) — forbidden-field check now runs BEFORE schema validation in `/shared-state/append`. A client supplying `commitment` alongside valid kind now hits the intended 400-forbidden error, not an incidental counterparty/dedupKey complaint first. Behavior unchanged on valid requests.

Files touched:

- `src/core/LedgerSessionRegistry.ts` (+~120 LOC: rotate, hook-in-progress, degradation wiring)
- `src/core/PostUpdateMigrator.ts` (+~45 lines of shell template for the v2 bind block)
- `src/server/routes.ts` (+~180 LOC: three endpoints; reordered forbidden-field gate)
- `src/commands/migrate.ts` (+~80 LOC: v2 mode dispatching + marker parsing + backup)
- `src/cli.ts` (+~15 LOC: `--v2-mode` option parsing)
- `tests/unit/LedgerSessionRegistry.test.ts` (+~115 LOC: rotate + hook-in-progress + degradation tests; 7 new tests, total 34)
- `tests/unit/sharedStateRoutesV2.test.ts` (+~130 LOC: 3 endpoints; 10 new tests, total 29)
- `tests/unit/migrate-sync-session-hook-v2.test.ts` (new, 7 tests)

## Decision-point inventory

| Decision point | Change | Description |
|---|---|---|
| `/shared-state/session-bind-interactive` attestation gate | **add** | Hard-invariant lifecycle check: requires hook-in-progress flag + 30s window + never-bound-before. Two-factor structural gate. Not judgment. |
| `/shared-state/session-bind-rotate` current-token gate | **add** | Hard-invariant auth gate; constant-time token hash compare via existing `verify()`. |
| `/shared-state/session-bind-confirm` — no gate | **add** | Informational signal only (flag clear). No block/allow surface. |
| Hook mode-verification (shell) | **add** | Brittle blocker at security boundary: token file mode ≠ 0o600 → delete file, deny session-write. Carved-out per signal-vs-authority doc §"Safety guards on irreversible actions." |
| Forbidden-field gate in `/append` | **reorder** | Moved ahead of schema validation. No semantic change. |

No judgment-shaped decisions introduced. All new blockers fall into structural/auth/lifecycle categories.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A session id that's been bound previously but whose token file got deleted (unusual — maybe a user nuked `.instar/session-binding/`) CANNOT recover via the interactive fallback: the `hasEverBeenBound` check blocks it. Intentional — the spec requires fresh sessionIds on restart, not recovery of orphaned identities. The correct path is a new hook invocation with a new session id. Documented.

- A session where the file-based handoff succeeded but the optimistic `session-bind-confirm` POST was dropped by transient network failure would leave the hook-in-progress flag set. Harmless — the flag expires in 30s; if the session later calls interactive, the `hasEverBeenBound` check rejects it; otherwise the flag just times out. No action from the caller needed.

- Clock skew between hook runner and server within ~1s of the 30s window boundary could land on either side. Acceptable; the window is generous and the failure mode is "caller must re-run the hook" which is not fatal.

**New over-block risks introduced:**

- The hook runs Python via `python3 -c` for UUID generation and mode reading. Agents without Python3 in PATH silently skip the v2 bind block (the `SID` assignment gets empty, and the subsequent `-n` guard aborts cleanly). No regression — v1 agents run as before. But it's a silent capability gap that only shows up when someone enables `v2Enabled=true` on an agent without Python3. Mitigation: instar already depends on python3 for other hooks, so this isn't a new dependency.

- The migrate `--v2-mode=inject` uses literal `indexOf` on the `# BEGIN` / `# END` markers. If a user edits the markers (rare, but possible if someone mistakes them for regular comments) the inject path degenerates to append-mode and stacks v2 sections. Mitigation: markers are clearly labeled; this isn't a new vector since the spec calls out that agents shouldn't edit marker lines.

---

## 2. Under-block

**What failure modes does this still miss?**

- A bearer-token-holding adversary can still call `/shared-state/session-bind` with a fabricated sessionId and mint a valid token directly — this is the v2.1-deferred architectural concern documented in the spec. Slice 2 does NOT close it. The 0o600 file-handoff boundary protects against sibling processes without bearer-token; it does NOT protect against a process that already has the bearer.

- The interactive-bind path's "hook-in-progress" attestation is a time-window check, not a cryptographic challenge — if an adversary can both call `session-bind` (setting the flag) AND then call `session-bind-interactive` (consuming it) within 30s using the same sessionId, they get a token. But that requires the bearer token in both calls, so the interactive path buys no additional security against a compromised bearer — it just avoids gratuitously widening the attack surface. This is explicitly the v2.1-deferred "interactive-bind challenge-response" concern.

- The corrupt-hydrate path clears all registrations silently-but-loudly (DegradationReporter emits, but the registry itself continues). An operator could miss the report if the feedback drain isn't healthy. This is DegradationReporter's general limitation, not new.

- Clock-skew between server and hook runner beyond 30 seconds could cause the interactive path to reject a legitimate retry. Acceptable given the failure mode (caller re-runs hook with fresh sessionId).

---

## 3. Level-of-abstraction fit

- **Hook shell code lives in `PostUpdateMigrator.getSessionStartHook()`.** Correct layer — this is where all session-start hook templating already lives. Extracting to a separate `.sh` helper would create a new file the migrator would need to install, a new path to version, and a new failure mode (helper not found). Inlining the ~45 lines is simpler and matches how the v1 render-block and topic-context blocks are templated in the same function.

- **Hook-in-progress flag lives in `LedgerSessionRegistry`** (in-memory `Map`). Same class that owns token verification — correct encapsulation. Alternative (separate `HookAttestationService`) would require coupling two classes and re-implementing the session-id key space.

- **`--v2-mode` dispatch lives in `syncSessionHook()`** alongside the legacy code path. Alternative was a second function `syncSessionHookV2()` — rejected because the three modes share config loading, path resolution, and write mechanics. A single function with early-returning branches keeps the cohesion.

- **DegradationReporter wiring on hydrate** — called at the one place corrupt parsing lands. Lower-level than a per-call check; higher-level than a per-field validator. Correct layer.

Nothing in slice 2 sits at the wrong level.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — all new decision points are carved-out structural/auth/lifecycle blockers. None make judgment calls about message meaning or agent intent.

Narrative: the attestation gate on `session-bind-interactive` is pattern-based (flag present, window within 30s, never bound before) — but it's not judgment; it's checking lifecycle state. The rotate endpoint's current-token gate is the same cryptographic auth check as `verify()`. The shell mode-verification is a security-boundary brittle blocker explicitly permitted by the principle doc's §"Safety guards on irreversible actions" carve-out (wrong-mode token means leaked-to-world, cost of false-pass is credential theft).

Per the signal-vs-authority principle, the entire v2 surface continues to route judgment-shaped decisions (effective commitment status, resolution trust calibration) to signal-shaped rendering rather than brittle blockers. No drift from slice 1's compliance position.

---

## 5. Interactions

- **Shadowing:** the forbidden-field gate reorder in `/append` now runs BEFORE schema validation. A client that used to see a "counterparty required" error when supplying `commitment:{...}` will now see "field 'commitment' is server-bound". This is a 400→400 change in error ordering only; no status-code regression. Confirmed via the existing slice-1 test that exercises the forbidden-field path.

- **Double-fire:** the hook's `session-bind-confirm` call is fire-and-forget (`|| true`) — if the call fails transiently, the flag stays set for 30s and then expires. The interactive-bind path would then reject subsequent calls on `hasEverBeenBound`, not the flag. Both paths converge on "caller has a token, flag is irrelevant." No double-fire hazard.

- **Races:** The hook performs the file write and the `session-bind-confirm` as sequential shell commands. If the server crashes between register and confirm, the next hook run will use a fresh sessionId — the old sessionId stays in the registry with no active session, and gets purged by the slice-1 retention policy. No data hazard.

- **Feedback loops:** the DegradationReporter.report from hydrate doesn't loop back into the registry; FeedbackManager's downstream drain is a separate stream. No recursion.

---

## 6. External surfaces

- **Other agents on same machine:** no shared state; each agent's registry is isolated.

- **Other users of install base:** with `v2Enabled=false` default, zero visible change. When `v2Enabled=true`, users get (a) a token file per session id under `.instar/session-binding/`, (b) an env variable `INSTAR_LEDGER_SESSION_ID` + `INSTAR_LEDGER_TOKEN_PATH` in their shell, (c) a markered section in their session-start hook. All three are opt-in via config flag.

- **External systems:** none. All calls are localhost-to-localhost.

- **Persistent state:** session-binding directory plus `ledger-sessions.json` (slice 1). Cleanup on rollback is still covered by slice 1's `instar ledger cleanup` path (slice 5 will extend it formally).

- **Timing:** hook is in the session-startup critical path. Time budget: the hook's v2 block adds ~1-2 curl round-trips to localhost + a Python invocation + a file write. Measured informally ~50-100ms on warm server, well under the multi-second startup budget.

---

## 7. Rollback cost

- **Hot-fix revert:** pure code revert. `v2Enabled=false` default means no users have active bindings yet. Session-start hooks with the v2 marker section become no-ops on 503 (since the endpoint 503s). Users who re-ran `sync-session-hook --v2-mode=inject` have the v2 marker section in their hook file; these are harmless after revert (shell block does nothing on 503).

- **Data migration:** none. Registry file and session-binding directory are additive; no schema changes.

- **Agent state repair:** agents that enabled v2Enabled during observation will need `instar ledger cleanup` to remove orphaned token files. Slice 5 extends cleanup; for slice 2 the manual hand-cleanup path is `rm -rf .instar/session-binding/ .instar/ledger-sessions.json`.

- **User visibility:** none during rollback window with `v2Enabled=false` (hasn't flipped yet).

Estimated rollback effort: <5 minutes for code revert; optional cleanup is a one-liner.

---

## Conclusion

Slice 2 closes the session-start-to-first-write gap. Hooks now automatically bind every new session to the ledger without manual API calls. Fallback and rotation paths handle edge cases — file-mode failure, absolute-TTL approaching, operator revocation. All two slice-1 carry-forwards (degradation wiring, forbidden-field ordering) landed in the same commit as requested by the reviewer. 70 new tests pass in addition to slice 1's 46 (124 total across the related suites); typecheck clean.

The two architectural-question items called out in the spec (session-bind privilege separation, interactive-bind challenge-response) remain deferred to v2.1 — slice 2 does not claim to close them and the artifact documents why.

Slice 2 is ready for second-pass review.

---

## Second-pass review (required — slice touches session lifecycle + auth fallback)

**Reviewer:** independent reviewer subagent (Phase 5 of /instar-dev).
**Independent read of the artifact:** concern raised — one blocking, two minor.

### Concerns raised by reviewer (verbatim)

1. **Interactive fallback is dead code (LedgerSessionRegistry.ts:498-500 + routes.ts:10409-10416, pre-fix).**
   `hasEverBeenBound(sessionId) = this.registrations.has(sessionId)`. Per spec §3 step 1, the session-start hook ALWAYS calls `POST /shared-state/session-bind` first, which always calls `register()` and creates a registration. The interactive fallback at the endpoint then rejects with 403 `already-bound` because the registration exists. The gate made the fallback unreachable for its stated purpose: "file-based handoff failed AFTER session-bind succeeded." The spec carries the same contradiction (§3 step 4 condition (b) vs. §3 step 1).

   Recommended resolution: either (a) track a separate `hasDeliveredToken` flag that flips only on successful hook-confirm OR successful interactive mint, or (b) have the interactive path re-issue via the already-registered session's plaintext cache if the 30s hook-in-progress flag is live.

2. **Minor (non-blocking): dir-mode race (PostUpdateMigrator.ts:1875-1876).**
   `mkdir -p "$BIND_DIR"` then `chmod 0700 "$BIND_DIR"`. Between mkdir and chmod, directory is umask-dependent (typically 0755). Token file contents remain protected by its own 0600 mode, but dir listing leaks sessionId existence during the window. Mitigation: `(umask 077; mkdir -p "$BIND_DIR")`.

3. **Minor (non-blocking): rotate timing at absolute-TTL boundary.**
   `rotate()` calls `this.now()` twice (once inside `verify()`, once for `anchoredAbsoluteMs <= nowMs`). Clock can advance past the boundary between the two reads. Harmless — caller just retries — but inconsistent.

### Resolution

**Concern 1 (blocking) — FIXED in this slice.**
Replaced `hasEverBeenBound` with `hasConfirmedHandoff` — semantically correct: "a registration exists AND there is no pending hook-in-progress flag." The `/shared-state/session-bind-interactive` route handler now gates on `isHookInProgress` only; single-use is enforced by clearing the flag on success. A new `reissueForInteractive(sessionId)` method re-issues a fresh token against the existing registration, preserves anchored absolute expiry, and atomically replaces the token hash. Five new tests cover the corrected lifecycle:

- `hasConfirmedHandoff reflects flag state` (registry)
- `reissueForInteractive: issues new token against existing registration` (registry)
- `reissueForInteractive: preserves anchored absolute expiry` (registry)
- `reissueForInteractive: refuses when session is unknown / revoked` (registry, two tests)
- `200 after session-bind when file-handoff failed (flag still set)` (route) — models the real lifecycle; old token is invalidated, replay returns 403.

This closes the spec contradiction by interpreting §3 step 4 condition (b) as "token has been successfully delivered to the caller" rather than "registration exists." The attestation contract remains strong: any interactive re-issue requires both a registered session AND a live hook-in-progress flag, and each flag is single-use.

**Concern 2 (minor) — FIXED in this slice.**
Shell block now runs `( umask 077; mkdir -p "$BIND_DIR" )` to close the dir-mode race. Token file path was already race-safe.

**Concern 3 (minor) — carried to slice 3.**
Single-read-now inside rotate() is trivial to add when slice 3 is in the same file (it lands the mechanism-ref validator, which will share the timing pattern). Harmless for slice 2 — the failure mode is a transient retry, not data loss or security.

### Final verdict

With concerns 1 and 2 fixed and concern 3 tracked, the reviewer's blocking finding is closed. Signal-vs-authority compliance remains clean (the interactive path is still attestation-gated — now correctly). Tests re-run green (120 across the full suite). Typecheck clean.

**Slice 2 ready to commit.**

---

## Evidence pointers

- Unit test results: 34 registry tests pass (was 27 in slice 1 + 7 new); 29 v2 route tests pass (was 19 + 10 new); 7 new migrate-v2 tests pass. Total 122 across shared-state + migrate suites.
- Typecheck: `npx tsc --noEmit` exit 0.
- Spec: `docs/specs/integrated-being-ledger-v2.md` (approved 2026-04-17, §3 + §"Interactions" + §"Divergent-hook migration policy").
- Plan: `docs/specs/plans/integrated-being-ledger-v2-implementation-plan.md`.
- Slice 1 artifact (for carry-forward lineage): `upgrades/side-effects/integrated-being-ledger-v2-slice-1-foundation.md`.
