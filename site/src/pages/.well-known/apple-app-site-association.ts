// Universal links for the Instar iPhone and Mac apps (docs/specs/mobile-pairing-link.md §2.3,
// docs/specs/permanent-agent-links.md §4). Only the Instar apps (team AG9AE2H87X) may open
// instar.sh/pair, /doc, /link/computer and /a links on their supported platforms.
import type { APIRoute } from 'astro';

export const prerender = false;

const association = {
  applinks: {
    details: [
      {
        appIDs: ['AG9AE2H87X.io.sagemindai.instar'],
        components: [
          { '/': '/pair', comment: 'One-time agent pairing links (fragment carries v, o, c)' },
          { '/': '/doc', comment: 'Open an Instar Document in the app (fragment carries v, o, d, c); no secret in it' },
          { '/': '/link/computer', comment: 'Open the computer-link confirmation in the app' },
          { '/': '/a', comment: 'Permanent agent link: agent identity and page in the fragment; no secret, no address' },
          { '/': '/a/', comment: 'The same, if the static page is served with a trailing slash' },
        ],
      },
      {
        // The Mac app: permanent agent links only (no Mac handlers for /pair, /doc or /link/computer).
        appIDs: ['AG9AE2H87X.io.sagemindai.instar.mac'],
        components: [
          { '/': '/a', comment: 'Permanent agent link' },
          { '/': '/a/', comment: 'The same, with a trailing slash' },
        ],
      },
    ],
  },
};

export const GET: APIRoute = () =>
  new Response(JSON.stringify(association), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
