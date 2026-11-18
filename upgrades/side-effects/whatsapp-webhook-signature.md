# Side effects: WhatsApp Business webhook signature (SEC-086)

## What changes for running agents
- Agents on the WhatsApp Business API backend without `businessApi.appSecret` stop accepting inbound WhatsApp Business messages (503) after this update. This is deliberate fail-closed behaviour: the previous behaviour accepted forged messages from any number. Startup logs a plain warning; the awareness entry tells the agent to ask the owner for the App Secret via Secret Drop. Meta retries refused deliveries for a while, so messages sent shortly before the secret is set may still arrive.
- Baileys (WhatsApp Web) agents: no change. Agents without WhatsApp: no change.
- Outbound sending is unchanged.

## Signal vs authority
The signature is the authority for "this delivery came from Meta"; nothing downstream (authorized-number checks) can establish that, because the sender number is inside the forged body.

## Raw body
The check needs the exact request bytes. AgentServer's global JSON parser already keeps `req.rawBody` (keepRawBody) and is registered before the webhook routes are mounted. If a future change mounts the webhook before that parser, every delivery fails closed (401), never open.

## Rollback
Revert the commit. No stored data changes; the new config key is optional and ignored by older builds.

## Not covered here
Meta's signature has no timestamp and deliveries are not de-duplicated by message id, so a captured signed delivery could be replayed. That needs a TLS capture of a real delivery and predates this change; tracked as a follow-up.
The access token and verify token still live in the config file as before; moving them to the secret store is separate work.

**Reviewer:** independent second-pass subagent (fresh context, read-only) — CONCUR. Confirmed the raw-body parser runs before the route, the HMAC compare is constant-time with no header/body bypass, and no other unauthenticated path reaches handleWebhook. Nits addressed (test-count wording, template line, replay noted).
