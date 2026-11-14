// Android App Links for the Instar Android app (docs/specs/mobile-android-app.md §2.1).
// Android verifies https://instar.sh/.well-known/assetlinks.json before a tapped
// instar.sh/pair link opens the app. `handle_all_urls` grants the host; the app's own
// intent filter (autoVerify, https, host instar.sh, path /pair) is what limits it to
// pairing links, so that filter must stay limited to /pair.
// The fingerprints are public certificate hashes, not secrets. The Play app signing
// key's fingerprint is added here once Play Console creates the app (commitment CMT-1764).
import type { APIRoute } from 'astro';

export const prerender = false;

/** SHA-256 certificate fingerprints allowed to open instar.sh pairing links. */
export const ANDROID_CERT_FINGERPRINTS: readonly string[] = [
  // Upload key.
  '3B:05:15:62:1C:08:64:31:EB:55:A6:82:EA:17:42:1A:65:17:03:D1:8C:30:BD:83:A4:20:50:86:72:DD:6B:50',
];

export const assetLinks = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'io.sagemindai.instar', sha256_cert_fingerprints: [...ANDROID_CERT_FINGERPRINTS] },
  },
];

export const GET: APIRoute = () =>
  new Response(JSON.stringify(assetLinks), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
