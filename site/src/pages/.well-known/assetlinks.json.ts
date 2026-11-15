// Android App Links for the Instar Android app (docs/specs/mobile-android-app.md §2.1).
// Android verifies https://instar.sh/.well-known/assetlinks.json before a tapped
// instar.sh/pair link opens the app. `handle_all_urls` grants the host; the app's own
// intent filter (autoVerify, https, host instar.sh, path /pair) is what limits it to
// pairing links, so that filter must stay limited to /pair.
// The fingerprints are public certificate hashes, not secrets. The Play app signing
// key's fingerprint was added 2026-11-14 when Play Console created the app (CMT-1764).
import type { APIRoute } from 'astro';

export const prerender = false;

/** SHA-256 certificate fingerprints allowed to open instar.sh pairing links. */
export const ANDROID_CERT_FINGERPRINTS: readonly string[] = [
  // Upload key (sideloaded and debug-signed release builds).
  '3B:05:15:62:1C:08:64:31:EB:55:A6:82:EA:17:42:1A:65:17:03:D1:8C:30:BD:83:A4:20:50:86:72:DD:6B:50',
  // Play App Signing key (every Play-installed copy), from Play Console > App integrity, 2026-11-14.
  '16:06:E1:B0:B6:A2:0E:99:0C:77:24:AD:6D:AB:36:1E:DB:CD:E8:DB:DB:FF:87:B7:BB:2D:AA:29:18:A9:38:82',
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
