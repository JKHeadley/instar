# Side-Effects Review — Codex account selection by weekly expiration

**Version / slug:** `codex-weekly-reset-routing`
**Date:** 2026-11-22
**Author:** echo
**Second-pass reviewers:** reset_spec_safety, reset_spec_integration, reset_spec_completeness

## Summary of the change

Tier 1: a reversible repair of existing account placement, with no credential writer, new endpoint, model change or new restart authority. Interactive cloud Codex now uses its existing resolver, launches in the selected home and records the matching account. Legacy and window-aware Codex selectors share weekly-expiration priority inside their existing eligibility floors. Automatically selected resumes preserve their saved thread or report a failure; account refusal and dead-startup paths release admission correctly.

The code changes four existing runtime modules plus an awareness entry. Unit, HTTP integration and lifecycle tests accompany them. The final narrow code received one independent multi-perspective review and a cleanup correction with concurrence. Planning effort was disproportionate to the final Tier 1 repair: a broader lifecycle-controller design was rejected, and its draft review tags are not reused or claimed as approval for this change.

## Decision-point inventory

- Existing placement authority: prefer the earliest fresh valid Codex weekly deadline among eligible accounts. Claude ranking and all eligibility/headroom floors remain intact.
- Interactive Codex launch: use the existing Codex resolver when no explicit account home and no local provider were supplied. An orphan account label refuses before launch.
- Automatically moved resume: missing/failed placement or dead startup reports failure instead of silently starting a new thread. Existing explicit-home fallback behavior is unchanged.
- Admission cleanup: release before-tmux refusal slots, retain slots for a live created session, and mark a dead resumed session failed before releasing its slot.

## 1. Over-block

No new quota threshold is introduced. An automatically selected resume that cannot locate or launch its saved conversation now refuses rather than opening an empty one. The pending bootstrap and original rollout remain for recovery. A local model skips paid-account placement. An explicit account label without a corresponding home refuses because it cannot truthfully identify the launched login.

## 2. Under-block

This is account routing, not a full spending controller. Existing quota cutoffs, freshness windows and rescue behavior remain. It does not guarantee exact exhaustion at reset. Existing untagged conversations remain unattributed until a normal lifecycle launch selects an account; this change never invents tags or forces active work to move.

## 3. Level-of-abstraction fit

The shared deadline comparator reads the existing window-state classifier; it does not fabricate reset dates or create another controller. The existing resolver remains the source of account/home selection. The interactive path consumes the same decision as the headless path, and the existing rollout placement carries the conversation.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). The comparator is a pure ordering input to existing placement authorities. No message/content filter, credential permission, new autonomous kill authority or parallel spending gate is added.

## 4b. Judgment-point check

The routing preference implements the operator's explicit weekly-expiration objective, relayed in Chief handoffs 71371169-a65e-4031-affe-c183520ea6b9 and d37b61da-b101-4402-8bbf-59d1a2004b7e. Existing credential availability and headroom constraints remain deterministic floors. Task/model priority is not newly inferred by a heuristic here. No timer is given authority to interrupt work.

## 5. Interactions

A short-window reset can still make an account ineligible but cannot outrank another account's different weekly deadline. Equal deadlines retain existing tie-breaks. Mixed-provider candidate sets retain the previous scoring order, avoiding a partial deadline order across providers. Unknown, stale or rolled weekly dates do not become urgent deadlines. Explicit homes remain dominant. Resolver-selected homes are passed consistently to launch, rollout placement and account-sensitive MCP planning.

The strict startup failure path marks persisted state failed and releases admission before throwing. It does not emit the event whose consumer would clear the saved resume ID, and it leaves pending injection custody intact. The outer admission cleanup only releases a pre-tmux failure; a live session's injection error cannot surrender its running recovery slot.

## 6. External surfaces

New interactive cloud sessions now have real subscription-account tags and corresponding CODEX_HOME values. Existing conversations are not restarted by a new loop. Refusal or failed resume is visible rather than a false fresh-conversation success. No account login, token, configuration default or provider/model preference is changed by the source patch.

## 6b. Operator-surface quality

The release note and overview describe the behavior in complete sentences. The awareness entry tells agents to distinguish session attribution from pool capacity and never describe an old untagged conversation as assigned to a particular pool account without evidence.

## 7. Multi-machine posture

The policy ships through the normal release/update path on every machine. Eligible account homes are machine-local because credentials physically reside there; no credentials or live process state are replicated by this change.
machine-local-justification: physical-credential-locality

Existing owner routing determines which machine launches the conversation. Existing pool views expose account/reset observations. No independent per-machine notification source or new durable store is introduced. The new awareness file reaches new and updated agents through the existing awareness registry.

## 8. Rollback cost

Revert the source change. Correctly tagged sessions and their CODEX_HOME remain supported by the old account-swap launch path; no schema or credential rollback is required. Copied rollout files preserve their originals. No configuration or account default was changed as a stopgap.

## Evidence pointers

- `.instar/recovery/token-reset-routing/codex-related-unit.log`: 151 checks across seven related unit files passed on the Studio, including the new account-selection and lifecycle-refusal boundaries.
- `.instar/recovery/token-reset-routing/codex-integration-final.log` and `codex-e2e-final.log`: final targeted HTTP/lifecycle runs on the Studio; their recorded exits/counts are the evidence, not this prose.
- `.instar/recovery/token-reset-routing/codex-live-selector-comparison.json`: one fresh, read-only pool snapshot fed to both installed and corrected selectors. Installed headless choice: codex-sagemindai (9%, Thursday); corrected choice: codex-justin-gmail (20%, Tuesday). The Studio's default interactive login was separately observed as dawn. This comparison is not an installed-code or live-user-channel claim.
- Final mixed-provider delta review found no material findings; 78 related ordering checks passed. Final HTTP integration passed 7 checks and lifecycle passed 3 checks.
- Type checking and normal commit/push gates run before publication. Full normal Local Verify and a verified installed-session reply remain required before a live-success claim.
