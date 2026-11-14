/**
 * deviceClientWording — the words the server writes that name the kind of device that sent a
 * message (dashboard-conversations-browser-device.md §4.7).
 *
 * A device record with `client: 'browser'` is a dashboard browser holding its own approved key;
 * anything else is a phone. Phone wording is unchanged byte for byte; browser wording swaps 📱/"app"
 * for 💻/"dashboard". The kind is decided only from the device record's `client` field.
 */

export type DeviceClient = 'phone' | 'browser';

/** 'browser' only when the record says `client: 'browser'`; anything else (absent, other) is a phone. */
export function deviceClientOf(d: { client?: unknown } | null | undefined): DeviceClient {
  return d != null && d.client === 'browser' ? 'browser' : 'phone';
}

/** "📱 <name> (from the app)" | "💻 <name> (from the dashboard)" — the mirror line prefix. */
export function mirrorPrefix(client: DeviceClient, name: string): string {
  return client === 'browser' ? `💻 ${name} (from the dashboard)` : `📱 ${name} (from the app)`;
}

/** The icon alone (used in "<icon> <name> sent <file> (…)" lines). */
export function deviceIcon(client: DeviceClient): string {
  return client === 'browser' ? '💻' : '📱';
}

/** "open it in the app" | "open it in the dashboard". */
export function openItHint(client: DeviceClient): string {
  return client === 'browser' ? 'open it in the dashboard' : 'open it in the app';
}

/** "(📱 signed)" | "(💻 signed)" — the session tag for a verified message. */
export function signedTag(client: DeviceClient): string {
  return client === 'browser' ? '(💻 signed)' : '(📱 signed)';
}

/** "phone" | "browser". */
export function deviceNoun(client: DeviceClient): string {
  return client === 'browser' ? 'browser' : 'phone';
}

/**
 * The kind of device that signed this request. The device authenticator sets
 * `instarDeviceClient` on the request after the signature is verified; an unset value is a phone
 * (the authenticator of an older build never sets it, and phones are the default).
 */
export function requestDeviceClient(req: unknown): DeviceClient {
  const c = (req as { instarDeviceClient?: unknown } | null | undefined)?.instarDeviceClient;
  return c === 'browser' ? 'browser' : 'phone';
}
