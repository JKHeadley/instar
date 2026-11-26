# Side-Effects Review — "Login expired" sightings corroborate an unreadable credential into needs-reauth

**Version / slug:** `cli-login-expired-opens-repair`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Closes ACT-153. On 2026-10-22 a Claude pool login (justin-gmail, Mac Studio) died around 11:10Z. `defaultTokenResolver` returned `observationOnly: credential-token-shape-invalid`, which by design records only a provisional observation and never changes status. No usage read was attempted, so no exchange-corroborated needs-reauth could ever fire. Meanwhile `SessionManager.endIfLoginExpired` ended 40+ rerouted job sessions at Claude Code's `Login expired · Please run /login` frame, and its doc said it "never changes the account's pool status". The account stayed `active` for ~8h, sessions kept being placed on it, and the assisted-relogin service never got an actionable episode.

Change:
- `SessionManager` gains `setLoginExpiredSink()`. When `endIfLoginExpired` ends a session after the dwell, it reports `{configHome (live CLAUDE_CONFIG_DIR), session}` to the sink (only when the live config home resolves; a throwing sink is swallowed).
- `QuotaPoller.noteCliLoginExpired()` keeps those sightings in memory per resolved config home (60-min window, max 20, one per session).
- In `pollAccount`, ONLY on the `observationOnly` branch AND only for a credential that READ but is malformed (`credential-token-shape-invalid` / `credential-missing-oauth-block` — NOT `credential-absent-or-unreadable`, see §1): if ≥2 distinct sessions sighted within 60 min for that slot's config home, mark needs-reauth with new cause `cli-login-expired-observed`, corroboration `exchange-corroborated`. Otherwise behavior is unchanged (observation-absence).
- `QuotaPoller.invalidateIdentityCache(slots)` (called on every credential swap) also clears that slot's sightings, so a dead login's sightings never corroborate against the credential swapped in after it.
- `SessionManager.configHomeForSession(tmux, { defaultWhenUnset: true })`: when tmux reports `CLAUDE_CONFIG_DIR` explicitly UNSET (`-CLAUDE_CONFIG_DIR`), the sink receives the process default home (`$CLAUDE_CONFIG_DIR` or `~/.claude`), because a session on the default login carries no override. An unparseable/failed tmux read still yields nothing (never a guessed slot).
- `SubscriptionLoginLedger.recordObservation`: an open provisional credential-read window that is closed BY a needs-reauth transition is labelled `escalated-to-needs-reauth` (was `resolved-read-window`, which the history route counted as resolved). `/subscription-pool/login-history` summary gains `credentialReadObservationWindows.escalated`.
- `SUBSCRIPTION_LOGIN_CAUSE_CLASSES` + relogin `ACTIONABLE_CAUSES` gain `cli-login-expired-observed`.
- `server.ts` wires the sink to the poller.
- CLAUDE.md template bullet + PostUpdateMigrator rewrite of the old "never changes the account's pool status" sentence (idempotent, content-sniffed).

## Decision-point inventory

