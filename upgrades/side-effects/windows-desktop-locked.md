# Side-Effects Review — Windows Remote Desktop reads a locked PC as locked

**Version / slug:** `windows-desktop-locked`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 12 files, about 225 added lines (most of it tests). Justin tried Windows Remote Desktop on Mama PC (13:10 PST 11-15): clicks blanked the screen and the session then closed. Reproduced on Mama at 16:35 through the real companion: on a locked PC the lock picture sits on the "Default" input desktop, so the companion reported ready and a session started; the first click lifted the picture, Windows moved to the secure sign-in desktop, frames went empty (6.1 s), and the companion watchdog ended the lease (7.4 s). Fix: the companion (`InstarDesktopCompanion.cs`) reads the lock with `ScreenLocked()` = Windows' WTS session flag says locked AND a LogonUI process runs in its session, cached 500 ms; `InteractiveDesktop()` also requires not locked; the probe reply adds `screenLocked`. `WindowsDesktopHost.probe` carries it as `windows: { locked }`. `desktopProbeUnavailableReason` gains a Windows branch with plain wording (it used the Mac text for Windows before). `AgentServer` local diagnostics pass `screenLocked: true` to the setup guide, which gets Windows lock wording. `dashboard/desktop.js`: after a session ends and cannot resume, it reloads the machine list and shows that machine's own reason. Effort: one build, one review round, first commit attempt.

## Decision-point inventory

- Companion `InteractiveDesktop()` (gates probe readiness, start, capture, input, and the 1 s watchdog stop) — modify — also false while the PC is locked.
- `desktopProbeUnavailableReason` — modify — Windows branch (wording only, no decision).
- `desktopSetupStep` — modify — Windows lock wording (wording only).

---

## 1. Over-block

The only new refusal is "PC locked". Locked requires two independent readings to agree, so a misread session flag alone cannot refuse an unlocked PC. If LogonUI lingered after unlock while the flag still said locked, the PC would read locked until either cleared; the flag is set by Windows on unlock, so both would need to be wrong. A PC at the Ctrl+Alt+Del or sign-in screen is refused; that is correct, since the companion cannot see or type there.

## 2. Under-block

A PC locked while LogonUI is not running (not observed) reads unlocked and behaves as before this change (session ends at the first secure-desktop switch). UAC prompts mid-session still end the session (secure desktop), with the generic reason; unchanged.

## 3. Level-of-abstraction fit

The reading belongs in the companion: only a process in the Windows session can read its own session flag and desktop. The server keeps its existing readiness path (`probe.ready`) and reason function; this feeds them, it adds no parallel gate.

## 4. Signal vs authority compliance

The companion's existing authority (no interactive desktop → not ready / stop) is unchanged in kind; the lock reading is an input to it. The design already treats a locked machine as unavailable (docs/specs/native-remote-desktop-echo-mesh.md: locked machines remain unavailable; the PIN does not unlock). No new brittle authority over messages or sessions.

## 4b. Judgment-point check

No competing-signals decision point added; a factual OS reading (two corroborating inputs) feeds an existing floor.

## 5. Interactions

`ScreenLocked` takes its own `LockGate` and is called while `Gate` is held; it never takes `Gate`, so no lock-order inversion. The process scan runs at most twice a second. The watchdog now ends a session within about 1 s of Win+L, before any frame of the lock screen is sent, instead of after the first click. The viewer's resume path is unchanged; `leaveExplained` only reads `/desktop/targets` after `leave()` and skips if a new socket opened meanwhile.

## 6. External surfaces

Probe reply gains `screenLocked`; an older server ignores it, and a newer server reads a missing field as not locked (older companion behaves as before). The reason text for Windows machines changes for every Windows host (it previously showed Mac wording). The companion is reinstalled from the package source on update, as today.

## 6b. Operator-surface quality

1. Leads with the primary action? Yes: the machine picker and its note say "This Windows PC is locked … sign in at the PC, then tap Retry", the one action.
2. Zero raw internals? Yes: plain sentences only.
3. Destructive actions de-emphasized? Unchanged; no new buttons.
4. Plain language + phone width? Checked on the real page at 1280x728 and 390x844 (headless, real PIN, Mama locked): the reason reads in full in the picker list and the Machines section.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine reads its own lock and reports it through the existing peer desktop-availability and setup-status calls to the front. No new state.

**Status surfaces:** `/desktop/targets` (existing) carries the new reason text; setup status carries `screenLocked` (existing field).

## 8. Rollback cost

Revert the commit; the next release reinstalls the previous companion. No state or config.

## Conclusion

Narrow, revertable fix for the reproduced cause. Unlocked-PC behaviour is unchanged by construction (both readings required). Unlocking Windows from Remote Desktop is not part of this change; its scope goes to the chief of staff separately.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, read the staged diff and surrounding code)
**Independent read of the artifact: concur**

Concur. Offsets of WTSINFOEXW level 1 are right on x64 and x86 (union at 8; SessionFlags at 16; 0 locked on Windows 10/11). Windows 7 / 2008 R2 invert the flag, and the AND with LogonUI covers that, since LogonUI is not running in an unlocked session; every failure reads not locked, and the change only makes `InteractiveDesktop()` stricter. Lock order is always Gate then LockGate; ScreenLocked never takes Gate. C# 5 clean. No new authority: the spec already treats a locked machine as unavailable. Compatible both ways (old server ignores `screenLocked`; new server with old companion reads not locked and gets the Windows wording, dropping Mac permission text Windows was wrongly given). Minor notes, all addressed in this change: (1) `Process.GetCurrentProcess()` per read and never disposed: now the session id is read once and the Process disposed; (2) `leaveExplained` could overwrite the status of a request started while its fetch ran: it now also stops when the request changed, with a test; (3) AgentServer sets `screenLocked: true` before the boolean copy, which is safe because Windows probes carry no `screenLocked` boolean (left as is).

## Evidence pointers

- Repro on Mama 16:35 PST: probe ready while locked; click 5.26 s; empty frames 6.09 s; lease lost 7.43 s; probe not ready after.
- Fixed build on Mama 16:44: probe `{"sessionActive":false,"windows":{"locked":true}}`, start refused, reason "This Windows PC is locked…". Real Studio page lists Mama with that reason.
- Revised companion recompiled on Mama 16:54 (exe 4:54:49 PM, running 4:54:56 PM), probe still reports locked, start refused.
- Unit: windows-desktop-companion-lock, windows-desktop-host, desktop-probe-readiness, desktop-setup-guide, desktop-ended-reason, desktop-video-viewer.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
