# Side-Effects Review — locked-Mac proof fixes: helper store root, named password readiness, a PIN without Telegram

**Version / slug:** `desktop-locked-proof-fixes`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 2 (security-sensitive surroundings: the helper that types a Mac password, and the dashboard PIN). Spec `docs/specs/desktop-locked-proof-fixes.md`, converged in 2 rounds (cap 6), cross-model codex-cli:gpt-6-astra. Three defects the 2026-11-04 Mac Mini proof measured:

1. `InstarDesktopHost.swift`: the store root is created recursively (missing components only, 0700; root must be a real directory), and every `state-op` failure writes one fixed word to stderr. `MacDesktopHost.ts`: for `state-op` only, the first 256 bytes of stderr are read and an allowlisted word plus the exit code become the error (`mac-desktop-host-state-op-failed-exit-69-store-root-uncreatable`). Other helper commands still discard stderr. `routes.ts`: the status error-code pattern admits digits.
2. `DesktopLockedController.ts`: `browserBoxRefusal()` (`browser-box-off` / `tunnel-not-active` / `tunnel-not-first-tier`), `passwordReadiness(probe)`, and `status()` gains `passwordReadiness`, `browserBoxShown`, `browserBoxRefusal`. `DirectDesktopAccess.ts`: state records carry `boxRefusal`, are recomputed after each grant probe and on tunnel transitions and sent when changed; `readinessProbe()` serves status from a 30 s cached host probe or one shared fresh `host.probe()`. `TunnelManager.ts` emits `lifecycle`; `AgentServer.ts` wires the status lever, the `tunnelActive` dep, and the listener (removed in `stop()`). Viewer (`dashboard/desktop.{js,html,css}`) shows the reason instead of a hidden box.
3. `dashboardPin.ts`: `ensureDashboardPin` and `persistDashboardPin` (vault when present). `server.ts` calls them at boot outside the Telegram branch and no longer logs the PIN; the two file readers resolve a vault reference via `pickDashboardPin`. `PostUpdateMigrator.ts` uses the same helpers and stops logging the PIN.

4. (Added after convergence, found live on the Mini.) `InstarDesktopHost.swift` `secureInputOwner()` opened `IOService:/IOResources/IOConsoleUsers`, which is a property, not a registry entry, so it always read `unreadable` and `secretType` refused every password with `shield-not-confirmed`. It now opens `IOService:/IOResources` and reads the `IOConsoleUsers` property. `dashboard/desktop.js` has a sentence for every refusal word; `DirectDesktopAccess` logs each refusal word and writes a `secret-refused` row to `DesktopAccessAudit` (word only, sanitized).

Also: agent-awareness text (`templates.ts` remote desktop bullet, `CapabilityIndex.ts`), and `tests/vitest-setup.ts` allowlists three stripped test opt-in variables. About 20 files, ~600 lines; 2 review rounds; first commit attempt pending.

## Decision-point inventory

- State-op failure word to Node — add — fixed allowlist, privacy boundary.
- Helper store parent creation — modify — recursive, missing components only.
- Browser box refusal word — modify — names `tunnel-not-active` apart from `tunnel-not-first-tier`; same refuse/allow outcome as before.
- Password readiness in status/viewer — add — derived signal; the `secretType` refusal is unchanged and remains the authority.
- Dashboard PIN minting — modify — now independent of Telegram; existing values kept.

---

## 1. Over-block

The secure-input fix removes an over-block: every password was refused at `shield-not-confirmed`. After it, `secureTargetHolds()` is true only when loginwindow really holds secure input, as designed; a non-loginwindow owner still refuses.

The browser-box allow/refuse outcome is unchanged (`browserBoxShown` is the same predicate). The viewer now hides the box when `boxRefusal` is set; every such case was already refused at `secretType`, so no working path is hidden. A probe up to 30 s stale could show a refusal for a helper grant granted in the last 30 s in status only; the viewer path recomputes after each grant probe (500 ms).

## 2. Under-block

The viewer's `boxRefusal` is a hint for an honest page, as the parent spec states; a hostile front can still draw a box, and the target still refuses. An older peer in `?scope=pool` returns no readiness fields; readers must treat absence as unknown.

## 3. Level-of-abstraction fit

The store root belongs to the helper that owns the store and its lock, so the fix is in Swift, not Node pre-creating it. Readiness is derived from the existing `passwordRefusal` rather than a parallel check. PIN minting moves to the one boot point that runs for every agent, and the migrator shares its rule.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing gate (readiness and the refusal word are signals; the existing `passwordRefusal` at `secretType` and the PIN check at `/dashboard/unlock` stay the authorities).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. All classified `invariant` in the spec's table (enumerable inputs; privacy boundary).

