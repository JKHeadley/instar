/**
 * WhatsApp Business API Webhook Routes — Express middleware for Meta webhooks.
 *
 * Mounts two routes on the Express app:
 * - GET  /webhooks/whatsapp — Verification endpoint (Meta sends challenge)
 * - POST /webhooks/whatsapp — Message/status delivery from Meta
 *
 * These routes are only mounted when the WhatsApp adapter uses the
 * 'business-api' backend. Baileys doesn't need webhooks.
 */

import type { Express, Request, Response } from 'express';
import type { BusinessApiBackend, WebhookPayload } from './BusinessApiBackend.js';

export interface WhatsAppWebhookRoutesOptions {
  /** The Express app to mount routes on */
  app: Express;
  /** The BusinessApiBackend that will process webhooks */
  backend: BusinessApiBackend;
  /** Optional path prefix (default: '/webhooks/whatsapp') */
  path?: string;
}

/**
 * Mount WhatsApp webhook routes on an Express app.
 * Returns a cleanup function to unmount the routes (for testing).
 */
export function mountWhatsAppWebhooks(options: WhatsAppWebhookRoutesOptions): void {
  const webhookPath = options.path ?? '/webhooks/whatsapp';
  const { app, backend } = options;

  // GET — Webhook verification
  app.get(webhookPath, (req: Request, res: Response) => {
    const mode = req.query['hub.mode'] as string;
    const token = req.query['hub.verify_token'] as string;
    const challenge = req.query['hub.challenge'] as string;

    if (!mode || !token || !challenge) {
      res.status(400).json({ error: 'Missing verification parameters' });
      return;
    }

    const result = backend.verifyWebhook(mode, token, challenge);
    if (result !== null) {
      res.status(200).send(result);
    } else {
      res.status(403).json({ error: 'Verification failed' });
    }
  });

  // POST — Message/status delivery.
  // SEC-086: this route sits before bearer auth, so the only proof a body came from Meta is
  // its X-Hub-Signature-256 HMAC under the app secret. An unsigned or wrongly signed body is
  // refused before anything is processed; with no secret configured nothing is accepted.
  let warnedNoSecret = false;
  app.post(webhookPath, async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const header = req.get?.('x-hub-signature-256') ?? (req.headers?.['x-hub-signature-256'] as string | undefined);
    const verdict = backend.verifyPayloadSignature(rawBody, header);
    if (verdict !== 'ok') {
      if (verdict === 'no-secret' && !warnedNoSecret) {
        warnedNoSecret = true;
        console.warn('[whatsapp-webhook] Refusing webhook deliveries: no Meta app secret is configured, so a delivery cannot be proven to come from Meta.');
      }
      res.status(verdict === 'no-secret' ? 503 : 401).json({ error: verdict === 'no-secret' ? 'webhook-signature-not-configured' : 'invalid-signature' });
      return;
    }

    // Meta expects a 200 response within 5 seconds — process async
    res.status(200).send('EVENT_RECEIVED');

    try {
      const payload = req.body as WebhookPayload;
      if (payload && payload.object) {
        await backend.handleWebhook(payload);
      }
    } catch (err) {
      console.error(`[whatsapp-webhook] Error processing webhook: ${err}`);
    }
  });
}
