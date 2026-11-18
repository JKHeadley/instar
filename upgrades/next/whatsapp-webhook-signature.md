# WhatsApp Business deliveries must be signed by Meta

<!-- bump: patch -->

## What Changed

SEC-086. The WhatsApp Business API webhook (`POST /webhooks/whatsapp`) sits in front of the server's sign-in check, because Meta calls it without one. Until now it accepted any body, so anyone who could reach the agent's public address could post a made-up message "from" any number, including the owner's, and the agent treated it as real.

Every delivery must now carry Meta's `X-Hub-Signature-256` signature over the exact body, made with the app's App Secret (new `businessApi.appSecret` setting). A delivery with no signature or a wrong one is refused with 401 and never processed. With no App Secret configured, every delivery is refused with 503 and the server says so once at startup and once on the first refused delivery. The verification check (GET) now compares the verify token in constant time.

`instar add whatsapp --backend business-api` takes `--app-secret` (or reads `WHATSAPP_APP_SECRET`, so the secret need not appear in the command line), and `instar channels doctor` lists the App Secret as a check. Setup no longer prints the verify token. The WhatsApp Web (Baileys) backend is unchanged.

## What to Tell Your User

- **WhatsApp Business needs one more setting**: "If you use WhatsApp through a Meta Business account, I now only accept messages Meta itself signed. I need your Meta app's App Secret once; until then, WhatsApp Business messages to me are refused rather than trusted."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Signed WhatsApp Business deliveries | Set `businessApi.appSecret` to the Meta App Secret; unsigned deliveries are refused |

## Evidence

- Unit: `tests/unit/BusinessApiBackend.test.ts` (+4 tests: correct secret; wrong secret, changed body and missing header; no secret; verify token), `tests/unit/WhatsAppWebhookRoutes.test.ts` (+3: 401 without processing, 503 fail-closed, raw body handed over).
- E2E: `tests/e2e/whatsapp-server-e2e.test.ts` (+2): an unsigned delivery naming the owner's number is refused and never reaches the adapter; a delivery signed with another secret is refused; signed deliveries still arrive.
