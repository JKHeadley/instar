/** instar.sh/download/mac (topic 145295): always the newest full Mac build from the signed update feed. */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROUTE = path.join(__dirname, '../../site/src/pages/download/mac.ts');
// The site has its own Astro tsconfig the root install cannot resolve, so the route is loaded from a
// copy outside site/ (its only import is type-only and is erased).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'download-mac-'));
afterAll(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/site-download-mac.test.ts' }));

type Mod = {
  GET: () => Promise<Response>;
  newestMacZip: (xml: string) => string | null;
  macDownloadTarget: (f: typeof fetch) => Promise<string>;
  MAC_FEED: string;
  MAC_RELEASE_PAGE: string;
};
let modP: Promise<Mod> | null = null;
function load(): Promise<Mod> {
  if (!modP) {
    const copy = path.join(tmp, 'mac.ts');
    fs.copyFileSync(ROUTE, copy);
    modP = import(pathToFileURL(copy).href) as Promise<Mod>;
  }
  return modP;
}

const P = 'https://github.com/JKHeadley/instar/releases/download/mac-app/';
const item = (v: number, url: string, deltas = '') => `<item><title>${v}</title><sparkle:version>${v}</sparkle:version>
  <sparkle:shortVersionString>0.5.1</sparkle:shortVersionString>
  <enclosure url="${url}" length="1" type="application/octet-stream" sparkle:edSignature="x"/>${deltas}</item>`;
const FEED = `<?xml version="1.0"?><rss><channel>
${item(106, `${P}Instar-0.5.1-106.zip`)}
${item(108, `${P}Instar-0.5.1-108.zip`, `<sparkle:deltas><enclosure url="${P}Instar108-106.delta" sparkle:deltaFrom="106"/></sparkle:deltas>`)}
${item(105, `${P}Instar-0.5.1-105.zip`)}
</channel></rss>`;

describe('/download/mac', () => {
  it('is rendered on request, never baked into the build', () => {
    expect(fs.readFileSync(ROUTE, 'utf8')).toMatch(/export const prerender = false;/);
  });

  it('picks the highest build number, not the first item, and never a delta', async () => {
    const { newestMacZip } = await load();
    expect(newestMacZip(FEED)).toBe(`${P}Instar-0.5.1-108.zip`);
  });

  it('ignores downloads that are not a zip on the mac-app release', async () => {
    const { newestMacZip } = await load();
    const feed = item(200, 'https://evil.example/Instar.zip') + item(201, `${P}Instar201.delta`)
      + item(202, `${P}../x/Instar.zip`) + item(107, `${P}Instar-0.5.1-107.zip`);
    expect(newestMacZip(feed)).toBe(`${P}Instar-0.5.1-107.zip`);
    expect(newestMacZip('<rss></rss>')).toBeNull();
  });

  it('falls back to the release page when the feed is unreadable', async () => {
    const { macDownloadTarget, MAC_RELEASE_PAGE, MAC_FEED } = await load();
    expect(MAC_FEED).toBe(`${P}appcast.xml`);
    const down = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const throws = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const empty = (async () => new Response('<rss></rss>')) as unknown as typeof fetch;
    expect(await macDownloadTarget(down)).toBe(MAC_RELEASE_PAGE);
    expect(await macDownloadTarget(throws)).toBe(MAC_RELEASE_PAGE);
    expect(await macDownloadTarget(empty)).toBe(MAC_RELEASE_PAGE);
    const ok = (async () => new Response(FEED)) as unknown as typeof fetch;
    expect(await macDownloadTarget(ok)).toBe(`${P}Instar-0.5.1-108.zip`);
  });
});
