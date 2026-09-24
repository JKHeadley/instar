# Side-Effects Review — agent-driven sign-in navigation (minimal first version)

**Version / slug:** `agent-driven-relogin`
**Date:** `2026-09-24`
**Author:** Echo (autonomous, topic 33890)
**Spec:** `docs/specs/agent-driven-relogin.md` (converged, approved by Justin 2026-09-24 08:04 PDT)
**Second-pass reviewer:** see appended section

## Summary of the change

The assisted re-login driver gains an `agent` navigation mode: on every non-terminal, non-safety page a model chooses the next step from an open, floor-filtered list of the page's visible controls plus typed fills, instead of the fixed page-class table. Terminal and safety pages keep their deterministic handling. Dev-gated: `navigation` omitted ⇒ agent on a development agent, closed on the fleet.

Files modified:
- `src/core/AnthropicReloginBrowserDriver.ts` — `ReloginControlObservation`, optional port methods `observeControls` / `clickControl`, deps `navigation` / `navigate` / `driveDeadlineMs`, `agentStep`, pure `buildAgentOffer` / `redactLabel` / `isBlockedControl` / `AGENT_BLOCKED_PHRASES`, a hard deadline raced against every browser and model call (both modes), resolved-secret tracking for verbatim stripping.
- `src/core/ChromeCdpReloginBrowser.ts` — shared in-page `ENUMERATE_CONTROLS`, `observeControls`, `clickControl` (refuses when the numbered control's text changed).
- `src/core/SubscriptionReloginOrchestrator.ts` — optional `driveEventClass` dep (default unchanged).
- `src/core/SubscriptionReloginRuntime.ts` — `navigation` / `navigate` deps, `resolveReloginNavigation`, `agent-drive-started` event class in agent mode.
- `src/commands/server.ts` — navigator prompt over `sharedLlmQueue` + `sharedIntelligence` (`balanced`, 20 tokens, provenance on the existing `subscription-relogin-action` decision point and the existing `subscription-relogin-supervisor` attribution label — same role, one permitted action per step), navigation resolution, boot log shows the mode.
- `src/core/types.ts` — `assistedRelogin.navigation`.
- `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts` — awareness bullet + idempotent migration.
- Tests: unit, integration (real Chrome + runtime), e2e (production AgentServer).

## Decision-point inventory

- **Added (judgment-candidate):** next browser action in agent mode. Floor: the offered list (origins, identity, destructive/credential phrases, measured consent, redaction), re-checked at click time; conservative default `give-up`; fallback ladder step budget → deadline → existing retry and breakers. Arbiter: `verifyIdentity` + `verifyAuthenticatedUse`.
- **Added (invariant):** the floors themselves; the drive deadline.
- **Modified:** none of admission, approval, breakers, notices, verification.

## The seven review dimensions

1. **Over-block:** the destructive-phrase list can hide a legitimate forward control (e.g. a "Set up" step on an unfamiliar page, or "Use another account" when the expected account is not listed). Effect: the drive ends transient — the same outcome the closed table already produced on unknown pages — never a security refusal. Accepted; tunable later from real episodes.
2. **Under-block:** a generically labelled control on an allowed sign-in page could in principle change an account setting; bounded by the origin list, the phrase block, the model's instructions and the one-at-a-time lease; named in the spec as the reason the fleet stays closed. Short passwords echoed in page text are stripped verbatim only once the driver resolved them in this drive (a password is resolved at its fill, before any page could echo it).
3. **Level-of-abstraction fit:** the change sits in the existing driver loop and reuses its floors, lease, outcome classes and store unchanged; no new process, socket, hook, table or config migration. The model replaces only the closed `allowedActions` + Tier-1 `supervise` choice.
4. **Signal vs authority:** the model's token has authority only over *which offered action runs*; it can never declare success (verification does), never reach an off-list origin, never see or type a value. The phrase block is a deterministic guard on irreversible actions (the documented exemption).
5. **Interactions:** the deadline wrapper is added to both modes; in closed mode it only bounds calls that previously could hang (no behavior change on healthy runs). The seat lease release still happens in `finally` after the bounded browser close. `driveEventClass` defaults to the old value, so existing event consumers are unchanged on the fleet.
6. **External surfaces:** provider sign-in pages see ordinary real clicks, as before. Model calls go through the shared queue (off-Claude by default via component routing) — at most ~40 short calls per drive, a few drives per week in practice.
7. **Multi-machine posture:** machine-local by design (the Chrome profile and CLI config home are on the repairing machine — `physical-credential-locality` marker in the spec). The config value is per machine; episode metadata and notices are unchanged.
8. **Rollback cost:** set `subscriptionPool.assistedRelogin.navigation: 'closed'` (no restart of anything but the server) or revert the release. No data migration; the only new persisted artifact is the event-class string.

## Second-pass review

Independent reviewer (read-only, code audit of `git diff origin/main -- src`). First pass raised: (1) `clickControl` re-checked only the control's text, not the account it names — two same-named rows reordering could swap accounts; (2) `AGENT_BLOCKED_PHRASES` lacked account-creation phrases; (3) closed mode did not bound `supervise`/`perform` with the deadline; (4) partially hidden emails (`j•••@gmail.com`) passed unmasked. All four fixed (identity re-check at click with a real-Chrome test; "create account", "sign up" et al. blocked; closed-mode calls bounded; partial emails masked). Re-review: **Concur with the review.**

## Follow-up — consent-page fix (2026-09-24, after the first live run)

The first live agent drives reached Claude's authorize page and the model chose Decline. Added `decline`, `deny`, `switch account`, `not you` to the blocked phrases (none moves a sign-in forward; `switch account` changes identity), clarified the navigator instruction for consent pages, and added one redacted step-trail log line per agent drive. Over-block: a page whose only forward control contains one of these words — none known; the drive would end transient, not refused. No new decision point.
