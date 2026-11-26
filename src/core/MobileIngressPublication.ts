import { createHash } from 'node:crypto';
export function mobileIngressOperationKey(deviceId: string, requestId: string): string {
  return createHash('sha256')
    .update('instar-mobile-ingress-claim-v1\n')
    .update(JSON.stringify([deviceId, requestId]))
    .digest('hex');
}
