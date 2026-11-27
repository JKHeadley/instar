# Side-Effects Review for Mac Setup Startup and Sign-In

**Version / slug** `mac-setup-launch-and-sign-in`
**Date** 2026-11-26
**Author** echo
**Second-pass reviewer** review_startup

## Summary of the change

The app installer passes its existing setup mode to the provider sign-in step. The detached server launcher passes the current Node executable and the resolved project directory to tmux and its child.

## Decision-point inventory

The installer remains responsible for advancing its existing sign-in step. For app setup it now also consumes the account probe's inconclusive result and checks whether the sign-in process still matches its recorded process stamp. The server startup change preserves two resolved launch inputs.

## 1. Over-block

An already signed-in account can temporarily fail verification because its provider, network or Keychain is unavailable. App setup pauses and a retry checks again. The standalone installer keeps its existing behavior.

## 2. Under-block

A successful sign-in probe confirms the selected provider session at that point in time. The account can expire or be signed out later, when normal provider authentication still applies.

## 3. Level-of-abstraction fit

The existing provider adapter supplies the sign-in result. The setup state machine owns step progression and reuses the existing resumable sign-in process tracking. The launcher is the place where the executable and directory cross into tmux.

## 4. Signal vs authority compliance

[Signal vs authority](../../docs/signal-vs-authority.md) applies to the setup decision. The existing state machine consumes the selected provider probe, explicit app mode and tracked process state. The probe itself has no blocking authority.

## 4b. Judgment-point check

There is no new static heuristic at a competing-signals decision point. The app requires a verified sign-in or an already supported authorized token path before creating a provider-backed agent.

## 5. Interactions

The installer waits for a matching live sign-in and avoids starting a duplicate. A stale or reused process identifier does not count as a matching sign-in. Setup uses its existing failure ledger and resume action. The child and tmux working directory use the same absolute path, including when the caller supplies a relative path.

## 6. External surfaces

The app may show a retry when a provider account cannot be verified. No new network endpoint or configuration is introduced. Background starts use the calling process's Node executable.

## 7. Multi-machine posture

This is machine-local by design. The selected executable, project directory, provider credential and tmux process belong to the machine running setup. No state is copied to another machine.

## 8. Rollback cost

Revert the code and release the revert. There is no data migration. Existing installer progress can resume through the prior steps.

## Independent review

The reviewer identified that forwarding a relative directory would resolve it a second time inside tmux. The launcher now resolves the path once before using it for the working directory and child argument. The reviewer confirmed the app-only retry policy matches the requested behavior.
