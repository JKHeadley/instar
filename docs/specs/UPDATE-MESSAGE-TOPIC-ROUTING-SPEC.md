# Update-Message Topic Routing Spec

approved: false
status: draft
owner: echo
related: docs/specs/auto-updater-lifeline-coordination.md, docs/specs/GRACEFUL_UPDATES.md

## Problem

Update-class messages — "applying update," "just updated," "lifeline behind server," post-restart confirmations, ship-narration — land in arbitrary topics instead of the dedicated **Agent Updates** topic. Users see release chatter buried in unrelated conversations and miss when an update actually applied. Justin reported this on 2026-05-27 with a screenshot of two update-narration messages landing in a Case Study topic.

There is no single bug. Three emitters each pick a topic differently. Two of them pick the wrong one.

## Root Cause (three independent paths)

### Path 1 — Lifeline version-skew alert (wrong topic; real bug)

When a forwarded Telegram message receives HTTP 426 from the server (`upgradeRequired: true`, lifeline behind server version), `TelegramLifeline.handleVersionSkew()` sends the "Heads up: my server auto-updated to vN but my lifeline is still on vM…" alert to the topic the inbound forward came from. The topic is whichever one the user happened to be typing in. The Updates topic is never consulted.

### Path 2 — Foreground restart-watcher "applying update" → Attention topic, not Updates (real bug)

When the `ForegroundRestartWatcher` detects a restart-requested flag and there are active sessions, the `onRestartDetected` callback in `commands/server.ts` calls the central `notify('IMMEDIATE', 'system', "Applying update to vN — restarting now…")`. The central `notify()` function defaults the topic to `agent-attention-topic` when no explicit topic is passed, and the caller passes none. So this update-class message lands in **Attention**, not **Updates**.

Every other update-class emitter routes correctly:
- `AutoUpdater.notify()` resolves `agent-updates-topic` (file: `core/AutoUpdater.ts`).
- `AutoDispatcher.notify()` resolves `agent-updates-topic` (file: `core/AutoDispatcher.ts`).
- The restart-handshake verified/failed messages resolve `agent-updates-topic` (file: `commands/server.ts`).
- The `/telegram/post-update` HTTP endpoint resolves `agent-updates-topic` (file: `server/routes.ts`).

Only this one path slipped through.

### Path 3 — Agent self-narration about ships/restarts (structural gap; not a code bug)

When an agent authors a conversational message like "Quick heads-up: shipped X" or "Back up and confirmed — now running vN," it sends to whatever topic the session is bound to. Today, **no CLAUDE.md template guidance** teaches the agent that update/ship-class self-broadcasts should route through `/telegram/post-update` rather than the active session topic. The structural fix is template guidance + Agent Awareness Standard compliance, not new code.

## Fix Plan

### Fix 1 — Lifeline version-skew alert routes to Updates topic

`TelegramLifeline.handleVersionSkew()` resolves the Updates topic ID from `<stateDir>/state/agent-updates-topic.json` (StateManager read, identical to AutoUpdater) and sends the alert there. If `agent-updates-topic` is not set, fall back to `lifelineTopicId` — version-skew is itself a delivery health problem, and Lifeline is the guaranteed-reachable topic for delivery-health alerts. Document the fallback choice inline.

The `topicId` parameter to `handleVersionSkew()` is no longer used as the destination — it stays in the signature for callers' diagnostics/logging, but the alert destination is resolved internally.

### Fix 2 — Foreground restart-watcher passes explicit Updates topic

`onRestartDetected` in `commands/server.ts` reads `state.get<number>('agent-updates-topic')` and passes it as the explicit `topicId` argument to `notify()`. When the Updates topic is unset, the call falls through to the central default (Attention) — same behavior as before, so no regression for agents missing the Updates topic. The explicit argument is the routing fix.

### Fix 3 — Template guidance for agent self-broadcast

Add a short section to the CLAUDE.md template (`src/scaffold/templates.ts`) under Capabilities — explaining that update/ship/restart self-broadcasts must route via `POST /telegram/post-update` so they land in Updates instead of the active session topic. Add an entry to the Proactive Triggers list: "About to self-broadcast a ship, restart, or update narration → use `/telegram/post-update`, do not author in the active session topic."

