# Side-Effects Review — Windows desktop boot diagnosis

**Version / slug:** `native-remote-desktop-bootstrap-diagnostics`
**Date:** 2026-10-31
**Author:** Echo
**Second-pass reviewer:** Astra, 2026-10-31

## Summary of the change

Tier 1 narrow, reversible repair on the already approved Echo mesh desktop design. The Windows installer now emits a fixed phase marker; WSL boot classifies and stores a bounded, allowlisted failure code when it disables desktop access. `AgentServer` adds that code to the existing authenticated local diagnostic. The Mac readiness explanation names missing permissions alongside a helper-reported locked console. The native grant, PIN, encrypted stream, input path, and Stop authority are unchanged. This touches the installer script, server boot, diagnostic projection, readiness wording, template, tests, and docs. One spec review and one commit attempt so far; the attempt was stopped by the required trace gate, which this artifact completes.

## Decision-point inventory

- Windows installer outcome at `src/commands/server.ts` — pass-through: success keeps desktop opt-in active; failure already disabled desktop and still does. The new classifier only explains failure.
- Fixed error parser in `WindowsDesktopBootstrapStatus.ts` — add signal producer: maps captured process text to fixed phase/code; no authority to allow desktop.
- Diagnostic output in `AgentServer.ts` — modify read-only projection: reports a failure code only on a constructed-off WSL target.
- Mac readiness text in `DesktopProbeReadiness.ts` — modify presentation: lists two observed problems together, with no admission change.

## 1. Over-block

No new block/allow surface. An unknown installer error maps to `installer-process-failed`, and a corrupt state file yields no extra diagnosis. Neither case blocks the Instar agent or changes the existing desktop fail-closed decision. A Mac with real permission and an unlocked console still passes the same probe.

## 2. Under-block

The fixed vocabulary can miss a new PowerShell error and report only the phase plus generic code. It cannot fix a Windows task or grant macOS permission. The existing target probe and signed grant still refuse screen and input when the companion is absent. The new local file is only a diagnostic; it is not trusted as readiness evidence.

## 3. Level-of-abstraction fit

Installer phase and error matching are low-level signals. The existing desktop target remains the authority for admission. The authenticated endpoint is maintenance observability; the browser picker consumes signed probe state, never this local file. No second controller path is created.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] No — this change produces a signal consumed by the existing desktop authority.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate.
- [ ] Yes, with brittle blocking logic.

The regex classifier cannot grant or block control. Its output explains an already failed installer. The target's separate live probe, operator grant, and Stop remain authoritative.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Fixed vocabulary here validates a local process outcome, and unknown text maps to a generic code. It does not decide whether a machine is reachable or ready.

## 5. Interactions

- **Shadowing:** WSL boot runs the existing installer before `AgentServer` construction; the status write follows its result and does not replace the existing warning or probe. A failed write leaves the server booting. A per-process nonce makes a prior boot's file invisible, so the diagnostic is absent if this boot cannot write its result.
- **Double-fire:** one WSL boot writes one status. `flock` still owns companion installation; the new code starts no extra installer.
- **Races:** an authenticated read can see a partially written file, which fails JSON parsing and returns no detail. The next read sees the complete status. The file is capped at 1 KiB on read.
- **Feedback loops:** none. The diagnostic is read-only and never triggers an update, restart, or installer retry.

## 6. External surfaces

The WSL host adds one local state file under `.instar/state`; it stores only `off`, `ready`, or a fixed phase/code. The Bearer-only diagnostic adds a `bootstrapFailure` object when installation failed. It exposes no raw stderr, path, IP, token, key, frame, or input. The Mac picker shows both observed conditions when both occur. No new port, external service, notice, scheduled job, or user action is added. The phone PIN viewer and Stop remain the only user actions.

## 6b. Operator-surface quality

