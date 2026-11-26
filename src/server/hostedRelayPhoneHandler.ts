import express from 'express';
import type { RequestListener } from 'node:http';
import { hostedRelayArrival } from '../core/requestArrival.js';
import { deviceAuthenticator, serveMobileDeviceStatus, type HostedRelayPhoneBindingReader, type MobilePairingService } from './mobilePairingRoutes.js';

/** An isolated signed phone handler. It never mounts the general agent app. */
export function createHostedRelayPhoneHandler(pairing: MobilePairingService,
  binding: HostedRelayPhoneBindingReader): RequestListener {
  const app = express();
  app.disable('x-powered-by');
  const authenticate = deviceAuthenticator(pairing, { hostedRelayBinding: binding });
  app.use((req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!hostedRelayArrival(req) || req.method !== 'GET' || req.originalUrl !== '/mobile/device') {
      res.status(404).end();
      return;
    }
    const result = authenticate(req, res);
    if (result === 'none') res.status(401).json({ error: 'device-signature-required' });
    else if (result === 'ok') serveMobileDeviceStatus(pairing, req, res);
  });
  return app;
}
