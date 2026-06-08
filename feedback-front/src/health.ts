// Health endpoint for the Instar canonical feedback front (Phase-0 deploy-healthy check).
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    ok: true,
    service: 'instar-feedback-receiver-front',
    phase: 0,
    note: 'no-traffic; verify-only (no persistence until Phase 3)',
  });
}
