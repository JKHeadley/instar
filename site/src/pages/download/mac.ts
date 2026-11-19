// instar.sh/download/mac: the public "Download for Mac" link (topic 145295). It never names a build:
// on each request it reads the Mac app's update feed (the same signed Sparkle feed the installed app
// checks) and sends the visitor to the newest full build there, so publishing a new build never
// needs a site change and the link can never point at an old one.
// Only a .zip on the `mac-app` GitHub release is ever used; anything else in the feed is ignored. If
// the feed cannot be read, the visitor lands on the release page, where every build is listed.
// Self-contained on purpose (type-only import) so the unit test can load a copy of this file.
import type { APIRoute } from 'astro';

export const prerender = false;

export const MAC_FEED = 'https://github.com/JKHeadley/instar/releases/download/mac-app/appcast.xml';
export const MAC_RELEASE_PREFIX = 'https://github.com/JKHeadley/instar/releases/download/mac-app/';
export const MAC_RELEASE_PAGE = 'https://github.com/JKHeadley/instar/releases/tag/mac-app';

/** The newest full-build download in a Sparkle feed, or null when it has none we trust. */
export function newestMacZip(xml: string): string | null {
  let best: { version: number; url: string } | null = null;
  for (const raw of xml.split(/<item[\s>]/).slice(1)) {
    const item = raw.split('</item>')[0].replace(/<sparkle:deltas>[\s\S]*?<\/sparkle:deltas>/g, '');
    const version = Number(/<sparkle:version>\s*(\d+)\s*<\/sparkle:version>/.exec(item)?.[1]);
    const url = /<enclosure\b[^>]*\burl="([^"]+)"/.exec(item)?.[1];
    if (!Number.isFinite(version) || !url) continue;
    if (!url.startsWith(MAC_RELEASE_PREFIX) || !url.endsWith('.zip')) continue;
    const name = url.slice(MAC_RELEASE_PREFIX.length);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    if (!best || version > best.version) best = { version, url };
  }
  return best?.url ?? null;
}

/** Where the Download for Mac link sends a visitor right now. */
export async function macDownloadTarget(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl(MAC_FEED, { redirect: 'follow', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return MAC_RELEASE_PAGE;
    return newestMacZip(await res.text()) ?? MAC_RELEASE_PAGE;
  } catch {
    return MAC_RELEASE_PAGE;
  }
}

export const GET: APIRoute = async () =>
  new Response(null, {
    status: 302,
    headers: { Location: await macDownloadTarget(), 'Cache-Control': 'public, max-age=0, s-maxage=300' },
  });
