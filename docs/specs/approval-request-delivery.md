---
title: "Approval Requests That Reach The Local Owner"
slug: approval-request-delivery
author: echo
approved: true
approved-by: "Justin, post-mortem fix program authorization 2026-11-20, plus Chief of Staff scope decision827882b3-f7e9-4940-a5c4-ab47d322c733; provenance confirmed by Chief23753f3b-8fe6-47d9-b720-6b01f2bb9609"
tier: 2
parent: trust-journey
parent-principle: "Trust Is Earned by Work and Granted Only by the Person"
review-convergence: "2026-11-22T10:30:29.208Z"
review-iterations: 1
review-completed-at: "2026-11-22T10:30:29.208Z"
review-report: "docs/specs/reports/approval-request-delivery-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 1
contested-then-cleared: 7
---

# Approval Requests That Reach The Local Owner

## Problem statement

An asking session can receive WAITING FOR APPROVAL even when no request was opened or its message never reached the owner. Three observed open requests for mcp__codex_apps__github__fetch_pr were wrongly classified as modifications and undelivered. The Chief also reported a create_worktree approval refusal without a request; its original transcript has not been independently inspected. Repair the local core without widening write permissions.

## Authority and scope

Chief decision827882b3-f7e9-4940-a5c4-ab47d322c733 says, "Keep only the local, single-machine core" and "run one bounded review of the narrowed spec, and build it if it converges." It narrows the build after six-round convergence failed: implement exact read classification and honest local request/delivery presentation; one bounded narrowed review, then build only if converged. Do not implement cross-machine forwarding changes, successor custody, shared-acceptance recovery, new delivery retry state machines, deadlines, capacity policy or custody transfer. Existing forwarding remains unchanged and outside the local guarantee. This is an explicitly authorized partial scope, not an assertion of fleet-wide repair.

## Proposed design

### Exact server-owned read contract

Add an entry matching the original complete toolName mcp__codex_apps__github__fetch_pr, not its lossy flattened action. Its physical operation is read for public and private repositories alike; the connector continues enforcing repository access. Derive exact hook read names and fallback names from that same source entry. Unknown names, flattened collisions, write, modify, delete, create_worktree and sensitive sign-in stay governed. No connector-wide exemption or new grant. Classify supplied tool_name with server-owned deriveEffect before the revival side-effect guard; caller mutability cannot downgrade a real write or falsely block this exact read. Existing no-tool-name legacy behavior remains.

### Local request and actual delivery

On the existing holder-side local proposal path, record the request before sending the card, including when chat acceptance already exists. If the initial durable write fails, send nothing and return a specific not-recorded refusal. Preserve current caps, deduplication, exact-change card, owner identity, acceptance, expiry, actual reply target, proof, one-time dispatch and device authority.

Add a dedicated trusted Telegram approval sender using the existing bounded owner-decision category. Only actual account-path approval, prerequisite and outcome messages use it; ordinary automated direct messages retain their quiet behavior. The sender addresses the configured owner private chat and uses the real platform acknowledgement. Do not claim delivery from the presence of a row. Slack retains its existing port but a null/throw result is not reported delivered.

A local proposal returns actionable sent only when the open, unconsumed, unexpired request has a durable actual card anchor for the currently configured owner and current matching chat acceptance; available-in-app requires a current eligible accepted device. Awaiting-acceptance requires an actual current-owner delivered prerequisite marker and an existing pending request that the unchanged local acceptance path can continue. Bind the existing acceptance-sent marker to accountId; legacy unbound markers are not sufficient presentation evidence. The owner's authenticated exact acceptance remains authority. In the existing authenticated ingress, treat a mismatching former-account acceptance as absent and durably record the actual current owner acceptance before acknowledging success; check write failure. Do not add shared prerequisite retry, recovery or cross-machine coordination.

A deduplicated existing row with no card and no verified actionable prerequisite is delivery-unconfirmed, not awaiting-acceptance. Do not resend it automatically. Derive the result from all current surfaces: if chat fails or is uncertain but that exact live request is currently approvable on an accepted device, return available-in-app with the chat uncertainty explained; verify the real app listing. Otherwise a failed/null/throwing send, missing approver, cap refusal, storage failure or anchor-write failure returns a plain refusal explaining what is known: the owner was not asked when known no send occurred; delivery could not be confirmed after an ambiguous send or anchor failure. Never falsely state nothing was sent after network ambiguity. No automatic retry or recovery is added. Existing expiry/withdrawal behavior is preserved without promising it resolves shared acceptance uncertainty.

