# Side effects: WhatsApp Business webhook signature (SEC-086)

## What changes for running agents
- Agents on the WhatsApp Business API backend WITH `businessApi.appSecret`: an unsigned or wrongly signed delivery is refused (401) and never processed.
- Agents on the WhatsApp Business API backend WITHOUT `businessApi.appSecret`: observe mode, per the approved identity umbrella (docs/specs/identity-security-levels.md section 10: enforcement that is not known-invalid starts by observing). Deliveries keep arriving exactly as before; startup and the first delivery log that they are unverified, and the owner gets ONE plain notice (Telegram owner DM; once ever per machine, kept by `state/whatsapp-unverified-notice.json`, written only after the send is confirmed, so an owner with no reachable channel is retried after the next restart and the log says so) that WhatsApp Business deliveries are unverified until the App Secret is set. No agent loses inbound WhatsApp on update.
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

## Second-pass review

**Reviewer:** independent second-pass subagent (fresh context, read-only) — CONCUR. Confirmed the raw-body parser runs before the route, the HMAC compare is constant-time with no header/body bypass, and no other unauthenticated path reaches handleWebhook. Nits addressed (test-count wording, template line, replay noted).

## Local Verify follow-on (2026-11-18 00:50 PST, M5)

Local Verify at 23:15 failed on `tests/e2e/business-api-e2e.test.ts`: its route-level POST test sent an unsigned delivery, which this change now correctly refuses. The test now configures an app secret and signs the delivery the way Meta does (HMAC-SHA256 of the raw body in `X-Hub-Signature-256`). A new case in the same file proves an unsigned or wrongly signed POST gets 401 and never reaches the adapter. Test-only; no runtime code changed. The file passes on its own (27 tests).

**Reviewer:** independent read-only subagent (fresh context) — CONCUR on the test follow-on: nothing in src/ changed, the production check runs unmocked, the signing matches what the route reads, and the negative case would fail if the check were removed. Its nit (the 503 no-secret branch is untested in this file) is covered by the unit route tests.

## Observe-mode amendment (2026-11-18, M5)

Chief of Staff decision under the identity umbrella section 10: no secret set now means deliver and tell the owner once, not refuse all (503). Secret set + missing or bad signature is still refused (401), unchanged. A notice failure never blocks a delivery (the hook is wrapped and only starts async work, so it never delays the 200). The marker is written only after a confirmed send; on a multi-machine agent "once" means once per machine. Follow-on owned by the identity build (piece 1i, after this merges): appSecret as a synced secret field, store re-read before refusing, wrong-secret/forgery owner notice, condition notices. Not duplicated here.

**Second-pass review of the amendment (round 1):** independent read-only subagent (fresh context, agent id add21927c6c9a748f), OBJECT: the marker was written before the notice was confirmed sent, so an owner with no Telegram, no owner id, or a failed send would never be told. Fixed: `notifyOwnerUnverifiedOnce` writes the marker only after a non-null send result and is unit-tested for no channel, null result, a throwing send, and once-ever. Its nits fixed too: two stale "refused" comments (WhatsAppAdapter.ts, setup.ts) and the notice now offers to send the Secret Drop link on a yes. Re-asked of the same reviewer per the 2026-11-18 rule.

**Second-pass review of the amendment (round 2, same reviewer, agent id add21927c6c9a748f):** CONCUR. Nits applied: the async wrapper reuses the existing import and has a catch; this file's wording on when the hook runs; the notice names the exact request ("send the WhatsApp secret link") so a reply has context.
