# Side-Effects Review — installer core (`instar install`)

**Version / slug:** `install-core`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent, reviewed the code before this artifact; its 8 findings were fixed and the fixes were not re-reviewed`

## Summary of the change

First increment of phase 1 of `docs/specs/install-experience.md`. Adds `instar install`: a deterministic flow on the shared wizard state machine, a resumable ledger at `~/.instar/state/install-progress.json`, an answers file, exit-0 on waiting for a person, door contracts for Claude Code and Codex with a live signed-in proof, consent listing, disk and tool checks, quiet output to a log, and agent creation in the default home with no public tunnel. Tier 2, about 1,000 lines of source and tests. Two spec review rounds were not repeated for this increment. Nothing publishes it: `npx instar`, the setup wizards and existing agents are unchanged. First-result, browser routes and the published scripts come in later increments.

## Decision-point inventory

- Door signed-in verdict — add — one live call; only a definite rejection reads signed out, everything else `unknown`. Invariant per spec section 11.
- Which door to offer — add — implied by the running harness or the only detected door, otherwise one question.
- Agent name accepted — add — validator refuses bad or taken names.
- Consent — add — a single stated consent, listing the plan. `--yes` is explicit, and the plan is still printed.

## 1. Over-block

Preflight refuses below 1.5 GB free, on old Node and on non-Linux, non-Mac platforms, each with a next step. Unknown disk space doesn't refuse. A person with a working but unusual tmux or git location is found through PATH. `gitWorks` could refuse a Mac where `xcode-select -p` fails but another git works; the next step is a plain instruction.

## 2. Under-block

Unattended `--yes` under a harness can't verify a person read the plan; spec 4.3 states this limit. A program running as the user can read local state. `hasBrowser` assumes WSL and a Mac can open a window, so the instruction also says what to do if none opened. Only Claude Code and Codex are offered; other doors are phase 3.

## 3. Level-of-abstraction fit

The flow lives in the existing `state-machine.ts`, as the spec requires, and the Codex and Gemini drivers keep their flow. Installing is deterministic code because no model exists before sign-in.

## 4. Signal vs authority compliance

No outbound or inbound message is gated. The signed-in verdict decides only whether to start a provider's own sign-in, and it fails toward leaving a login alone.

## 4b. Judgment-point check (Judgment Within Floors standard)

Door offer: floor is detected doors, default the running harness, fallback the one question. Matches spec section 11.

## 5. Interactions

- `init`: gains `role` and `skipCloudBackup`; other callers are unchanged. The installer never passes `autostart`, because on 2026-11-02 that flag let a sandboxed test agent register a real systemd unit. The autostart step goes through the CLI path, where the throwaway guard applies.
- `redetectFrameworkBinary` clears one memo entry and the npm prefix memo. Only the installer calls it.
- A half-built agent directory is moved aside to `<name>.partial-<time>`, never deleted.
- Default jobs start within a minute of the server starting; first-day cost is the 15% rule in a later increment.

## 6. External surfaces

New CLI command. It runs `npm install -g`, `sudo` package commands the consent names, and a provider's own sign-in. It calls Anthropic's usage read and the Codex app server, both read-only. Sets `tunnel.enabled: false` on agents it creates, so they have no public address until one is chosen.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Terminal text is plain, with a next step on every stop. The token page that replaces "run this in your terminal" for AI-tool installs is the next increment, and this command isn't published until then.

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local-justification: physical-credential-locality. The ledger records setup of this disk's binaries and logins, per the spec's table. Single-machine at install time.

## 8. Rollback cost

Revert the commit. Nothing installed depends on the command, and no migration is involved. An agent already created this way is an ordinary standalone agent.

## Conclusion

Safe to ship unpublished. Real run on a throwaway agent passed; see evidence.

## Second-pass review (if required)

Not required by the phase 5 list. Run anyway. It reported 8 defects, including a false failure on every clean machine from the detection memo, Ctrl-C being trapped by an open readline, signing in over working logins, and an unconsented public tunnel. All 8 are fixed with tests. The fixes themselves had no second read.

## Evidence pointers

- `tests/unit/install-flow.test.ts`, `tests/unit/install-doors.test.ts`, `tests/integration/install-agent-init.test.ts`.
- Live runs 2026-11-02 under a sandboxed home with the real Claude login: complete in about 25 seconds with Claude Code present, dashboard 200, PIN unlock 200, resume in a real terminal showed the PIN and completed, no sign-in link or token in the log, log mode 600, no tunnel.
- Not tested: a clean machine, a door actually being installed, a Mac, a real reboot, a person signing in.

## Class-Closure Declaration

- defect class: `unbounded-self-action`
- closure: `n/a`
- reason: one-shot user-driven installer, not a self-triggered loop.
