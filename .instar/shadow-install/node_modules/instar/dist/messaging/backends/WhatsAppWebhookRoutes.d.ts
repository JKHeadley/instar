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
import type { Express } from 'express';
import type { BusinessApiBackend } from './BusinessApiBackend.js';
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
export declare function mountWhatsAppWebhooks(options: WhatsAppWebhookRoutesOptions): void;
//# sourceMappingURL=WhatsAppWebhookRoutes.d.ts.map