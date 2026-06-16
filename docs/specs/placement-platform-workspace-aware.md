---
title: "Placement must see which platforms/workspaces a machine can actually serve"
slug: "placement-platform-workspace-aware"
author: "echo"
parent-principle: "Observation Needs Structure"
eli16-overview: "placement-platform-workspace-aware.eli16.md"
review-convergence: "2026-06-16T11:31:42.413Z"
review-iterations: 6
review-completed-at: "2026-06-16T11:31:42.413Z"
review-report: "docs/specs/reports/placement-platform-workspace-aware-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true
approved-by: "echo (autonomous run, standing operator pre-approval for topic 13481 — design/spec decisions are mine to approve and report; the one design fork (adapter-derived grounding in-scope vs deferred <!-- tracked: CMT-1568 --> cryptographic lease) is resolved + documented in the spec + convergence report)" <!-- tracked: CMT-1568 -->
---

# Placement must see which platforms/workspaces a machine can actually serve

## Problem statement

The gold-standard live-test (driving the REAL Slack channel as a real user, CMT-1568) caught this: multi-machine placement assigned a Slack channel in the **SageMind Live Test** workspace to the Mac Mini — but the Mini's Slack adapter is connected to a **different** workspace ("Echo Agent"), so it can never serve that channel. The Laptop correctly resolves owner=Mini and declines/forwards, the Mini can't pick it up (wrong/absent workspace), and the user gets only a `🔭 working` standby — never a real reply. The message black-holes.

This is the SAME shape as CMT-1570 (placement was blind to a machine's open LLM circuit), one layer deeper: **placement is blind to whether the owning machine's adapter for the channel's platform — and, for Slack, the channel's WORKSPACE — is even connected.** A channel is only servable by a machine whose adapter is connected to that channel's platform (+ workspace). Telegram is shared across machines (same operator chat → every machine is eligible); Slack workspaces are per-machine (only the machine connected to a channel's workspace can serve it).

`PlacementExecutor` (`src/core/PlacementExecutor.ts:135`) filters eligible machines by `online && clockSkewStatus` and (since CMT-1570, `:147`) by `quotaState?.blocked !== true`. It has NO filter for "can this machine serve this channel's platform/workspace." So a Slack channel can be (and was) placed on a machine not connected to its workspace.

## Glossary (codex-r5 #4 — one definition per term, used consistently)

- **workspace-reachable** (= `serves` = `yes`): a machine's adapter is connected to the channel's scope (Slack: its Socket-Mode adapter is connected to the channel's `team_id`; Telegram: its adapter polls the channel's `chatId`). The ONLY thing this fix routes on. NOT channel permission.
- **channel-authority** (= channel-permission): can the machine actually POST in this specific channel (private-channel/bot-membership/Slack-Connect ACL). Explicitly OUT of scope (a finer, later concern).
- **`yes` / `no` / `unknown`**: the three-valued reachability result — affirmatively reachable / affirmatively NOT reachable (present fresh signal, scope excluded) / no trustworthy signal (absent or legacy-request).
- **unservable**: no eligible machine is `yes` AND none is `unknown` (every machine is `no`) — a structurally-unreachable channel; surfaced as a deduped Attention item, never a silent black-hole.
- **structural validator**: a deterministic refusal allowed by signal-vs-authority ONLY because it rests on an enumerable objective fact ("zero connected machines reach this workspace"), not a judgment.

## Proposed design

Mirror CMT-1570 exactly: carry a new self-reported (adapter-DERIVED) capability signal in the capacity heartbeat, and add a PARALLEL eligibility filter in `PlacementExecutor`.

### The new signal: `MachineCapacity.servesChannels`

