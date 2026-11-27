/**
 * Browser-clickable tunnel URL for a private view, with the HMAC signature that
 * lets the view route admit it without a Bearer header.
 *
 * Shared by the /view routes and by the job-anomaly push (job-cost-reduction
 * §5.4), which links a held evidence block as a private view. One builder so the
 * two can never sign a link differently.
 */

import { signViewPath } from './middleware.js';

export interface ViewTunnelSource {
  getExternalUrl(pathname: string): string | null | undefined;
}

export function buildViewTunnelUrl(
  tunnel: ViewTunnelSource | null | undefined,
  authToken: string | null | undefined,
  viewId: string,
): string | null {
  const viewPath = `/view/${viewId}`;
  const base = tunnel?.getExternalUrl(viewPath);
  if (!base) return null;
  if (authToken) return `${base}?sig=${signViewPath(viewPath, authToken)}`;
  return base;
}
