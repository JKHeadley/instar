# Side-Effects Review — Template Agent-ID Header

**Version / slug:** `template-agent-id-header`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change updates the fleet-installed local API client surface so bearer-authenticated template calls also send `X-Instar-AgentId`. It adds `INSTAR_AGENT_ID` env propagation from `Config` -> `JobScheduler` and `SessionManager`, updates built-in job templates, hook/script templates, and selected migrator inline hook content, and adds a template scanner regression test.

## Decision-point inventory

No new decision point is added. Existing server auth remains the authority for missing/mismatched agent-id headers. This change only updates clients/templates to provide identity to that existing authority.

## 1. Over-block

No block/allow surface is added. A malformed or missing `projectName` could make a template send an empty or wrong `X-Instar-AgentId`, which the existing server auth would reject. The normal paths use `config.projectName`, and direct-run fallbacks read the same field.

## 2. Under-block

This does not remove the server's bearer-only compatibility window. A custom user-authored curl outside shipped templates can still be bearer-only and receive the deprecation warning until the server policy changes.

## 3. Level-of-abstraction fit

The fix sits at the client/template layer. The server already owns auth authority and should not be weakened to hide template warnings. Scheduler/session env propagation is the right shared primitive for jobs and hooks.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`

No brittle blocking authority is introduced. The change feeds identity into the existing deterministic auth authority; it does not add a new detector or gate.

## 5. Interactions

The scheduler now injects `INSTAR_AGENT_ID` alongside `INSTAR_AUTH_TOKEN` for gate and script job shells. `SessionManager` injects the same variable for spawned sessions, so hook and prompt-job examples have it. Fleet watchdog peer requests read the peer project name and bind the peer token to the peer identity.

## 6. External surfaces

Installed agents get quieter logs and future-compatible local API calls after template refresh/migration. No public API response shapes change. No persistent state is written.

## 7. Rollback cost

Rollback is a source/template revert and patch release. Existing agents would fall back to the current accepted-but-deprecated bearer-only behavior until a corrected template ships.

## Conclusion

Clear to ship as Tier 1. The change aligns installed templates with the existing auth contract and pins the class with a scanner test.