- `QuotaPoller.pollAccount` observationOnly branch — modify — can now transition to needs-reauth when corroborated by CLI sightings.
- `SubscriptionReloginPolicy` ACTIONABLE_CAUSES — modify — new cause is actionable (mirrors `cli-signed-out-auth-refused`, the Codex precedent where the CLI's own verdict corroborates).
- `SessionManager.endIfLoginExpired` — pass-through — unchanged kill decision; adds a signal emit.

---

## 1. Over-block

No block/allow surface on messages. The "over-act" analogue: a false needs-reauth would start a sign-in repair on a working login. That needs BOTH an unreadable stored credential AND Claude Code itself rendering its auth-failure frame (glyph-led, tail-gated, line-start; held for the 60s dwell) in two different sessions under that exact home within an hour. A transiently unreadable keychain (securityd contention) with a working CLI cannot produce the frame. Second-pass finding (fixed): a LOCKED keychain (post-reboot, launchd context) makes the stored read fail with `credential-absent-or-unreadable` AND makes the CLI itself show "Login expired" — on a login that is fine — and the repair would then write into the same locked keychain and fail. That reason is therefore EXCLUDED from corroboration; only a credential that read but is malformed counts (test: "an ABSENT/unreadable credential (locked keychain) never corroborates"). The remaining false-positive path is a CLI bug rendering "Login expired" while signed in with a malformed-but-working credential file, which is contradictory on its face. Even then the repair re-verifies identity and an authenticated call before closing, and a later clean authenticated read restores `active` (existing `restores` path).

## 2. Under-block

- Only rerouted job sessions are classified (existing scope of `endIfLoginExpired`). An agent with no rerouted jobs on the dead login gets no sightings, so behavior is as before. Interactive sessions stuck at the frame are not classified. Out of scope: this fixes the corroboration gap, and the incident machine produced 40+ sightings.
- Second-pass finding (fixed): a session on the DEFAULT login carries no `CLAUDE_CONFIG_DIR`, so the sink used to never fire for it. Now an explicitly-unset var resolves to the default home; a failed tmux read still reports nothing.
- Symlinked config homes are compared by `path.resolve(expandHome())`, not realpath: a mismatch can only MISS a repair, never cause one.
- A dead login whose stored token still reads as `sk-ant-oat…` is already handled by the usage-read 401 → refresh → exchange-corroborated path.
- Sightings are in-memory: a server restart clears them. They re-accumulate within ~10 min on a machine running jobs.

## 3. Level-of-abstraction fit

Right layer. SessionManager stays a detector (pane classifier). QuotaPoller stays the sole authority over pool status (as LoginExpiredSignature's header requires). Repair admission stays in SubscriptionReloginPolicy. The new signal feeds the existing authority rather than running parallel to it.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

The pane sighting carries no authority. The poller decides, and only in combination with its own unreadable-credential observation. The downstream repair keeps every existing floor (profile, identity hash, mode, breaker, slow-retry caps).

## 4b. Judgment-point check

A static threshold (2 sessions / 60 min) at a corroboration point. It is a floor, not a competing-signals judgment: both inputs are deterministic, enumerable facts (credential unreadable; CLI's own auth-failure frame). The irreversible-ish action (repair) keeps its own admission floor and verification. It mirrors the existing Codex rule (2 consecutive CLI-signed-out polls).

## 5. Interactions

- **Shadowing:** none. The new branch runs only where the poller previously returned observation-absence.
- **Double-fire:** if the credential read window and a later real exchange failure both fire, `markNeedsReauth` is idempotent and the episode ledger's unique open-episode index keeps one episode per cell. The code also skips the transition when status is already needs-reauth.
- **Races:** sightings map is touched by the tick (sync) and the poll (async) in one event loop. No shared-write race.
- **Credential swaps (second-pass finding, fixed):** sightings are keyed by config home, not account. A swap re-points the slot; `invalidateIdentityCache` (already called on every slot change) now also clears that slot's sightings.
- **Feedback loops:** needs-reauth removes the account from placement, so fewer sessions land on it and fewer sightings arrive. That is self-damping. Sightings are cleared on transition. After a successful repair, a clean authenticated read restores `active`.
- **Missing-login / identity-drift guards:** independent and unaffected.

## 6. External surfaces

- Pool status visible on dashboard Subscriptions tab: an account with a dead login now shows "needs sign-in" instead of a stale "active". This is the intended user-visible change.
- Assisted relogin may start (unattended identities) or offer the one-tap approval, through the existing phone-complete dashboard surface. No new operator action.
- Login ledger gets a new causeClass string and a new read-window outcome string (`escalated-to-needs-reauth`). No schema change (TEXT columns; validation list extended). `/subscription-pool/login-history` summary gains an `escalated` count; `resolved` no longer counts an escalation.
- CLAUDE.md wording for existing agents is updated via migration.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: a Claude login lives in one machine's keychain/config home, and both the sighting (that machine's tmux pane) and the needs-reauth status are per (account × machine) cell, exactly like the existing poller and relogin episodes. The pool-scope read (`/subscription-pool?scope=pool`) already shows each machine's cell. No notices, no durable state beyond the existing ledger, no URLs.

## 8. Rollback cost

Pure code revert, shipped as a patch. Persisted episodes with cause `cli-login-expired-observed` and read windows with outcome `escalated-to-needs-reauth` would remain in the ledger; after a revert they are read as plain text (the old code would count an escalated window as neither resolved nor open — a cosmetic count only). Recommendation if reverting: keep the enum entry. No agent state repair.

## Conclusion

Narrow, signal-fed change that closes the gap where a dead Claude login with an unreadable stored credential stayed `active` indefinitely. Clear to ship.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only, 2026-10-22 12:40 PDT)
**Independent read of the artifact: concern → resolved**

Concerns raised, each fixed in this change before commit:
- Locked-keychain false positive via `credential-absent-or-unreadable` → that reason excluded from corroboration; test added.
- Default-home sessions never produced sightings → `defaultWhenUnset` resolution; test added (unset → default home; unparseable → nothing).
- Open read window closed as "resolved" by an escalation → labelled `escalated-to-needs-reauth`; ledger test + history-route count added.
- Artifact omissions (swap not clearing sightings, symlinks) → sightings cleared on slot change; both recorded above.
Confirmed correct by the reviewer: ledger transition opens an `observed` + `exchange-corroborated` episode that admission accepts; restores and identity reconciliation unaffected; signal-vs-authority compliant.

## Evidence pointers

- `tests/unit/quota-poller-cli-login-expired.test.ts` (7): both sides of the boundary (2 sessions vs 1 session; window; other home; readable credential never flipped; absent-or-unreadable never corroborates; missing-oauth-block does; swap clears sightings), plus admission passes the cause gate.
- `tests/unit/headless-spawn-reroute.test.ts` (+4): sink receives the live config home; unset var → default home / unparseable → nothing; throwing sink never stops the kill; data flow from two real SessionManager kills into a real QuotaPoller flips needs-reauth.
- `tests/unit/subscription-login-ledger.test.ts` (+1): an open read window closed by a needs-reauth transition is `escalated-to-needs-reauth`, and the episode it opens is `observed` + `exchange-corroborated`.
- `tests/unit/rerouted-login-expired-awareness.test.ts` (+1): migration rewrites the legacy sentence once, idempotent.
- Incident evidence: Studio `logs/server.log` 2026-10-22 14:16Z–19:06Z `reroutedLoginExpired` lines; `/subscription-pool/login-history` credentialReadObservationWindows id 8 (credential-token-shape-invalid, opened 11:10:32Z, never actionable).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The doc sentence changed in the CLAUDE.md template described the old behavior accurately; it is updated because behavior changed. The trigger edge added feeds an existing bounded controller, the relogin service, whose breaker / maxAttempts / slow-retry caps bound it.)
