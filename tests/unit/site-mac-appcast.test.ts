/** instar.sh Mac update feed address (topic 143051): a fixed address that points at the `mac-app` release feed. */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROUTE = path.join(__dirname, '../../site/src/pages/mac/appcast.xml.ts');
// The site has its own Astro tsconfig the root install cannot resolve, so the route is loaded from a
// copy outside site/ (its only import is type-only and is erased).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appcast-'));
afterAll(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/site-mac-appcast.test.ts' }));

describe('/mac/appcast.xml', () => {
  it('redirects, uncached, to the signed feed on the mac-app release', async () => {
    const copy = path.join(tmp, 'appcast.ts');
    fs.copyFileSync(ROUTE, copy);
    const { GET, FEED } = await import(pathToFileURL(copy).href) as { GET: () => Response; FEED: string };
    expect(fs.readFileSync(ROUTE, 'utf8')).toMatch(/export const prerender = false;/);
    expect(FEED).toBe('https://github.com/JKHeadley/instar/releases/download/mac-app/appcast.xml');
    const r = GET();
    expect(r.status).toBe(302);
    expect(r.headers.get('Location')).toBe(FEED);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
});
