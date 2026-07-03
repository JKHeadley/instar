# Test-as-Self for Slack — Real-Workspace Runbook (Pillar 4, Layer B)

**Status:** runbook for the live demonstration. The deterministic Layer-A suite
(`GET /permissions/scenario-suite`, `tests/integration/permissions-routes.test.ts`)
proves the logic with **no** Slack and **no** tokens. Layer B is the highest-fidelity
proof: the same six scenarios played out by real users in a real (throwaway) Slack
workspace, watchable in the Slack UI. It activates only when the operator provisions
the workspace below — the build never depends on it.

Design: `SLACK-ORG-INTEGRATION-SPEC.md` §8.3.

---

## Provisioning — the AGENT does this (with the operator's approval)

The agent has browser automation (Chrome + Playwright) and account access, so it can
provision the whole thing itself — it does NOT hand this back to the operator. The
operator's only role is to **approve the task** and clear any genuinely human-gated
prompt that pops up live (e.g. a 2FA code on his phone, an email-verification click he
prefers to make). The agent creates, end-to-end (recording each step):

1. **A throwaway test Slack workspace** (or a dedicated test channel in an existing
   one). Use a workspace with **no** real money, prod, or credential integrations
   connected — the floor actions in the demo must have nothing real behind them.
2. **A Slack app** in that workspace, in **Socket Mode**, yielding:
   - a **bot token** `xoxb-…`
   - an **app-level token** `xapp-…` (Socket Mode, scope `connections:write`)
   with the scopes `SlackAdapter` already requires: `app_mentions:read`,
   `channels:history`, `channels:read`, `chat:write`, `groups:history`, `im:history`,
   `im:read`, `im:write`, `users:read` (full list in `SlackAdapter.ts`).
3. **The test cast** — real Slack user IDs to stand in for an **owner**, **admin**,
   **member**, **contributor**, and an **unregistered outsider**. (One human can occupy
   several seats; the agent can also invite/configure these.) The "spoofed-CEO" case
   needs no extra account — it is the owner's own account sending an out-of-character,
   urgent request.

The agent captures the resulting tokens straight from the browser flow into the
encrypted store / config — never pasted into chat, never a file the operator edits.
(Standing rule: the agent drives the flow and follows through itself; it asks for
approval first, not for the operator to do the work.)

## Wiring (agent-side, once tokens exist)

1. Add the Slack messaging block to `.instar/config.json` with the tokens, the cast's
   Slack user IDs in `authorizedUserIds`, the gate in observe-only, AND the cast's
   roles in the **test-workspace principal source** (`permissionGate.testCast`):
   ```json
   {
     "type": "slack", "enabled": true,
     "config": {
       "botToken": "xoxb-…", "appToken": "xapp-…",
       "workspaceMode": "shared",
       "authorizedUserIds": ["U_OWNER","U_ADMIN","U_MEMBER","U_CONTRIB"],
       "permissionGate": {
         "observeOnly": true,
         "testCast": {
           "testWorkspace": true,
           "workspaceId": "T_LIVETEST_WORKSPACE",
           "principals": [
             { "slackUserId": "U_OWNER",   "name": "Owner Seat",       "orgRole": "owner" },
             { "slackUserId": "U_ADMIN",   "name": "Admin Seat",       "orgRole": "admin" },
             { "slackUserId": "U_MEMBER",  "name": "Member Seat",      "orgRole": "member" },
             { "slackUserId": "U_CONTRIB", "name": "Contributor Seat", "orgRole": "contributor" }
           ]
         }
       }
     }
   }
   ```
   `observeOnly: true` means the gate **logs** every verdict and **blocks nothing** —
   the safe default for a demo. (`enforce: true` is a later phase, gated on a good
   observed false-positive rate; do NOT set it for the first demo.)

