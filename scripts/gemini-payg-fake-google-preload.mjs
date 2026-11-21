/**
 * TEST-ONLY preload for the Gemini pay-per-use live test (scripts/gemini-payg-live-test.mjs).
 *
 * Loaded into a THROWAWAY agent's server process with `node --import <this file>`; never
 * shipped to an agent, never read from config. It points the process's `fetch` at a fake
 * Google, so the real server code — unchanged, with no base-URL setting anywhere in
 * production — runs its real transport against a local endpoint and no money can move:
 *
 *   - https://generativelanguage.googleapis.com/... → GPLT_FAKE_GOOGLE_ORIGIN (required;
 *     with it unset every Gemini request is REFUSED, never sent to Google);
 *   - any other google.com / googleapis.com URL is refused outright.
 *
 * Everything else passes through untouched.
 */
const origin = process.env.GPLT_FAKE_GOOGLE_ORIGIN;
const realFetch = globalThis.fetch;
const GEMINI = 'https://generativelanguage.googleapis.com';

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input && typeof input.url === 'string' ? input.url : String(input);
}

globalThis.fetch = async function liveTestFetch(input, init) {
  const url = urlOf(input);
  if (url.startsWith(`${GEMINI}/`)) {
    if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
      throw new Error('live-test fake-google: no loopback fake origin is set — refusing to reach Google');
    }
    return realFetch(origin + url.slice(GEMINI.length), init);
  }
  let host = '';
  try { host = new URL(url).hostname; } catch { /* not a URL — pass through */ }
  if (host === 'google.com' || host.endsWith('.google.com') || host === 'googleapis.com' || host.endsWith('.googleapis.com')) {
    throw new Error(`live-test fake-google: refusing a Google URL (${host}) inside a live test`);
  }
  return realFetch(input, init);
};