### Safe evidence-bound local presentation

Use a finite version1 approval object with status and surface. A new opaque presentation reference is unnecessary for this narrowed repair: do not serialize internal requestId or approval code into new route/hook output. Local actionable statuses are sent/direct-chat, awaiting-acceptance/direct-chat and available-in-app/accepted-device. Only these corroborated outcomes map to outer action ask. Other local outcomes map block with a safe reason; unknown result shapes map block/unconfirmed. Keep underlying trust admission provenance diagnostic, not a false owner-wait claim. Proceed-once dispatch storage failure is a specific block, not a new approval ask.

Keep the existing hook8-second abort active through response JSON parsing (installed Codex handler12seconds); test a never-resolving local adapter through the actual installed hook, requiring exit2 before handler kill and no later permission from a late acknowledgement. No new server deadline or retry is added. The generated hook prints WAITING FOR APPROVAL only for version1 actionable status/surface combinations. An old/missing/unknown ask object yields APPROVAL REQUEST UNCONFIRMED and exit2. Structured local block prints the safe refusal. No new state permits an action. New server with old hook receives ask only for genuinely actionable local results. Remote forwarding output is not rewritten in this scoped build; new-hook validation conservatively refuses old remote asks without evidence.

Use one bounded local structured refusal trace helper before local approval refusal returns: outcome/reason, timestamp, deciding machine and local/forwarding disposition, no code, raw input or internal identifier. Trace failure preserves refusal and reports inability to record evidence; it never allows the action. Reuse the existing local operation-observability mechanism where possible. No new alert controller, work-conversation delivery pipeline, cross-machine guarantee or retry promise is added. The asking session receives the explicit reason through the actual API and hook.

## Decision points touched

| Decision | Classification and basis | Choice |
|---|---|---|
| Exact original read name | invariant; basis: enumerable-domain; evidence: observed fetch_pr contract only reads, flattened names collide | Exact raw-name entry; no broad exemption |
| Durable request before card | invariant; basis: irreversible-consequence; evidence: an unrecorded owner-visible card cannot be safely consumed | Record first; failed write sends nothing |
| Actionable local waiting | invariant; basis: enumerable-domain; evidence: finite actual proposal and delivery outcomes | Require live request and current actual approval surface |
| Owner and acceptance evidence | invariant; basis: irreversible-consequence; evidence: a former owner or unaccepted chat cannot approve for current owner | Current configured account and existing authenticated acceptance/proof |
| Ambiguous send | invariant; basis: irreversible-consequence; evidence: lost acknowledgement may follow physical delivery | Plain unconfirmed block; no automatic resend |
| Safe output | invariant; basis: irreversible-consequence; evidence: internal requestId embeds approval code | New presentation excludes code and internal identifier |
| Refusal trace | invariant; basis: external-constraint; evidence: registry conservation-of-negative-outcomes requires local trace before refusal returns | Safe local structured evidence; failure never grants |




## Frontloaded Decisions

| Decision | Classification and basis | Choice |
|---|---|---|
| Exact original read name | invariant; basis: enumerable-domain; evidence: observed fetch_pr contract only reads, flattened names collide | Exact raw-name entry; no broad exemption |
| Durable request before card | invariant; basis: irreversible-consequence; evidence: an unrecorded owner-visible card cannot be safely consumed | Record first; failed write sends nothing |
| Actionable local waiting | invariant; basis: enumerable-domain; evidence: finite actual proposal and delivery outcomes | Require live request and current actual approval surface |
| Owner and acceptance evidence | invariant; basis: irreversible-consequence; evidence: a former owner or unaccepted chat cannot approve for current owner | Current configured account and existing authenticated acceptance/proof |
| Ambiguous send | invariant; basis: irreversible-consequence; evidence: lost acknowledgement may follow physical delivery | Plain unconfirmed block; no automatic resend |
| Safe output | invariant; basis: irreversible-consequence; evidence: internal requestId embeds approval code | New presentation excludes code and internal identifier |
| Refusal trace | invariant; basis: external-constraint; evidence: registry conservation-of-negative-outcomes requires local trace before refusal returns | Safe local structured evidence; failure never grants |
| Existing caps and timeouts | unchanged policy | No new fixed behavior limit, coordination lane or timeout |
| Scope boundary | frontloaded authority decision | Chief827882b3 narrowed to local core; distributed work tracked separately |

