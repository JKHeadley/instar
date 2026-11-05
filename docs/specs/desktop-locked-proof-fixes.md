---
title: "Locked-Mac proof fixes: helper store root, named password readiness, a PIN without Telegram"
slug: "desktop-locked-proof-fixes"
author: "echo"
created: "2026-11-04"
eli16-overview: "docs/specs/desktop-locked-proof-fixes.eli16.md"
parent-spec: "docs/specs/desktop-locked-screen.md"
parent-principle: "No Silent Degradation"
parent-principle-fit: "Each defect made a working-looking surface hide why it could not work: an exit code with no reason, a status that said ready while the box was impossible, and a PIN route that answered 503 forever on an agent without Telegram."
review-convergence: "2026-11-04T20:30:56.492Z"
review-iterations: 2
review-completed-at: "2026-11-04T20:30:56.492Z"
review-report: "docs/specs/reports/desktop-locked-proof-fixes-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo, under the operator's standing rule that only constitution changes need him (2026-10-22, topic 134088 context); this change touches no constitution file (docs/STANDARDS-REGISTRY.md, .github/CODEOWNERS)"
---

# Locked-Mac proof fixes

## Problem statement

The locked-Mac Remote Desktop proof on the Mac Mini (2026-11-04, topic 134088) measured three runtime defects in the shipped, still-dark locked-screen feature. Each was found live; the evidence files are on the Mini.

1. **The helper's state verb fails when `~/.instar/desktop-helper` does not exist.** `LockedStore.withLock` in `src/native/remote-desktop/macos/InstarDesktopHost.swift` makes its store root with one non-recursive `mkdir(root, 0o700)`. On a non-release (thin) build, helper retention is skipped, so nothing ever creates the parent folder. The helper exits 69 with an empty stderr. `MacDesktopHost.run` (`src/core/MacDesktopHost.ts`) discards stderr and rejects every non-zero exit as `mac-desktop-host-unavailable`, so `POST /desktop/locked/settings` answers a bare `409 mac-desktop-host-unavailable`. Feedback fb-68cfe5e2-52e.
2. **`GET /desktop/locked/status` reads healthy while the viewer's password box is impossible.** Status showed enabled, active, refusal null, locked-in-session. The box could not work for two separate reasons: (a) `browserBoxShown()` requires the Cloudflare tunnel's first tier to be active, and the quick tunnel was rate-limited (429); (b) `passwordRefusal` returns `retained-helper-required` when the probe's `helperSource` is not `retained`. The parent spec (`desktop-locked-screen.md`, Audit and status) promises that status says "whether the password path is ready with its named reason". It does not. The viewer only hides the box. Separately, the `state` control record is re-sent only on a lock-state change or at stream attach, so an open viewer never learns that the tunnel came up.
3. **An agent without Telegram can be left without a dashboard PIN.** `src/commands/server.ts` generates `dashboardPin` only inside `if (telegram)` after the dashboard topic exists. Two other paths exist: `PostUpdateMigrator` makes one on update when `authToken` is set, and the install wizard's `ensureViewingPin` makes one for a messaging-free install. An agent made by `instar init` that has not yet run an update (the proof agents) has none, so `/dashboard/unlock` answers 503 and every PIN-gated route (locked settings included) is unreachable. Instar must work without Telegram (operator rule, 2026-10-31).

## Proposed design

### 1. Helper store root, and a named state-op failure

