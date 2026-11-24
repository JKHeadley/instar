import type { APIRoute } from 'astro';
import fallback from '../../lib/computer-link-fallback.html?raw';

export const prerender = false;

export const GET: APIRoute = () => new Response(fallback, {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
  },
});
