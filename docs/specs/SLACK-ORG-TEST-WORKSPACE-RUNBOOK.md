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
   Slack user IDs in `authorizedUserIds`, and the gate in observe-only:
   ```json
   {
     "type": "slack", "enabled": true,
     "config": {
       "botToken": "xoxb-…", "appToken": "xapp-…",
       "workspaceMode": "shared",
       "authorizedUserIds": ["U_OWNER","U_ADMIN","U_MEMBER","U_CONTRIB"],
       "permissionGate": { "observeOnly": true }
     }
   }
   ```
   `observeOnly: true` means the gate **logs** every verdict and **blocks nothing** —
   the safe default for a demo. (`enforce: true` is a later phase, gated on a good
   observed false-positive rate; do NOT set it for the first demo.)
2. Seed the cast's roles in `users.json` (until the Phase-1 conversational registration
   UX exists): one `UserProfile` per cast member with `slackUserId` + `orgRole`
   (`owner`/`admin`/`member`/`contributor`). The outsider is simply **not** registered.
3. Restart the agent's server so the Slack adapter picks up the config (a running
   session keeps the config it was spawned with).

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