The existing machine card is the operator surface. Its unavailable reason now includes the missing Mac permission names in ordinary language while retaining the agent-online statement. There is no new button, form, or desktop admission. The long reason must wrap in the existing responsive card; the browser's ready/open decision stays unchanged. The maintenance failure code is for Echo to diagnose and explain conversationally, not for the operator to decode.

## 7. Multi-machine posture

**Machine-local by design:** the status describes the Windows companion on one physical host, and Mac probe wording describes that host's helper. The Studio front queries signed target availability for the pool. The file does not replicate because copying one host's installer result to another would be false. It sends no user-facing notice, does not bind to a topic, and generates no URL. A topic transfer cannot strand it.

## 8. Rollback cost

Revert this patch and publish the next package. The small local status file can remain inert; old code ignores it. No data migration, user reset, or credential rotation is needed. During rollback, the prior generic Windows failure and single Mac reason would return, while all native desktop safety checks remain.

## Conclusion

The review found no new authority or irreversible side effect. The main risk is an unclassified Windows error, which has a fixed generic fallback and never widens access. Live Windows screen/input/Stop proof remains a separate release acceptance condition.

## Second-pass review (if required)

**Reviewer:** Astra
**Independent read of the artifact:** Concurred with no blocking UX, constitutional, or security finding. Verified that phase/code output is fixed, admission and Stop remain authoritative, and the Mac wording does not add an operator step. Astra noted that the HTTP test mocks the diagnostic provider and that a failed write could leave an old result visible. The per-process nonce now rejects prior-boot data and has a unit test. The existing production-boot E2E covers diagnostic construction; the follow-on live Mama PC probe remains required to prove this specific bootstrap-file-to-API path.

## Evidence pointers

`tests/unit/windows-desktop-bootstrap-status.test.ts`, `tests/unit/desktop-probe-readiness.test.ts`, `tests/integration/desktop-routes.test.ts`, and the existing `tests/e2e/desktop-mesh-boot-lifecycle.test.ts`; local TypeScript build, syntax check, package inventory, and `instar dev:preflight` passed. Live fleet state is in `.instar/desktop-mesh-live-proof-131439.md`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller added — not applicable.

## Follow-up: Windows update handshake classification

The first live result was `phase=update, code=prepare-update-failed`, which still grouped connection failure, a signed HTTP refusal, timeout, and malformed reply. The follow-up maps only those failure classes to fixed codes. It does not add an update bypass or change the requirement for an update token before replacing a running Windows task. The code runs only after desktop opt-in during WSL bootstrap. If the companion cannot prepare, the desktop stays off while the Instar agent remains reachable. Addresses, paths, HTTP bodies, and keys stay out of the diagnostic. The focused classifier test covers both the observed generic failure and each new boundary; HTTP and production-boot coverage remain on the same route/provider path. Live Mama PC retest after package activation is required to identify the cause and to prove the eventual repair.

### Follow-up decision review

1. **Over-block:** A failed prepare still turns desktop off, as before. Classification does not reject a new input; a malformed successful reply remains a failure.
2. **Under-block:** Unknown fetch errors become `prepare-reply-invalid`, so diagnosis can still be coarse. Raw errors never escape through the maintenance API.
3. **Layer:** The installer owns the transport observation; the status parser owns the fixed vocabulary. The existing desktop admission check remains the authority.
4. **Signal versus authority:** This is a maintenance signal. No brittle error mapping can grant or block a desktop session. A failed token handoff still blocks replacement under the approved update protocol.
5. **Interactions:** A later successful boot writes `ready`, clearing the current boot's failure. Per-process nonce rejects prior-boot status. No retry timer or task restart is added.
6. **External surfaces:** Bearer-only diagnostics can show a more precise fixed code. The PIN viewer, machine picker, grant, and input protocol are unchanged.
7. **Multi-machine:** Status is local to the Windows WSL host by design. The Studio front does not proxy this maintenance detail or display paths/addresses.
8. **Rollback:** Revert the classifier and installer message in a patch release. Existing failure status remains bounded and expires at process restart; no migration is needed.
