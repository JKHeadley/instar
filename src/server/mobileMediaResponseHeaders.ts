import type { Response } from 'express';
import { isInlineSafe, safeFileName } from '../core/appMediaTypes.js';

export function setMobileMediaResponseHeaders(res: Response, mediaType: string, filename: string, ranges: boolean): void {
  const inline = isInlineSafe(mediaType);
  res.setHeader('Content-Type', inline ? mediaType : 'application/octet-stream');
  if (!inline) res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(filename, mediaType)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Accept-Ranges', ranges ? 'bytes' : 'none');
}
