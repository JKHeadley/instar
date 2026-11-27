# Side-Effects Review — Owner Framework Confirmation

**Author:** echo
**Date:** 2026-11-22
**Tier:** 1, bounded repair of an existing owner-confirmation flow under Chief07621898 and clarification7f93807c. Existing typed yes is retained; no inline button or broader permission change. No new review cycle or full manual suite is authorized. One bounded second-pass read checks messaging authorization and delivery effects.

## Problem and plan

An owner asking in conversation A could not propose a framework switch for eligible conversation B: the HTTP route and write surface both excluded framework. In-topic proposals used the generic automated notification stamper and were recorded quietly. Use one existing field allowlist including framework, and a registered in-process profile-confirmation producer with the existing bounded owner-decision category. The existing server-rendered exact patch, platform echo anchor, TTL, supersession and actual-owner eligibility recheck stay intact. Acceptance is an authenticated proposal returning200 and visible Telegram delivery, no write before yes, correct target-only write after eligible yes, and unchanged security refusals. Fresh main94a330e402d43acce32d08219162b7accc6c645b, version1.3.1959, canonical remote and echo identity were verified before source edits. Work is isolated; private Node24 deps were cloned, no shared installs.

## Decision points touched

The allowed field set expands by framework only. The route and write surface now read that same set. The established crossTopicEligible authority and confirmation-time recheck are unchanged. The armed proposal send is categorized as an owner decision rather than a report. Request metadata cannot mint that category. No meaning-based filter or new runtime authority is introduced.

## 1. Over-block

No new authorization refusal. Existing source-owner, shared-conversation, target-bound, team-confinement, unknown-target, switch-off, malformed patch and non-delivery refusals remain. Ordinary automated reports remain quiet. The existing10-per-topic owner-decision budget still applies; a quiet receipt fails delivery and disarms the unseen proposal.

## 2. Under-block

Framework is accepted only through the same validated patch and operator-confirmation path as existing run settings. Direct token writes to unbound Telegram topics still fail. Cross-topic escalationOverride and messageOriginDisplay remain disallowed. No new silent write, owner substitution, pending-slot persistence or bypass is added. The internal write surface still relies on its trusted caller to perform the live cross-topic eligibility check, as before.

## 3. Layer fit

Shared structural field enumeration belongs in topicCreationProvenance; HTTP and write-surface guards reuse it. Delivery uses the existing module-bound notification capability mechanism rather than calling Telegram directly or borrowing verified-reply authority.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. This does not judge natural-language meaning. The agent proposes structured fields; the platform-authenticated person's explicit confirmation remains authority. The finite field/type boundary and cryptographically/platform verified sender identity are mechanical invariants. No brittle keyword blocker is added.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. The existing eligibility function and dev-agent switch remain unchanged.

## 5. Interactions

The proposal is still armed before send, records only a real delivered echo id, and disarms on delivery failure/quiet receipt. Confirmation checks ordering, TTL, forwarding and supersession through the existing single slot. The same shared allowlist prevents HTTP/surface drift. Owner-decision delivery does not claim to answer a waiting user turn, and is not redirected to another push topic. Existing churn/budget limits remain.

## 6. External surfaces

The propose endpoint now accepts framework with confirmIn when existing eligibility permits. Exact change display and typed yes are retained. Proposals are visible in their addressed topic under enforcing Quiet by Default. No new operator action, button, PIN, credential, endpoint, state format or config default is added.

## 6b. Operator-surface quality

The owner sees the same named target, exact delta and explicit typed-yes request in the conversation they are using. A proposal never silently changes the other conversation. No new dashboard or form is introduced. The existing rendering is retained rather than reworded in this repair.

## 7. Multi-machine posture

Existing routing and local confirm-slot posture remain. A proposal must be confirmed on the server holding its in-memory slot; a server restart loses it safely and requires reproposal. No new distributed state or notices are introduced. The changed source/awareness entry reaches all installations through the normal package update. Existing confirmation failure is shown rather than inventing success across machines. No new status/health/capabilities answer is added.

## 8. Rollback

Revert this finite field/delivery delta. No data migration or state repair. Previously applied ordinary framework pins remain valid on old code. A pending local slot still faces old allowlist refusal after rollback; re-propose in the target conversation if needed.

## Evidence and assurance

Tests cover the real write surface, HTTP boundaries and an actual AgentServer plus real TelegramAdapter/NotificationSelectivityGate. The lifecycle calls the same production applyCrossTopicConfirm helper after matching its actual delivered slot; it does not claim to run a real Telegram polling session. The allocated targeted batch passed with zero failures: six unit files/137 tests, one real HTTP file/31 tests, and two lifecycle files/15 tests. Each tier acquired the normal enforcing cap-one slot, and all exited0. The independent reviewer concurred after the two narrow corrections described below. Normal full LocalVerify remains the complete release gate. No deployment or user-visible success is claimed yet.

## Second-pass review

The single bounded reviewer found two concrete corrections: register the named producer in the source-bound notification lint, and run the existing Claude-model acceptance before switching that test harness to Codex. Both were corrected. The same reviewer independently inspected those two deltas and concurred; no edits or tests were delegated. Runtime verification remains pending.

## Class-closure declaration

The Self-Action Convergence gate detected a changed send call. Its explicit declaration is `defectClass: unbounded-self-action`, `closure: n/a`: this is a one-shot HTTP proposal, and the existing framework write/respawn occurs only after an authenticated operator confirms that exact armed patch. No self-triggered loop, timer, retry controller or repeated action is added or modified. No prompt, hook, skill, configuration or standards-text defect is fixed; not applicable to those artifact classes. The recurrence protection is the shared allowlist and both-side regression tests, not a fabricated class-level guarantee.