**Canonical term (codex-r4 #5):** `workspace-reachable` = "this machine's adapter is connected to the channel's scope" — for Slack, its Socket-Mode adapter is connected to the channel's `team_id`; for Telegram, its adapter polls the channel's `chatId`. This is the ONE term used throughout; "serves" / "can serve" / `yes` all mean exactly `workspace-reachable` (NOT channel-level permission — see the reachability-not-authority section). "channel-authority" (private-channel/bot-membership permission) is the explicitly out-of-scope finer notion.

Each machine self-reports, in its capacity heartbeat (`MachineCapacity`, `src/core/types.ts` — alongside `quotaState`, `guardPosture`, `seamlessnessFlags`):

```
servesChannels?: {
  telegram?: { chatIds: string[] };   // the Telegram supergroup chat id(s) this machine's adapter polls
  slack?: { workspaceIds: string[] };  // the Slack workspace/team id(s) this machine's adapter is connected to
}
```

**ADAPTER-DERIVED, never config-asserted (codex-r5 #1, security):** `servesChannels` is computed at heartbeat time from the LIVE adapter connection state — a Slack `workspaceId` appears ONLY because that machine's Socket-Mode adapter is genuinely connected to that team right now; a connected Telegram adapter contributes its `chatId`. It is NOT read from config. So a `yes` already means "an adapter is really connected" — it is not a bare claim a machine can assert without the connection. A FALSE `yes` therefore requires forging the heartbeat field (an already-compromised, mesh-authenticated peer), not merely a config edit. This is the in-scope corroboration: the signal is grounded in real adapter state. (The FURTHER hardening — a signed/leased capability proven against ingress observation so even a compromised peer can't forge a `yes` that authorizes payload transfer — is the tracked follow-up <!-- tracked: CMT-1568 -->; see Security. Resolved design fork: adapter-derived grounding is IN scope here; cryptographic ingress-corroboration is deferred, residual named.) <!-- tracked: CMT-1568 -->

**Freshness on adapter change (codex-r5 #3 — a live process ≠ a fresh adapter list):** the heartbeat producer MUST recompute `servesChannels` from the CURRENT adapter set on every beat AND clear a workspace id IMMEDIATELY when its adapter disconnects/reconnects (before the next placement-relevant beat) — so a process that stays alive while its Slack adapter drops does not keep advertising a stale `yes`. (`decide()`'s upstream liveness filter handles a dead process; this clause handles a live process with a changed adapter — the gap coarse liveness alone misses.) A machine disabled/disconnected for a platform reports it absent/empty for that platform.

### Extract a testable pure function (Structure > Willpower)

```
machineServesChannel(
  serves: MachineCapacity['servesChannels'] | undefined,
  req: { platform: 'telegram' | 'slack'; chatId?: string; workspaceId?: string },
): 'yes' | 'no' | 'unknown'
```

THREE-valued (not boolean — see the eligibility section): the structural-vs-temporal distinction requires telling "explicitly cannot" (`no`) apart from "don't know" (`unknown`).
- `serves` is `undefined` (an OLDER heartbeat that predates this field) → `'unknown'` (fail-open — an old peer must NOT be filtered out during a rolling deploy).
- `req` carries no channel scope (legacy caller passes no chatId/workspaceId) → `'unknown'` (no-op, fail-open).
- `platform==='telegram'`: `'yes'` iff `serves?.telegram?.chatIds` includes `req.chatId` (shared chat → multiple machines `yes`); else `'no'`.
- `platform==='slack'`: `'yes'` iff `serves?.slack?.workspaceIds` includes `req.workspaceId`; else `'no'`.
- Only a PRESENT signal yields `yes`/`no`; absent/legacy yields `unknown`. (Freshness is handled upstream — see "Freshness source" under Decision points touched: `decide()`'s input is already liveness-filtered, so a present field on a still-live machine is trusted.)

### Ingress model — WHERE the all-`no` case actually comes from (codex-r3 finding #2)

Slack ingress is ADAPTER-LOCAL: each machine runs its own Socket-Mode connection, and Slack delivers an event only to a socket connected to that event's workspace. So a normally-INGESTED Slack message proves SOME machine (the one that received it) serves the workspace — the all-`no` case cannot arise from fresh ingress. The everyday win of this fix is therefore: placement keeps/routes a Slack channel to a machine connected to its workspace — and the INGRESS machine itself always qualifies (it just received the event), so a normal message is served by a machine that can actually serve it instead of being forwarded to a non-serving owner (the exact live-test bug: the Laptop received Mia's message but the resolved owner was the Slack-less Mini). The all-`no`/`unservable` surface is the RARE structural edge — a hard PIN to a non-serving machine, or a transfer whose target doesn't serve the workspace — NOT a normal-ingress state. (If a future Slack ingress is centralized/webhook-based rather than adapter-local, the all-`no` case widens and the unservable surface carries more traffic — noted; the current adapter-local model makes it rare.)

### THREE-VALUED eligibility (cross-model finding #1 — the all-excluded fallback must NOT recreate the black-hole)

The naive "if none can serve, fall through to least-loaded" (CMT-1570's quota pattern) is WRONG here, and the cross-model review caught it: for the motivating Slack case, falling through picks a machine that positively CANNOT reach the workspace → the message black-holes again — the exact bug. The asymmetry from CMT-1570: a quota-blocked machine is *temporarily* unable (it recovers, so placing there and waiting is tolerable); a wrong-workspace machine is *structurally* unable (it will NEVER serve that channel, so placing there is a permanent black-hole). So the fallback must distinguish three states, not two:

For each eligible machine, `machineServesChannel` returns `'yes' | 'no' | 'unknown'`:
- **`unknown`** — the machine's heartbeat lacks `servesChannels` (older peer) OR the field is STALE (see freshness below). Fail-OPEN: treat as eligible (a rolling deploy must not strand old peers).
- **`yes`** — present, fresh, and the channel's platform(+workspace) is in the set.
- **`no`** — present, fresh, and explicitly NOT in the set (structurally cannot serve).

```
const scored = quotaOk.map((m) => ({ m, serve: machineServesChannel(m.servesChannels, req.channel) }));  // no `now` — freshness is upstream (decide() input is already liveness-filtered)
const yes = scored.filter((s) => s.serve === 'yes').map((s) => s.m);
const unknown = scored.filter((s) => s.serve === 'unknown').map((s) => s.m);
// RANK affirmative reachability ABOVE missing data (codex-r4 #2 — the largest practical gap):
// a `yes` machine is preferred over an `unknown` (old/rolling-deploy) peer, so a missing
// signal can never OUTRANK a known-reachable machine by load and recreate the black-hole.
// Fail-open survives: `unknown` is used ONLY when there is no `yes` at all.
const candidates = yes.length > 0 ? yes : unknown;
const allKnownCannotServe = scored.length > 0 && candidates.length === 0;      // every machine said 'no'
```
- **`yes` present** → candidates = the `yes` machines (a known-reachable machine always wins over a missing-signal peer; this is the everyday Slack case — incl. the ingress machine, which is always `yes`).
- **no `yes`, some `unknown`** → candidates = the `unknown` machines (fail-open for a rolling deploy; only when NO machine affirmatively reaches the channel).
- **`allKnownCannotServe`** (every eligible machine POSITIVELY reports it cannot serve this channel) → do NOT silently place on a non-serving machine. Instead:
  - **Telegram** (shared): this should be impossible (every machine on the shared chat reports `yes`); if it happens, it's a real misconfig → place on the local/ingress machine AND flag `no-machine-serves-channel` (loud, observable) — a Telegram black-hole would be a genuine bug worth surfacing, not papering over.
  - **Slack** (per-workspace): a channel whose workspace NO machine serves is structurally unservable. `decide()` returns the EXISTING unsatisfiable contract — `outcome: 'queued'`, `chosenMachine: null`, `reason`/`escalationReason: 'no-machine-serves-channel'` — the SAME shape it already returns for `no-capable-machine`/`hard-pin-unavailable` (implementation reconciliation: the real `decide()` contract already has a `queued`/null outcome for unsatisfiable cases, so this is contract-CONSISTENT, NOT a new variant — and `queued` avoids both the black-hole pick AND a forced placement that can't serve; the consumer's existing escalation handling drives the user-surface). It does NOT fabricate a "local ingress machine" inside the pure `decide()` (which has no ingress concept). The honest user-visible surface (decision-completeness finding G1) is **NOT** a per-message reply on the unreachable channel (it's unreachable by definition) and **NOT** a per-message notice (that would spam — a structurally-unservable channel re-triggers on every inbound). Instead: ONE **deduped Attention-queue item** (`POST /attention`, `id: "placement:unservable:<workspaceId>:<channelId>"` so it coalesces to one item per channel, never per message; if the request carries no `channelId` the binding resolves `unknown` and this all-`no` path is NOT entered — codex-r4 #3), titled "Slack channel not served on any connected machine," body naming the workspace + that no connected machine's Slack adapter is joined to it. This egresses via the dashboard/attention surface (reachable), not the dead channel. **WHICH machine + the "lacks adapter" framing (codex-r4 #1 — split the cases):** for a FRESH adapter-local Slack inbound, the receiving machine is by definition `yes` (it has the socket for that team_id), so all-`no` CANNOT occur — the everyday path never reaches here. all-`no` arises ONLY on a NON-ingress path: a hard PIN or a TRANSFER whose target machine doesn't serve the workspace, OR a stale/bad heartbeat. On that path the machine making the decision genuinely lacks the adapter, emits no channel reply, and the Attention item is the signal. So "local machine lacks a real adapter" is true precisely BECAUSE it's the transfer/pin path, not fresh ingress. NEVER a silent black-hole.
  - **Concrete fallback machine PER CALLER (codex-r5 #2 — "local ingress machine" is underspecified for non-ingress callers):** the ingress caller uses the RECEIVING machine (which is `yes`, so it never actually hits all-`no`). A TRANSFER caller uses the REQUESTER (the machine that initiated the transfer) as the fallback that raises the Attention item. The REBALANCER must NOT fabricate an ingress machine — an all-`no` channel is simply NOT rebalanced (it produces the existing blocked/attention outcome, no move). So no path invents a non-existent "ingress" machine.
- The distinction from "don't strand": we still never DROP a message; but for a STRUCTURALLY-unservable channel we surface an honest unavailable state instead of manufacturing a black-hole by picking a machine we KNOW can't serve it.
- **Hard PIN to a `no` machine — DO NOT mirror `pinned-machine-quota-blocked` (lessons-aware finding #3).** That mirror honors the pin onto the machine anyway (quota is TEMPORARY — the pinned machine recovers, so placing-and-waiting is fine). For a STRUCTURAL `no` (wrong workspace — never recovers), honoring the pin reproduces the exact permanent black-hole this spec exists to kill, contradicting the spec's own thesis. So: a hard pin to a machine that freshly reports `no` for the channel reuses the EXISTING blocked-pin outcome SHAPE at `:169` (codex-r3 #3 — NOT a new return variant: whatever shape the existing quota-blocked-pin path already returns — queue+escalate — tagged `hard-pin-unsatisfiable` instead of `pinned-machine-quota-blocked`). It is NOT placed-and-flagged onto the structural-`no` machine. A pin to an `unknown` (absent/stale) machine IS still honored (fail-open — we don't refuse a pin on a missing signal). The `decide()` return type is unchanged either way (it already returns this blocked-pin shape today).
- **The placement REQUEST must thread the channel context (lessons-aware finding #2 — this is the bulk of the work, not a one-liner).** `PlacementRequest` (`PlacementExecutor.ts:38`) today has NO `channel` field; the fix adds `channel?: { platform: 'telegram'|'slack'; chatId?: string; workspaceId?: string; channelId?: string }` (codex-r3 #1: `channelId` is REQUIRED for the Slack unservable dedupe key, sourced from the inbound Slack event's channel) and threads it from EVERY `decide()` caller — the router, the FAILOVER path (the live-test bug was a failover placement, so this caller MUST pass it), and the rebalancer. A caller that passes nothing → every machine resolves `unknown` → the filter no-ops (fail-open) — which silently disables the fix on that path, so a wiring-integrity test MUST pin that the failover caller threads `channel` (mirroring CMT-1570's "server.ts passes BOTH signals" regression guard). Telegram callers pass the chatId; Slack callers pass the workspaceId.

### Freshness — handled by the EXISTING upstream liveness filter (cross-model finding #2, reconciled with lessons-aware #5)

`servesChannels` is **reachability as of the last fresh heartbeat**, not a real-time guarantee (token expiry / a mid-window disconnect is only reflected when the heartbeat refreshes — bounded by the existing self-correction in Security). It needs NO new staleness machinery: `decide()`'s input is already liveness-filtered upstream (`PlacementExecutor.ts:135` drops offline / clock-suspect machines), so a `servesChannels` field present on a machine `decide()` still sees is from a live peer and is trusted; a peer gone stale is simply absent from `eligible` (not an `unknown` we compute). See "Freshness source" under Decision points touched for the precise reconciliation.

### The signal is workspace-REACHABILITY, not channel-authority (cross-model finding #3 + #4)

`servesChannels` is deliberately a COARSE, first-stage filter: "this machine's adapter is connected to this platform scope (Telegram chat / Slack workspace)." It does NOT prove channel-level permission — Slack private channels, bot non-membership, Slack Connect, app-install scope, or per-channel ACLs can still make a workspace-matching machine unable to serve a SPECIFIC channel. The spec explicitly accepts this as a first-stage routing filter: it eliminates the STRUCTURAL impossibility (wrong workspace entirely — the live-test bug), not every channel-permission case. The field is documented in `types.ts` as reachability hints ("adapter connected to the platform scope, NOT a guarantee of channel permission"); placement treats it as eligibility-narrowing, never as proof. A channel-authoritative signal (`{workspaceId, channelId}` membership) is a possible later refinement, explicitly out of scope here (this fix closes the wrong-workspace black-hole; channel-ACL routing is a separate concern). **The channel-ACL case produces the SAME stall symptom as the false-`yes` security case (codex-r3 #4 + codex-r2 #3): a workspace-matching machine that still can't post (private channel / bot non-membership / Slack Connect).** So ONE unifying follow-up <!-- tracked: CMT-1568 --> covers both: a failed Slack post (any cause) → raise the SAME deduped Attention item + suppress repeated placement attempts for that `(workspaceId, channelId, machineId)` for a cool-off window. This is the failed-placement-FEEDBACK hardening — it closes the false-`yes` DoS loop AND the channel-ACL stall with one mechanism — tracked, NOT in scope here. <!-- tracked: CMT-1568 -->

### Why fail-open is preserved where it matters

The filter can only ever drop a machine that PRESENT-and-FRESH-ly reports `no`. Absent OR stale signal → `unknown` → eligible. The only behavior change from today is: a machine that explicitly, freshly says "I cannot serve this channel" is not placed there. Structurally-unservable channels surface an honest unavailable state instead of a black-hole. This sharpens CMT-1570's discipline: tighten placement only on a TRUSTED negative signal; never strand on a missing/stale one; and never manufacture a known-black-hole in the name of "don't strand."

### Migration — when absent-signal tolerance becomes debt (cross-model finding #5)

Fail-open on absent `servesChannels` is for the rolling-deploy window only. Once every peer in the pool reports the field (observable via `GET /pool` / the capacity census), a persistently-absent signal becomes observable DEBT: log a once-per-machine warning, and (a tracked follow-up <!-- tracked: CMT-1568 -->, NOT this spec) optionally tighten Slack to fail-CLOSED on absent-after-all-peers-upgraded. This spec ships fail-open; the tightening is gated on the fleet-wide rollout completing. <!-- tracked: CMT-1568 -->

## Multi-machine posture

This IS a multi-machine feature. The signal is replicated via the SAME capacity-heartbeat path as `quotaState` (`PeerPresencePuller` allow-list + `MachinePoolRegistry` forward). Single-machine installs: the lone machine always serves its own channels (or fail-open) → no-op. The fix makes the existing "follow the user across machines" guarantee correct for per-machine-scoped channels (Slack workspaces), and a no-op for shared channels (Telegram).

## Security — a POSITIVE self-reported capability is a different trust posture than CMT-1570 (lessons-aware finding #1)

CMT-1570's `quotaState` is SELF-INCRIMINATING: a machine reports its OWN unavailability, so a lying peer can only deny ITSELF work (the fail-safe direction). `servesChannels` is the OPPOSITE — a machine asserts a POSITIVE capability to serve someone else's channel. The asymmetry must be named:
- **Trust boundary (same as today):** `servesChannels` rides the SAME authenticated mesh-heartbeat path as `quotaState`/`loadAvg`/`guardPosture`. Forging it requires an already-compromised, mesh-authenticated peer — identical blast radius to forging any existing capacity field. This fix does NOT widen the trust boundary; every heartbeat field is already self-reported over that authenticated channel.
- **Consequence is an OBSERVABLE FAILED SESSION, not automatic correction (codex-r2 finding #3 — precise framing):** a peer that falsely claims `slack.workspaceIds:["W-victim"]` becomes `yes`-eligible and can win placement of that workspace's channels — but it STILL isn't connected to W-victim, so the placed session cannot post and dies/stalls. This is an OBSERVABLE failure (session-death notice), NOT an automatic self-correction: if the malicious peer keeps reporting `yes`, placement has no evidence that zero machines serve the workspace, so it does NOT reach the `no-machine-serves-workspace` honest-unavailable surface — the failure can REPEAT indefinitely (a denial-of-service on that workspace's channels). Closing that loop (a failed-placement → exclude-this-machine-for-this-workspace feedback, or a signed/corroborated membership assertion so a bare `yes` isn't trusted alone) is the security-hardening follow-up <!-- tracked: CMT-1568 --> — explicitly OUT of scope here, residual named + accepted. <!-- tracked: CMT-1568 -->
- **DATA EXPOSURE, not just denial — and it IS an exposure INCREASE, not "same blast radius" (codex-r4 #4 corrects my earlier overclaim):** a false `yes` that wins placement hands the chosen (malicious) machine the routed session context — the inbound user message + conversation context — BEFORE it fails to post. The honest accounting: today, a machine only receives the payloads for channels IT OWNS; the mesh does NOT replicate every channel's message content to every peer (only owned-channel sessions get the payload). So a false `yes` lets a compromised peer OWN — and thus RECEIVE — a victim workspace's channel payloads that it would NOT otherwise see. That is a genuine exposure INCREASE over a compromised-but-honest peer, NOT merely "one more vector within the same blast radius." I will not soften this. It still requires an already-compromised, mesh-AUTHENTICATED peer (the trust BOUNDARY is unchanged — forging `servesChannels` is no easier than forging any heartbeat field), but the CONSEQUENCE of that compromise is widened by this feature, so the corroboration mitigation is not optional polish — it is the right fix. **Recommended mitigation, elevated (codex-r4 #4):** for Slack, trust a `yes` for a FIRST placement only when corroborated by an ingress observation (the machine actually received an event for that workspace) rather than by self-report alone — closing the exposure at the source. This is the security-hardening follow-up <!-- tracked: CMT-1568 -->; until it lands, the residual (a compromised authenticated peer can receive a victim workspace's payloads via a false `yes`) is named and accepted as a known, tracked exposure — NOT dismissed. <!-- tracked: CMT-1568 -->
- A false `no` (a peer dropping a workspace it really serves) can only DENY placement to itself for that workspace → degrades to the unservable/least-loaded path; same fail-safe direction as CMT-1570.

## Decision points touched

Placement eligibility (a routing decision). The `yes`/`unknown` narrowing is a pure SIGNAL fed into the existing placement authority (`PlacementExecutor`) — same posture as CMT-1570's quota signal; it never blocks a message. The one NON-signal element — the Slack `allKnownCannotServe → unservable` result (lessons-aware finding #4) — is a deterministic REFUSAL to place, which per `docs/signal-vs-authority.md` is acceptable ONLY as a **structural validator** (the "no machine is connected to this workspace" carve-out: an enumerable structural fact, not a judgment call), NOT as brittle blocking authority. It is anchored there explicitly: it refuses only on the objective, enumerable fact that zero connected machines serve the workspace, and surfaces an honest unavailable state — it is not a fuzzy gate.

### Freshness source (lessons-aware finding #5)
`decide()`'s input is ALREADY liveness-filtered upstream (`PlacementExecutor.ts:135` excludes offline / clock-suspect machines via the registry). So the per-channel check does NOT need separate staleness machinery: a `servesChannels` field present on a machine the registry already deemed live is trusted; the "stale → unknown" case reduces to "the registry dropped the machine entirely" (it's not in `eligible`). If a finer per-field heartbeat age is ever needed, it must be a named field on `MachineCapacity` passed into `machineServesChannel` — but this spec relies on the existing upstream liveness filter and adds no new staleness field (avoiding redundant machinery).

## Frontloaded Decisions

1. **Fail-open on absent/stale signal** (vs fail-closed): chosen — matches CMT-1570; a rolling deploy must not strand old peers. (`unknown` is eligible.)
2. **All-excluded behavior** (decision-completeness G3 + the implementation reconciliation): when every quota-ok candidate is a structural `no`, `decide()` returns the EXISTING unsatisfiable contract `outcome:'queued'` / `escalationReason:'no-machine-serves-channel'` (the same shape as `no-capable-machine`) — NOT a black-hole pick. This is uniform across Telegram and Slack (Telegram all-`no` should never happen since the chat is shared; if it does it's a real misconfig the same `queued`/escalation surfaces). The principle is "never DROP a message AND never manufacture a placement onto a machine that can't serve" — the consumer raises the deduped Attention item (#4) on the escalation. (Earlier wording said "place on the local/ingress machine"; reconciled to `queued` because the pure `decide()` has no ingress concept and the real contract already uses `queued` for unsatisfiable.)
3. **Signal granularity** = chatId set (telegram) + workspaceId set (slack), NOT a bare boolean — because Slack is per-workspace and a machine may serve some workspaces and not others. (Three-valued `yes`/`no`/`unknown` return, not boolean — to tell structural `no` from `unknown`.)
4. **The unservable user-visible surface** (decision-completeness finding G1 — a published interface, frontloaded not cheap): when the placement CONSUMER receives `outcome:'queued'` with `escalationReason:'no-machine-serves-channel'`, it raises ONE **deduped** Attention item (`id: placement:unservable:<workspaceId>:<channelId>` → coalesces per channel, NEVER per message), wording "Slack channel not served on any connected machine" + the workspace id. Egress = the dashboard/attention surface (reachable), NOT the dead channel, NOT a per-message notice. The `decide()` contract is UNCHANGED (G2): `queued`/null is its EXISTING unsatisfiable outcome (no new refusal variant); consumers that already handle `queued`/escalation handle this one too.
5. **`hard-pin` to a structural-`no` machine** → honest `hard-pin-unsatisfiable` (queue+escalate like the existing blocked-pin path), NOT honored-and-flagged (which would recreate the black-hole). Pin to `unknown` → still honored (fail-open).
6. **Migration-debt tightening + security-hardening** → explicitly NOT this spec; tracked follow-ups <!-- tracked: CMT-1568 --> (the residual is named + accepted). <!-- tracked: CMT-1568 -->

## Testing (updated to the three-valued + platform-specific design — codex-r2 #1)

- Unit (pure fn `machineServesChannel` → `yes`/`no`/`unknown`): telegram shared-chat → multiple machines `yes`; slack workspace match → `yes`, non-match → `no`; absent `servesChannels` → `unknown`; legacy request (no channel scope) → `unknown`.
- Unit (PlacementExecutor): a present-`no` machine is dropped from candidates; an `unknown` machine stays eligible (fail-open). **Telegram** all-`no` (misconfig) → places local + `no-machine-serves-channel` flag. **Slack** all-`no` → returns the local-ingress machine (contract unchanged) + `no-machine-serves-workspace` flag + raises the deduped Attention item (asserted ONCE per `(workspace,channel)` across repeated inbound, NOT per message). Hard-pin to a present-`no` machine → `hard-pin-unsatisfiable` (queue+escalate), NOT honored-and-flagged. Hard-pin to an `unknown` machine → honored.
- Wiring-integrity: `servesChannels` survives the PeerPresencePuller forward + MachinePoolRegistry round-trip (like quotaState); AND the FAILOVER `decide()` caller threads `channel` (the live-test bug was a failover placement — a test that the failover path passes channel context, mirroring CMT-1570's both-signals guard).
- 3-tier: the placement route reflects the filter; e2e that a Slack channel is never PLACED-AND-SERVED on a machine whose workspace set excludes it; e2e that the deduped Attention item fires once for an all-`no` Slack channel.

### Workspace-id sourcing (codex-r2 finding #5)
The Slack `workspaceId` in the placement request is sourced authoritatively from the **inbound Slack event's `team_id`** (the same value the SlackAdapter already keys the session on), captured at ingress and threaded into the placement request — NOT inferred. Edge cases: a Slack event lacking team context, a Slack Connect (shared) channel whose `team_id` is ambiguous, or a renamed/reinstalled team → the request's `workspaceId` is absent/unrecognized → every machine resolves `unknown` → fail-open (no exclusion), the safe direction (we never refuse on an id we can't trust). A renamed team keeps its `team_id` (Slack ids are stable across renames); an app reinstall that changes the id is covered by fail-open until heartbeats catch up. Tests cover missing-`team_id` and unrecognized-`workspaceId` → fail-open.

## Considered alternatives (codex-r2 finding #6)

A **central adapter/capability registry** (a single authority deriving each machine's reachable channels from its live adapter connections, rather than self-report) would reduce trust in positive self-assertions (closing the false-`yes` vector at the source). Rejected for THIS fix because: (a) it introduces a new central component + its own availability/consistency failure mode on the routing hot path, (b) it diverges from the established CMT-1570 pattern (self-reported capacity heartbeat) that the rest of placement already uses — consistency beats a bespoke mechanism here, and (c) the self-report's residual (a compromised authenticated peer) is the SAME trust boundary the whole mesh already assumes. A corroborated/signed membership assertion (the middle ground — keep self-report but require the OWNING machine to corroborate before trusting a `yes` for sensitive payloads) is the named security-hardening follow-up <!-- tracked: CMT-1568 -->, not a wholesale registry. **Specifically (codex-r5 #5): a short-lived workspace capability LEASE** — a `yes` is issued/renewed only after an OBSERVED adapter ingress event (or a successful Slack API auth check) for that workspace, and expires — so a bare positive heartbeat claim never authorizes payload transfer on its own. This is the preferred hardening shape (decentralized, no central registry, but not a bare self-assertion); deferred <!-- tracked: CMT-1568 --> to the tracked follow-up <!-- tracked: CMT-1568 --> because the in-scope adapter-derived grounding already closes the config-assertion case and the lease adds real machinery best specced on its own. <!-- tracked: CMT-1568 -->

## Open questions

*(none)*