## 5. Interactions

- Status no longer calls the grant probe, so it cannot apply modes or end grants (round-1 finding). `readinessProbe` updates `lastHostProbe`, which the viewer's `boxRefusal` also reads; both are signals.
- `emitState` dedupes per viewer; `attachControl` forces a send. A probe before attach stamps the record through the no-op sender and the forced attach send delivers it.
- The PIN generator runs before the Telegram broadcast, which reads the in-memory `config.dashboardPin` (plaintext even for vault agents, since `liveConfig.set` writes only the file).
- `PostUpdateMigrator` and server boot can both mint; whichever runs first wins and the other sees a set value.

## 6. External surfaces

- The desktop access audit gains a `secret-refused` kind with a `reason` word (sanitized to `[a-z0-9-]`, else `other`); still screen-free and keystroke-free.

- `GET /desktop/locked/status` gains three fields (Bearer-only; fixed words). Error codes from state-op change from `mac-desktop-host-unavailable` to the named form; no caller matched the old string for state-op.
- The viewer gets a reason note. Older viewers ignore `boxRefusal`.
- Agents with no PIN get one at next boot, stored in the vault when they have one. The boot log and the migrator result no longer print a PIN value.
- Operator surface: the owner of a no-Telegram agent gets the PIN from the agent's own conversation (template already instructs it); before, no PIN existed.

## 6b. Operator-surface quality

1. Leads with the primary action: the reason note sits where the box would be, only while the Mac is locked and the box cannot work; the remote screen stays usable (the note takes no clicks).
2. Zero raw internals: the note is a plain sentence per reason (for example "Password entry from a browser is off until this Mac's secure tunnel is up. This page updates when it is."); the slug never shows.
3. Destructive actions: none added.
4. Plain language + phone width: same overlay geometry as the existing password form (safe-area insets, full width, 0.85rem text), no horizontal scroll.

## 7. Multi-machine posture

- Helper store: machine-local by design (the per-Mac relock record under one kernel lock).
- Readiness: proxied-on-read through the existing `?scope=pool` status read.
- Viewer refresh: machine-local (this machine's own tunnel connector and the streams it serves).
- PIN: per agent install, moved by the existing secret sync; no notices, no URLs.

## 8. Rollback cost

Revert and ship a patch. Residue: an empty-but-for-store `~/.instar/desktop-helper` (inert), and any PIN minted stays valid in config or the vault (that is the desired state).

## Conclusion

Clear to ship after the second-pass review. Review changed the design twice (side-effect-free cached probe for status; vault-aware PIN storage) and closed a test-harness defect where the real-helper opt-in was always stripped.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context, read the artifact and the diff)
**Independent read of the artifact: concur**

Concur with the review: stderr is read only for state-op, capped at 256 bytes, word allowlisted, exit code clamped; ensureDirectory makes only missing components 0700 and requires the root to be a real directory; a set `boxRefusal` hides the box, clears typed text and shows the plain reason; readinessProbe shares one in-flight probe and returns null on failure; an existing PIN (including a vault reference) is never replaced, a new one goes to the vault when present, and no log prints it. Noted: `lastFailure` is never reset, harmless because the helper exits after every state-op.

**Delta review (item 4, secure-input path + refusal logging):** a second independent subagent read the delta and concurred: the fix only changes which registry entry is opened; `secureInputOwner()` still returns `loginwindow` only for that exact process and `secureTargetHolds()` is still checked before and between keystrokes; only the sanitized refusal word is logged or audited; viewer sentences match their words (a re-sent password gets a new sequence, so "type it again" is accurate for `repeat`).

---

## Evidence pointers

- Secure-input owner, live on this Studio: the old path's probe reported `secureInputOwner: unreadable`; the fixed build reports `none`. On the Mini (coordinator): resolves to loginwindow as the proof user and as root.
- Real helper built with `node scripts/build-native-desktop-host.mjs`; live: a deep missing root is created 0700 at each level; `{bad` → `state-op: request-invalid`; a file in the path → `state-op: store-root-uncreatable`; both exit 69.
- `INSTAR_REAL_DESKTOP_HELPER_TESTS=1 npx vitest run tests/unit/desktop-helper-state-op.test.ts`: 8/8 (previously always skipped).
- `tests/unit/desktop-locked-proof-fixes.test.ts`, `DesktopLockedController.test.ts`, `DirectDesktopAccess.locked.test.ts`, `tunnel-manager-rewrite.test.ts`.

**Trace note (2026-11-04):** one closing trace now lists every file in this PR, so the review above is recorded against the whole change, not spread across earlier traces. No code changed in this step.
