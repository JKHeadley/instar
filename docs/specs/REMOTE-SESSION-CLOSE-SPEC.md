---
title: "Remote Session Close — close any machine's session from the one dashboard"
slug: "remote-session-close"
author: "echo"
eli16-overview: "REMOTE-SESSION-CLOSE-SPEC.eli16.md"
status: "draft"
layer: "core-instar-primitive"
parent-principle: "One coherent being — the single dashboard manages every machine's sessions; a close button that only works locally is a seam the user can feel"
project: "multimachine-coherence"
origin: "Justin, topic 13481, 2026-06-11 16:37: 'Why can't I close out a mac mini session from the dashboard like I can the laptop sessions?' — the × button is deliberately hidden on remote tiles because closeSession only knows the local DELETE endpoint (dashboard/index.html:4026)"
supervision: "tier0 — deterministic relay of an operator-initiated close; every authority check runs on the owning machine, exactly as for a local close"
---

# Remote Session Close — close any machine's session from the one dashboard

## 1. Problem

The dashboard's session close button (×) calls the LOCAL `DELETE /sessions/:id`, so remote tiles deliberately hide it (`dashboard/index.html:4026`) — better no button than a button that can't work. Now that click-to-stream works cross-machine (POOL-DASHBOARD-STREAM-SPEC, shipped), close is the visible missing half of "one dashboard manages everything": the operator can watch a Mac Mini session from the laptop but must not be able to… stop watching it being stuck. Lived 2026-06-11: cleaning five stale Mini sessions required hand-issued curl calls against the Mini's tunnel URL.

## 2. Design

### 2.1 Relay route: `DELETE /sessions/:id?machineId=<peer>` (Bearer-auth)

When `machineId` names ANOTHER machine, the local server relays the close to that peer's existing `DELETE /sessions/:id` over the peer's registered URL with Bearer auth — the exact transport + auth the `GET /sessions?scope=pool` fan-out and today's manual cleanup already use. The peer's response (status + body) is passed through verbatim. No `machineId`, or `machineId` == self → today's local path, byte-for-byte unchanged.

**No new authority is created.** The peer's DELETE endpoint already exists, already accepts the same shared Bearer token, and already runs the full keep-guard chain on its own machine (protected sessions, in-flight guards, KEEP-holds all refuse there — the owning machine remains the sole authority over its sessions; the relay is a courier, not a decider). This feature only lets the dashboard reach a door that is already there and already locked correctly.

### 2.2 Dashboard: show × on remote tiles

`dashboard/index.html`: remote tiles render the same × button, wired to `closeSession(tmuxSession, name, machineId)`; the fetch adds `?machineId=`. Refusals surface verbatim in the existing toast (e.g. "protected session" from the owning machine), and an unreachable peer surfaces "machine unreachable — try from that machine" rather than a silent failure. The existing local confirm() dialog applies identically.

### 2.3 Failure honesty

- Peer down/timeout (5s, the fan-out standard): toast "Mac Mini is unreachable", HTTP 502 from the relay with `{error, machineId}` — never a hang, never a fake success.
- Peer refusal (403/409 from its guard chain): passed through with the peer's reason — the dashboard says WHY the owning machine said no.
- The reap-log on the OWNING machine records the close with origin metadata (`origin: 'remote-dashboard-relay'` carried via a header the peer's route already... if the existing route lacks an origin field, the relay adds `X-Instar-Close-Origin: remote-dashboard` and the route records it when present, additively) — a session must never disappear without a trace naming where the order came from.

### 2.4 What this is NOT

- NOT a new kill authority: every safety check runs on the owning machine, unchanged.
- NOT machine-to-machine autonomy: the trigger is always a human clicking × in a PIN-authed dashboard (or an agent calling the Bearer-authed API it could already call peer-directly).
- NOT input forwarding: unrelated to `allowRemoteInput`; closing is not typing, and reuses none of that path.

## 3. Testing (Testing Integrity Standard — all three tiers)

- Tier 1: relay decision (machineId absent/self → local; other → relay), passthrough of peer status/body, timeout → 502 with machineId, origin header attach.
- Tier 2: route integration with a mocked peer — successful relay, peer 403 passthrough, peer timeout; local path regression (no machineId behaves exactly as today).
- Tier 3: "feature is alive" E2E — relay route responds on the production init path (404 for an unknown peer machineId, never 503).
- Dashboard: source-assert test (established at-rest pattern) — remote tiles render the × with machineId wiring; the local-only hide is gone.

## 4. Rollback

Revert and ship a patch: the relay route disappears, the dashboard × on remote tiles fails its fetch with 404 → toast error (degraded to pre-feature behavior, not broken). No state, no migration.

## 5. Acceptance criteria

1. From the laptop dashboard, × on a Mac Mini session closes it (live-verified on the real machines) and the Mini's reap-log records the close with the remote-dashboard origin.
2. × on a PROTECTED Mini session surfaces the Mini's refusal reason in the toast and closes nothing.
3. × with the Mini offline surfaces "unreachable" within 5s and closes nothing.
4. Local close behavior is byte-for-byte unchanged.