## Multi-machine posture

The existing trust records remain unified in the existing trust-journey replicated log. This repair adds no machine-local permission state or grants. The new guarantee is explicitly restricted to a local proposal handled and delivered on the current deciding machine, per Chief scope decision. Existing holder forwarding, replication and peer receipt authority are untouched. No successor redelivery, global deduplication, remote-head completeness or fleet-wide delivery claim. Physical platform credentials retain their existing per-install binding; no credential is copied by this repair.

## Migration and rollback

Change the canonical generated external-operation hook and verify the existing unconditional built-in hook refresh plus init path deliver it to existing and new agents. Exact read fallback names use the same source table. Add awareness text through src/data/awareness. Existing config and grants stay unchanged. Downgrade restores the old misleading presentation and read classification; it does not grant writes. The new current-owner marker field accountId is already known to the baseline reader. No new request schema or custody version is added.

## Tracked distributed design item

Cross-machine forwarding, successor-machine behavior and shared-acceptance recovery are explicitly removed by Chief827882b3, next to the source-head gap handed off7196f945. Preserve the previous failed-convergence report and its five open findings: pending start-marker slot reservation; shared acceptance uncertainty versus expiry recovery; originating deadline across machines/clock uncertainty; visible originating-conversation failure notice; safe local refusal traces. The local trace part is included here; its distributed extension remains recorded. <!-- tracked: CMT-2193 -->

> **CMT-2193** — "Design separate distributed approval recovery alongside the trust source-head gap before implementing it: pending-start capacity; shared-acceptance uncertainty versus expiry; originating deadlines across machines; visible originating-chat failure notice; local/distributed refusal traces. Chief827882b3 excluded this work from the current local repair; await separate prioritization."

The generated carrier snapshot is docs/specs/carriers/approval-request-delivery.json. This is the tracked design intake required by Chief827882b3, not authorization to implement distributed recovery in this build.

## Test and verification plan

Unit tests cover exact raw read and collision/write/sign-in boundaries, canonical hook names, durable-before-send, null/throw/no-owner/cap/storage/anchor failures, duplicates with and without actual surface, current-owner acceptance marker and exact safe presentation, local refusal traces. Test the generated hook subprocess against actual HTTP fixtures for valid actionable states, unknown/old asks, local failures and exact read offline versus governed writes.

HTTP integration uses the real local operations route with real trust store/runtime and notification-gated adapter. Prove read produces no request; governed refusal produces a durable request and actual controlled owner delivery; failure gives truthful block and actual local trace. Lifecycle must use the actual production initializer or a shared exported initializer used by commands/server.ts, real adapter ingress, installed hook refresh and actual notification gate, proving the feature is wired rather than a hand-built no-op dependency. Controlled platform callbacks are not a live Telegram proof. Do not send a real owner approval ask while building. Coordinate one exact targeted batch with Throughput; no unallocated manual full suite. Complete normal LocalVerify of final pushed draft head remains mandatory.

## Maturation plan

- **test-agent-live:** Controlled throwaway production-initializer, actual notification gate, HTTP route and installed-hook lifecycle evidence in the allocated targeted batch; no real owner ask during build.
- **dev-agent-live:** After merge and normal release, an explicitly authorized owner-role receipt-and-action canary on the development agent verifies local Telegram or Slack delivery. Until that evidence exists, report implementation/controlled verification only.
- **fleet:** Normal update path refreshes canonical hooks and awareness; verify intended serving installs before claiming the local repair available there. Distributed recovery remains outside Chief-authorized scope.
- **graduation criterion:** Exact read never opens a request, protected writes remain refused pending actual owner authority, actionable local asks have genuine request/surface evidence, and delivery failure is explicit in the asking session; complete normal LocalVerify and authorized live canary before live-done claim.
- **dark-window:** No new dark flag or timed waiting window. Build stays draft through required verification; no live deployment claim from build tests.

- **ladder:** not applicable: existing always-on trust approval path, no new flag

## Open questions

None.
