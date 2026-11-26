# Side-Effects Review — Plan Approval Clarity

**Version / slug:** plan-approval-clarity
**Date:** 2026-11-23
**Author:** echo
**Second-pass reviewer:** review_plan_approval (SMALL independent review)

## Summary of the change
Tier 1, SMALL. Three runtime/test files plus overview, this artifact and a release fragment. The Plans list previously ignored its existing needs metadata and displayed only progress. Shared approval wording now leads the visible subtitle and the panel. One review pass identified missing visible wiring and requested warning/tracking regressions, both addressed. Two red/green iterations before final verification. No authority surface changed.

## Decision-point inventory
Existing projectNeedsOk eligibility, projectActions selection, ack endpoint and forRoundIndex payload are passed through unchanged. No new permission, filtering, blocking or scheduling decision.

## 1. Over-block
No legitimate action or input is rejected. This change only renders text.

## 2. Under-block
No validation or authority is added. Existing routes still own permission enforcement. Long names retain the existing bounded name presentation; no newly inferred names.

## 3. Level-of-abstraction fit
The shared pure Plans model owns display words, and the existing renderer displays them. The API and scheduler do not need to change. Error details remain alongside the new request.

## 4. Signal vs authority compliance
Complies with docs/signal-vs-authority.md. This is presentation of an existing authority result, not a detector with blocking power. No behavioral constraint or action gate is added.

## 5. Interactions
Both list and sheet use the same helper. Non-approval rows and tracking-only subtitles stay unchanged. Existing progress and detail-read failure context remain. No polling, cleanup, retry or race behavior changes.

## 6. External surfaces
Only web Plans display and shared model-derived Needs text change. No new API, durable state or external calls. Existing approval is phone-completable through the web dashboard; only its label changes. Approval does not start work, and the interface says so.

## 6b. Operator-surface quality
1. The approval reason is visible in the list and panel before the action. It leads with the work name.
2. No new raw identifiers or internal slugs; unnamed work uses a numbered step.
3. No destructive action is added or promoted. Existing stop/resume placement is unchanged.
4. Plain wording uses review, approve and step. Existing responsive row and sheet CSS wraps text and preserves tap targets. DOM tests exercise the actual action and safe text rendering. Four real Chrome preview cases at 390 and 1280 pixels in light and dark themes passed: no horizontal overflow, title contained and approval target 48 pixels high. Private geometry and screenshots are under .instar/dashboard-makeover/plan-approval-clarity on the agent home. No native app claim.

## 7. Multi-machine posture (Cross-Machine Coherence)
Replicated: shipped dashboard assets update through the normal package installation on every machine; the existing project records are read through the same project API. No new state, notices, URLs or machine-local assumptions. No status, health, capabilities or channels verdict changes. Different installed versions may show different wording until their normal update.

## 8. Rollback cost
Revert and release a patch. No state migration or agent repair. Permission already recorded by the existing endpoint is unaffected by reverting labels.

## Conclusion
Display-only repair. 223 focused tests, the production build, one existing production Needs lifecycle test and four browser previews passed. Normal shared complete verification remains required before release. No approval gate bypass or duplicate full suite is authorized by this change.

## Second-pass review
Reviewer review_plan_approval concurred with the runtime change and requested assertions preserving failed-detail warnings and tracking-only subtitles. Both assertions added. The existing timeline still calls its groups Rounds; this patch changes approval copy, not the project data model.

## Class-Closure Declaration (display-only mirror)
No agent-authored-artifact defect — not applicable. No self-triggered controller added or modified.
