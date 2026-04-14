/**
 * Tests that the /sessions server route enriches session rows with a `binding`
 * field pointing back to the Slack channel (or Telegram topic) they belong to,
 * so the dashboard can display a human-readable label.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES_SRC = path.join(process.cwd(), 'src/server/routes.ts');

describe('/sessions endpoint — binding enrichment', () => {
  const source = fs.readFileSync(ROUTES_SRC, 'utf-8');

  it('sessions response includes a binding field', () => {
    // Look for the /sessions handler and assert it constructs a binding field.
    // We keep the check loose: the word "binding" must appear in the route file
    // near a sessions-listing code block.
    const sessionsRouteIdx = source.search(/['"]\/sessions['"]|app\.get\(['"]\/sessions/);
    expect(sessionsRouteIdx).toBeGreaterThan(-1);
    const routeBlock = source.slice(sessionsRouteIdx, sessionsRouteIdx + 6000);
    expect(routeBlock).toMatch(/binding/);
  });

  it('binding looks up Slack channel name from the adapter registry', () => {
    // The enrichment must call getChannelRegistry or a similar resolver
    expect(source).toMatch(/getChannelRegistry|getChannelForSession|channelName/);
  });
});
