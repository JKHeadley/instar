// Universal links for the Instar iPhone app (docs/specs/mobile-pairing-link.md §2.3).
// Only the Instar app (team AG9AE2H87X, bundle io.sagemindai.instar) may open
// Instar universal links. Served as application/json, which Apple requires.
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
        ],
      },
    ],
  },
};

export const GET: APIRoute = () =>
  new Response(JSON.stringify(association), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
