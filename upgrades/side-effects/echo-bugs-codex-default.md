# Side-Effects Review — Echo Bugs Codex default

**Version / slug:** `echo-bugs-codex-default`
**Date:** `2026-11-04`
**Author:** Echo
**Second-pass reviewer:** independent review subagent

## Summary of the change

Adds a Codex framework/model default for Telegram issues-group topics in TopicProfileResolver, with an optional file-config override, recognizes gpt-6.1-sol after the Codex CLI 0.166.0 subscription probe, and falls back to gpt-6-sol on older local CLIs. SessionManager applies the same version check to direct/headless sessions. No config opt-in is required. Test coverage exercises group identity, operator precedence, and version checks.

## Decision-point inventory

- TopicProfileResolver framework/model precedence: modified; the issues-group default sits below operator pins and per-topic config, above global defaults.
- SessionManager model launch: modified; local CLI capability selects gpt-6-sol when 6.1 cannot run.
- PATCH /config: passed through unchanged; group-wide framework selection remains file-owned.
- Per-topic profile writes and operator-binding gate: passed through unchanged.

## 1. Over-block

The new resolver rejects no topic or user message. A configured group model that is invalid for the chosen framework falls through to the framework default. Existing config API patches are unaffected.

## 2. Under-block

Version 0.166.0 is the earliest probed supported CLI, not a guarantee that every future account accepts 6.1. A CLI can report a recent version but fail authentication or server-side model admission; existing session start and breaker handling remain the recovery path. A machine without the new config retains its prior topic default until rollout reaches it.

## 3. Level-of-abstraction fit

The profile resolver already owns field precedence. The CLI capability probe is a local observation consumed at the launch boundary. The existing operator pin store remains the sole owner of per-topic intent. The group policy has a built-in default and can be overridden by file-owned agent config at boot.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. The CLI version is a bounded compatibility fact for an enumerated model/CLI pair. It does not judge message meaning. A failed probe takes the known-working model and discloses it. No brittle content detector gains blocking authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals judgment is added. Profile precedence is an explicit ordered policy; CLI compatibility uses a conservative version floor.

## 5. Interactions

Per-topic operator pins remain higher priority than group config. Legacy topicFrameworks stays per-topic and above the new group layer. The model swap may select another model before compatibility checking. A server restart is needed after config file change because the resolver captures config at boot. Codex resume-map parser still accepts session_meta payloads with cwd/timestamp; the CLI update itself is not performed by this code change. A newly enabled group default has no operator-pin event to park an old Claude UUID, so spawn reads the resume map through getForFramework and starts Codex fresh instead of passing that UUID across frameworks.

## 6. External surfaces

The resolved model and user-facing fallback note change for issues topics. Main Telegram and Slack are excluded by the issue-topic internal ID range. No new API write surface is added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The fallback says the machine has an older CLI and names the model used. No operator command is required to repair a failed launch.

## 7. Multi-machine posture (Cross-Machine Coherence)

The built-in group default is present on every updated serving machine; any optional config override is machine-local. CLI capability is machine-local by design, with a per-machine version probe. Topic pins continue through the existing profile transfer carrier. Notices come from the machine that actually launches the session. A machine lagging the CLI uses gpt-6-sol, so transfers do not strand a session.

## 8. Rollback cost

Revert the source change and remove any optional topicProfiles.groupDefaults.issues override. No persisted profile or resume-map migration is needed. A newer Codex CLI can remain installed; older model defaults still work.

## Conclusion

The change is reversible and contained to the issues group. Live proof must include a new topic restart plus its session record and footer on a machine with the new CLI.

## Second-pass review (if required)

The reviewer found that a proposed PATCH /config addition would have allowed a Bearer token to select a group-wide executable lane and could clobber a sibling model field. That addition was removed; group defaults remain file-owned. The reviewer also identified a possible cross-framework stale UUID during the first switch. The launch path now uses the existing framework-aware resume read; the focused resume E2E passes. A second pass found that a model-only config override dropped the built-in Codex framework. The resolver now merges override fields with the built-in defaults, and a new test covers it. The reviewer rechecked and concurs with the revised code.

## Evidence pointers

- Focused unit tests failed before the implementation and passed after.
- Framework-aware resume E2E passed after independent review.
- Local Codex rollout meta fields inspected; no parser shape change was found.

## Class-Closure Declaration (display-only mirror)

Issue topics on an old CLI fall back to gpt-6-sol with a plain note; no dead session is expected from this model-version mismatch. Live fleet proof is still needed.
