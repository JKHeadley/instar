/** instar.sh App Links file and pairing wording (docs/specs/mobile-android-app.md §2.1, §2.2, §7 Site). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROUTE = path.join(__dirname, '../../site/src/pages/.well-known/assetlinks.json.ts');
// The site has its own Astro tsconfig that the root install cannot resolve, so the route is
// loaded from a copy outside site/ (its only import is type-only and is erased).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assetlinks-'));
afterAll(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/site-android-app-links.test.ts' }));

describe('assetlinks.json', () => {
  it('answers the Digital Asset Links statement as application/json', async () => {
    const copy = path.join(tmp, 'assetlinks.ts');
    fs.copyFileSync(ROUTE, copy);
    const { GET, assetLinks, ANDROID_CERT_FINGERPRINTS } = await import(pathToFileURL(copy).href) as { GET: unknown; assetLinks: unknown; ANDROID_CERT_FINGERPRINTS: readonly string[] };
    expect(fs.readFileSync(ROUTE, 'utf8')).toMatch(/export const prerender = false;/);
    const r = await (GET as unknown as () => Response)();
    expect(r.headers.get('Content-Type')).toBe('application/json');
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = await r.json();
    expect(body).toEqual([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'io.sagemindai.instar', sha256_cert_fingerprints: [...ANDROID_CERT_FINGERPRINTS] } }]);
    expect(body).toEqual(assetLinks);
    expect(ANDROID_CERT_FINGERPRINTS).toContain('3B:05:15:62:1C:08:64:31:EB:55:A6:82:EA:17:42:1A:65:17:03:D1:8C:30:BD:83:A4:20:50:86:72:DD:6B:50');
    for (const f of ANDROID_CERT_FINGERPRINTS) expect(f).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('the pair page names both phones', () => {
    const page = fs.readFileSync(path.join(__dirname, '../../site/src/pages/pair.astro'), 'utf8');
    expect(page).toContain('On your phone with the Instar app (iPhone or Android), scan this code with the camera.');
    expect(page).not.toContain('On your iPhone with the Instar app');
  });
});