- Swift: `LockedStore.ensureDirectory(root)` walks the absolute root path and makes each missing component with `mkdir(_, 0o700)`. A component that exists is never touched or re-moded (`stat` follows symlinks in parents, as `mkdir` already did; all of it is under the user's own home). Only the root itself is checked to be a real directory (`lstat`). Relative roots are refused. Thin builds lacking the retained helper are already named by `retained-helper-required` in status (below), so the missing folder was the only silent part.
- Swift: every nil return in `withLock` and the `read` op records one fixed word in `LockedStore.lastFailure` (`store-root-uncreatable`, `store-lock-unopenable`, `store-lock-unavailable`, `store-unreadable`, `store-unencodable`, `store-unwritable`). The `state-op` verb writes `state-op: <word>` to stderr before `exit(69)`; malformed input is `request-invalid`, an unknown op `op-invalid`, an unencodable reply `reply-unencodable`. No path, value or request content is ever written.
- TypeScript: for the `state-op` command only, `MacDesktopHost.run` reads the first 256 bytes of stderr. On a non-zero exit it rejects with `stateOpRefusal(code, stderr)`: `mac-desktop-host-state-op-failed-exit-<code>[-<word>]`, where `<word>` is kept only when a line matches `^state-op: [a-z][a-z0-9-]{0,47}$` AND the word is in an explicit allowlist of the nine words above. Everything else on stderr is dropped. Every other command keeps discarding stderr unchanged, because capture and input helpers can carry frame bytes or typed text.
- The status route's error-code pattern widens from `[a-z-]+` to `[a-z0-9-]+` so the new code (which carries the exit number) is reported instead of falling back to `locked-state-unreadable`. The settings and disable routes already return the error message in their 409.

### 2. Named password readiness, in status and in the viewer

- `DesktopLockedController.browserBoxRefusal()` returns `browser-box-off`, `tunnel-not-active` (no tunnel up at all), `tunnel-not-first-tier` (a backup tunnel is up), or null. A new optional dep `tunnelActive()` tells the last two apart; production wires it to the tunnel lifecycle being `active` or `relay-active`. Without the dep, a non-first-tier tunnel reads `tunnel-not-active`. `browserBoxShown()` is `browserBoxRefusal() === null` (unchanged meaning).
- `passwordRefusal` is unchanged except that its browser branch uses `browserBoxRefusal()`, so its tunnel word is now the more precise one.
- `passwordReadiness(probe)` returns `{ app, browser }`: each is `passwordRefusal(probe, client, 'locked-in-session')`, meaning "could a password be typed once this Mac is locked". With no probe, both read `helper-unprobed` (browser: the box refusal first), never ready.
- `status(osMajor, probe)` adds `passwordReadiness`, `browserBoxShown` and `browserBoxRefusal`. The status lever in `AgentServer` reads `DirectDesktopAccess.readinessProbe()`: the newest host probe when under 30 s old, else one fresh `host.probe()` shared by concurrent callers. It calls the host's own probe, never `DirectDesktopAccess.probe()`, so a status read applies no mode and ends no grant. A failed probe passes null, which reads `helper-unprobed`. `?scope=pool` carries the new fields through the existing mesh read unchanged; an older peer's answer simply lacks them, which a reader treats as unknown, never ready.
- `DirectDesktopAccess` keeps its newest host probe and builds every `state` control record in one place: `{ type: 'state', state, box, boxRefusal }`. `box` keeps its meaning; `boxRefusal` is the readiness word for this row's client (null when ready). After every grant probe the record is recomputed and sent when it differs from the last one sent to that viewer (so a helper grant that changes readiness under an unchanged lock state reaches the viewer), and always at stream attach.
- `DirectDesktopAccess.refreshLockedState()` recomputes the `state` record for every open viewer row that has a lock state and sends it where it changed. `TunnelManager` re-emits each lifecycle transition as a `lifecycle` event, and `AgentServer` calls `refreshLockedState()` on it (the listener is removed in `stop()`), so an open viewer gets the box once the tunnel comes up, without reconnecting. Unchanged records are not re-sent; a real readiness change (the tunnel going down or up) is still sent, which is the point.
- Viewer (`dashboard/desktop.js`, `desktop.html`, `desktop.css`): a state record with `boxRefusal` hides the box and shows a plain sentence for that reason in a `#lockedPasswordReason` note while the Mac is locked (clicks pass through the note). A server that sends no `boxRefusal` behaves exactly as before. New sentences: `tunnel-not-active`, `retained-helper-required`, `own-input-grant-required`, `unsupported-macos`, `helper-unprobed`.

### 3. A dashboard PIN whatever the messaging

- New `ensureDashboardPin(config, persist)` in `src/core/dashboardPin.ts`: when `config.dashboardPin` is unset or empty, it draws a 6-digit PIN with `crypto.randomInt`, sets it, and persists it. Any set value is kept, including an unresolved `{secret:true}` vault reference, so a transient vault read failure can never replace the operator's PIN. (The broadcast placeholder `(check your config)` is never written to config, so it needs no rule.)
- New `persistDashboardPin(stateDir, pin, setConfig)`: when the agent has an encrypted vault (`secrets/config.secrets.enc`), the PIN goes into the vault and config gets the `{secret:true}` reference; otherwise config.json, as before. A failed vault write (the store read throws rather than returning empty, so nothing else in the vault can be lost) falls back to config.json with a warning.
- Where the PIN is read: the running server keeps the plaintext PIN in its in-memory `config.dashboardPin` (what `/dashboard/unlock` and the Telegram broadcast read); `liveConfig.set` writes only the file. After a restart, `loadConfig` resolves the `{secret:true}` reference from the vault as it does for every vault-backed secret. The two readers that read the file through `liveConfig.get` (the tunnel notifier's credential provider and the `fix dashboard` command) resolve it with the existing `pickDashboardPin`, so neither prints `[object Object]`.
- `PostUpdateMigrator`'s generator uses the same two helpers and no longer writes the PIN value into its result log. The install wizard's `ensureViewingPin` is left as is (it runs on a fresh install, before any vault exists).
- `server.ts` calls it once at boot, before and outside the `if (telegram)` dashboard-topic branch; the old in-branch generator is removed. The boot log says a PIN was generated and where it is kept, without the value (the old line printed it).
- An agent that already has a PIN is unchanged. A Telegram agent still gets its PIN in the dashboard broadcast, which reads `config.dashboardPin` after this runs.
- Mobile-Complete: the owner of an agent without Telegram gets the PIN from the agent itself, in whatever conversation it has (the Instar app, Slack, iMessage): the CLAUDE.md template already tells every agent to read the PIN from its config and give it when the owner wants the dashboard. Before this change such an agent had no PIN at all, so no phone path could exist; this adds the credential the existing phone paths hand over. No new notice is added.

### 4. The secure-input owner read (added after convergence, found live on the Mini 13:33-13:41)

`secureInputOwner()` opened `IOService:/IOResources/IOConsoleUsers`, but `IOConsoleUsers` is a property of the `IOResources` entry, not an entry. `IORegistryEntryFromPath` returned 0, so the owner always read `unreadable`, `secureTargetHolds()` was always false, and `secretType` refused every password with `shield-not-confirmed` before reserving an attempt (path from #2564). The helper now opens `IOService:/IOResources` (a named constant) and keeps the `IOConsoleUsers` property read. The viewer gains a plain sentence for every refusal word the helper and the target can send (it showed only the fallback for `shield-not-confirmed`), and the target records each password refusal word server-side: a `[desktop] password refused on <machine>: <word>` warning and a `secret-refused` row in the screen-free desktop access audit (the word only; anything not matching a word is recorded as `other`).

### Agent awareness

The `remoteDesktopBullet` in `generateClaudeMd` (rewritten by `PostUpdateMigrator` whenever it differs) and the CapabilityIndex desktop entry name `passwordReadiness`.

## Decision points touched

| Decision point | Classification | Floor or justification |
|---|---|---|
| Which words a state-op failure may carry to Node | `invariant` | An explicit allowlist of nine words, read from the first 256 bytes; anything else is dropped. Deterministic by design: it is a privacy boundary on a helper that elsewhere handles typed text. |
| Whether the helper may create missing store parents | `invariant` | Only missing components, each 0700, absolute root only; existing directories untouched. |
| Which reason the browser box reports (`browser-box-off` / `tunnel-not-active` / `tunnel-not-first-tier`) | `invariant` | Enumerable from two booleans and a setting. It gates nothing new: the target already refused on the first-tier check; this only names it. |
| Password readiness in status and in the viewer | `invariant` | Derived from the existing `passwordRefusal`; no new authority. The target's refusal at `secretType` is unchanged and remains the authority. |
| Generate a dashboard PIN when none is set | `invariant` | Unset or empty only; any present value (including an unresolved vault ref) is kept. A policy change for agents that had none: named in the release note's What to Tell Your User. |
| Which registry entry holds the secure-input owner | `invariant` | A fixed IOKit path; a read failure still reads `unreadable` and refuses, as before. |
| Where a new PIN is stored | `invariant` | The vault when the agent has one, else config.json; a failed vault write falls back to config.json. |

## Verify the State, Not Its Symbol

- **State-op refusal word.** Symbol: the helper's stderr word. Claimed state: why the store operation failed. Corroboration: the exit code is kept beside it, and the live store is re-read by the next op. Unmeasurable (no word, or stderr past 256 bytes): the code carries only the exit number, never a guessed reason.
- **`passwordReadiness`.** Symbol: the probe's `helperSource` and `inputGrant`, the setting, and the tunnel lifecycle. Claimed state: a password could be typed once locked. Corroboration: the same `passwordRefusal` runs again at the moment of `secretType` and refuses then if anything changed. Unmeasurable (no probe): `helper-unprobed`, never null.
- **`boxRefusal` in the viewer.** Symbol: the newest probe and the tunnel lifecycle. It is a hint for an honest page; the target still refuses, as the parent spec states.

## Multi-machine posture

- **Helper store and its refusal:** machine-local. `machine-local-justification: hardware-bound-resource` — the store is the per-Mac relock record shared by every agent on that Mac under one kernel lock (parent spec), and the failure is about that Mac's disk.
- **`passwordReadiness`:** proxied-on-read through the existing `GET /desktop/locked/status?scope=pool` mesh read, which already merges each machine's own status; the new fields ride it unchanged.
- **Viewer refresh on tunnel change:** machine-local. `machine-local-justification: physical-credential-locality` — what changes is this machine's own Cloudflare connector, whose credential lives only on this disk, and the refresh only reaches viewers whose stream this machine serves.
- **Dashboard PIN:** unchanged posture. The PIN is per agent install, stored in config/vault and moved by the existing cross-machine secret sync; this change only mints one where none existed. No notices, no URLs.

## Frontloaded Decisions

1. Fix the store root in the Swift helper (recursive, 0700) rather than having Node pre-create it: the helper owns the store and its lock, and Node must not depend on running first.
2. Keep stderr only for `state-op`, and only one fixed word from it. Capture and input helpers keep discarding stderr.
3. The refusal is an error code string (`mac-desktop-host-state-op-failed-exit-69-store-root-uncreatable`), not a structured object, so the existing 409/503 bodies and the mesh broker carry it without new fields.
4. Readiness is reported "as if locked" (`locked-in-session`), because status is asked before the Mac is locked; `lockState` is already a separate field.
5. A missing probe reads `helper-unprobed`, never ready.
6. `tunnel-not-active` is a new word, distinct from the existing `tunnel-not-first-tier`; the existing word keeps its meaning (a backup tunnel is up).
7. Recompute `state` after every grant probe and on every tunnel lifecycle transition, rather than polling; send only when the record changed (repeats are harmless but suppressed).
10. Status reads a cached host probe (30 s) or one shared fresh host probe, never the grant probe with its side effects.
11. A new PIN goes into the vault when the agent has one.
8. The viewer shows the reason in a note that does not take clicks, and only while the Mac is locked.
9. Generate the PIN whenever none is set, regardless of Telegram or the dashboard topic; never print the value.

## Open questions

*(none)*

## Maturation plan

The locked-screen feature stays dark (absent is off, and the enable route refuses every macOS version until P12 and P15 are recorded). This change rides the parent feature's ladder and adds no flag.

- **test-agent-live:** two separate checks on the Mac Mini's throwaway user. (a) Thin build: the settings route succeeds with no `~/.instar/desktop-helper`, and status names `retained-helper-required`. (b) The `-lockedproof` build with a retained, granted helper, the browser box on and the test proven-versions table: status names `tunnel-not-active` while the quick tunnel is down, and an open viewer shows the box once it comes up.
- **dev-agent-live:** unchanged from the parent spec.
- **fleet:** the PIN change is live on release for agents without a PIN; the helper and status changes ship with the dark feature.
- **graduation criterion:** the parent spec's (P12 and P15 pass on real hardware).
- **dark-window:** the parent spec's.
- **ladder:** remoteDesktop

## Rollback

A revert restores today's behaviour. The helper may have created `~/.instar/desktop-helper` (0700, empty but for the store files); it is inert. A generated PIN stays in config and keeps working; reverting does not remove it.

## Left behind

- `readinessProbe` serves a probe up to 30 s old; a helper grant changed in that window shows in status at the next read after it expires (the grant path re-checks at `secretType`).
- The migrator writes the vault before saving config.json; if that save fails, the next run mints another PIN over the first, which nobody has been told. Harmless.
- The install wizard's `ensureViewingPin` keeps its own string-only rule (fresh installs have no vault yet).
- The `fix dashboard` command still writes a newly generated PIN to config.json in plain text (pre-existing; vault agents reach it only when they have no PIN at all).