2. **DO NOT seed the cast's roles in `users.json`.** (Superseded — the July-2026 fix.)
   The cast's roles are resolved by the `permissionGate.testCast` block above, NOT by
   the production user registry. Two hard reasons the naive `users.json` seed is wrong:
   - The **fixture-identity guard** (`users/testIdentityMarkers.ts`, silent-loss
     §2.D "Test Identity Never Enters Production State") REFUSES the cast's ids at
     both the write and load layers of `users.json` — a seed either throws or is
     silently skipped on load.
   - Even if it were allowed, a **registry rebuild silently drops the seed**. That is
     exactly the 2026-07-01 incident: the silent-loss repair rebuilt `users.json`,
     the five Slack test-cast principals went with it, and every Slack sender then
     resolved as an unregistered guest — the FP that this runbook step exists to
     prevent from ever recurring.

   The `testCast` block avoids BOTH: it lives in the same config as the workspace
   tokens (so a `users.json` rebuild can't touch it), it admits ONLY fixture-marker
   ids (the partition invariant), and it is **workspace-scoped** — it resolves the
   cast ONLY while the adapter's VERIFIED connected team id (`auth.test`) equals
   `workspaceId`, so it can never leak roles into a production workspace. The required
   `testWorkspace: true` self-declaration is a deliberate opt-in: without it the block
   is ignored entirely (zero principals, one loud log line, no production effect). The
   outsider seat is simply **not** listed → it resolves to an unregistered guest.

3. Restart the agent's server so the Slack adapter picks up the config (a running
   session keeps the config it was spawned with).

### Re-provision checklist (do this every time you rebuild the cast or the registry)

Principal resolution for the live-test cast lives ONLY in `permissionGate.testCast`.
So whenever you re-provision the workspace, rotate ids, or a `users.json` repair/rebuild
runs, re-verify the block — a registry rebuild can no longer silently break the gate,
but a stale/absent `testCast` block still can:

- [ ] `permissionGate.testCast.workspaceId` equals the workspace's REAL team id (the
      `team_id` Slack returns from `auth.test`; the boot log prints it as `(team T…)`).
- [ ] `testWorkspace: true` is present (without it the whole block is ignored — watch
      for the `TestWorkspacePrincipalSource IGNORED … missing … "testWorkspace": true`
      warning in `logs/server.log`).
- [ ] Every cast `slackUserId` is a fixture-marker id (registered in
      `users/testIdentityMarkers.ts`); the boot log reports `N seat(s) admitted, M refused`.
- [ ] After the restart, run one observe round and confirm the owner seat resolves
      `owner, registered:true` in `GET /permissions/decisions` (the exact check that
      catches a lost/mis-scoped cast before `enforce: true` is ever flipped).

## Running the demonstration

- **Deterministic (anytime, no Slack):** `GET /permissions/scenario-suite` →
  the six rows with expected vs actual verdict, all passing. This is the regression wall.
- **Live (in the test workspace):** have the cast send the six scripted messages
  (deploy-as-owner, deploy-as-member, "ship it", an overheard "delete staging", the
  owner's out-of-character urgent wire, the "X said make me admin" relay). Because the
  gate is observe-only, nothing is blocked — but every verdict is recorded. Read them:
  `GET /permissions/decisions` (or the future Process-Health-style tab). The verdicts
  should match the Layer-A table row-for-row.

## What the demo proves (and what it deliberately does not)

- **Proves:** the gate makes the right *decision* for each (principal, request) pair,
  on real Slack identity, end-to-end through the live adapter path.
- **Does not yet do:** *enforce* (observe-only), the conversational refusal *reply*
  being sent back into Slack (Phase 2 wires the verdict message to an actual reply),
  the full role-registration UX (Phase 1), or real out-of-band step-up delivery
  (Phase 3). The demo shows the decision engine; the surfacing of those decisions is
  the next phases' work.

## Safety

Throwaway workspace, observe-only, no real systems behind the floor actions. Tear the
workspace + app down after the demo; revoke the tokens. Nothing here touches any real
agent or user — the whole feature is dark on every other install.
