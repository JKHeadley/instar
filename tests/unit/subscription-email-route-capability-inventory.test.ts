import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_POOL_WRITE_CAPABILITIES } from '../../src/server/routes.js';

describe('subscription email reconciliation route capability inventory', () => {
  it('classifies every mutating subscription-pool route and no nonexistent route', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/server/routes.ts'),
      'utf8',
    );
    const actual = [...source.matchAll(
      /router\.(post|patch|delete)\('([^']*\/subscription-pool[^']*)'/g,
    )].map((match) => `${match[1]!.toUpperCase()} ${match[2]}`).sort();
    expect(Object.keys(SUBSCRIPTION_POOL_WRITE_CAPABILITIES).sort()).toEqual(actual);
    for (const route of actual) {
      const [method, routePath] = route.split(' ', 2);
      const escapedPath = routePath!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(source).toMatch(new RegExp(
        `router\\.${method!.toLowerCase()}\\('${escapedPath}',\\s*` +
        `enforceSubscriptionPoolWriteCapability\\('${escapedRoute}'\\)`,
      ));
    }
  });

  it('defaults identity mutation paths to barrier-required unless explicitly exempted', () => {
    const required = Object.entries(SUBSCRIPTION_POOL_WRITE_CAPABILITIES)
      .filter(([, capability]) => capability === 'requiresEmailReconciliation')
      .map(([route]) => route)
      .sort();
    expect(required).toEqual([
      'POST /subscription-pool',
      'POST /subscription-pool/:id/repair-email',
      'POST /subscription-pool/enroll',
      'POST /subscription-pool/enroll/:id/complete',
      'POST /subscription-pool/follow-me/enroll/:id/complete',
      'POST /subscription-pool/follow-me/enroll/start',
      'POST /subscription-pool/matrix/start-cell',
    ]);
  });
});