Add a corresponding migration in `PostUpdateMigrator.migrateClaudeMd()` that injects the section into existing agents' CLAUDE.md when absent. Content-sniffing guard ensures idempotency.

## Migration Parity

| Change | New agents (via `init`) | Existing agents (via update) |
| --- | --- | --- |
| Fix 1 (lifeline code) | Picked up on dist refresh | Picked up on dist refresh |
| Fix 2 (server code) | Picked up on dist refresh | Picked up on dist refresh |
| Fix 3 (CLAUDE.md template) | Picked up via `init` | Picked up via `migrateClaudeMd` extension |

Migration is required only for Fix 3 (per the Migration Parity Standard's CLAUDE.md rule).

## Tests (per Testing Integrity Standard)

### Unit (Tier 1)

1. **Lifeline version-skew → Updates topic**
   Given a StateManager with `agent-updates-topic` set to T_UPDATES, a forwarded message on topic T_INBOUND, and a 426 response: `handleVersionSkew` calls `sendToTopic(T_UPDATES, ...)` exactly once. Never `sendToTopic(T_INBOUND, ...)`.

2. **Lifeline version-skew → lifeline-topic fallback**
   Given no `agent-updates-topic`, `handleVersionSkew` calls `sendToTopic(this.lifelineTopicId, ...)`. Never the inbound topic.

3. **Lifeline version-skew → dedupe survives the routing change**
   The 24-hour `versionSkewAlertSentAt` dedupe behavior is unchanged when the alert is routed to Updates.

4. **Restart-watcher notify → explicit Updates topic when set**
   Given `agent-updates-topic` set to T_UPDATES, `onRestartDetected` calls `notify('IMMEDIATE', 'system', message, T_UPDATES)`. The fourth argument is explicit and equal to T_UPDATES.

5. **Restart-watcher notify → falls back to default (Attention) when Updates unset**
   Given no `agent-updates-topic`, `onRestartDetected` calls `notify` with `topicId = undefined`. Central notify's existing Attention default applies (no regression).

6. **Migration — CLAUDE.md self-broadcast guidance**
   Given an existing CLAUDE.md missing the new section, `migrateClaudeMd` adds it. Given CLAUDE.md already containing the section, the migration is a no-op. Idempotent across multiple runs.

### Integration (Tier 2)

7. **End-to-end version-skew via real lifeline + real server**
   Spin a TelegramLifeline against a fake Telegram API. Set `agent-updates-topic` in state. Inject a 426 forward response. Assert exactly one outbound `sendMessage` to T_UPDATES, none to the inbound topic.

### E2E (Tier 3)

8. **Feature-alive: lifeline correctly routes version-skew alert under a real `commands/server.ts` server bootstrap**
   Boot via the production initialization path, force a 426, assert the alert arrives on Updates.

## Non-Goals

- Reworking the central `notify()` default to use Updates instead of Attention for the `system` category. That is a wider behavior change; this spec only routes update-class messages explicitly.
- Restructuring how `agent-updates-topic` is provisioned (already ensured at server startup; unchanged).
- Programmatic enforcement that agents use `/telegram/post-update` for self-broadcasts (a hook gate is the Structure-over-Willpower move, but is out of scope here — this spec ships template guidance only and tracks a follow-up).

## Follow-Ups (tracked, not implemented in this PR)

- **F1**: Programmatic gate that detects agent-authored update/ship narration via a PreToolUse hook on the Telegram relay script and redirects to `/telegram/post-update`. Structural enforcement of Fix 3.
- **F2**: Audit `notify('IMMEDIATE', 'system', …)` callsites in `commands/server.ts` for any other update-class messages that should route to Updates rather than Attention.

## Risk

- Low. Each fix changes routing only; no contract change to telegram API, no schema migration, no rolling restart needed for existing agents (lifeline picks up new behavior on next restart, which is part of the post-update flow anyway).
- The lifeline change preserves an emergency-channel fallback (Lifeline topic) so a misconfigured Updates topic can never *prevent* the alert from being seen.

## Acceptance Criteria

- All eight test scenarios above pass.
- A live test on Echo: simulate a 426 by patching the lifeline temporarily, send a message in topic 14668, observe the alert arriving in Updates (not 14668).
- Run `instar migrate` against an existing agent home and verify the CLAUDE.md section is injected once, idempotent on a second run.
