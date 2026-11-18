// The Instar Mac app's update feed (topic 143051). The installed app checks this one fixed address
// (its Info.plist SUFeedURL) every hour. The feed and the update files live as assets of the `mac-app`
// GitHub release, so publishing a new build never needs a site deploy: this route only points there.
// Nothing here is trusted: Sparkle installs an update only when its EdDSA signature matches the
// public key built into the app and it is the same Developer ID app. The address is not linked from
// the site (the public download page waits on the operator's go-ahead).
import type { APIRoute } from 'astro';

export const prerender = false;

export const FEED = 'https://github.com/JKHeadley/instar/releases/download/mac-app/appcast.xml';

export const GET: APIRoute = () =>
  new Response(null, { status: 302, headers: { Location: FEED, 'Cache-Control': 'no-store' } });
