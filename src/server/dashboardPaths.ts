/**
 * Dashboard addresses (docs/specs/dashboard-console-default-and-pair-page.md). Dependency-free so
 * the CLI, the Telegram adapter and the pairing routes can share them with the server routes.
 */

/** Where a bare `/dashboard` goes. */
export const CONSOLE_PATH = '/dashboard/console/';
/** The legacy dashboard's own address. */
export const LEGACY_PATH = '/dashboard/legacy';
/** The pairing code page. */
export const PAIR_PAGE_PATH = '/dashboard/pair';

/** The code page for a phone that redeemed on `host` (fragment only: never sent to a server). */
export function codePageUrlForDevice(host: string, deviceId: string): string {
  return `https://${host}${PAIR_PAGE_PATH}#d=${encodeURIComponent(deviceId)}`;
}

/** The code page on an origin (`https://name.example`). */
export function codePageUrlForOrigin(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${PAIR_PAGE_PATH}`;
}

/** A console page on an origin, by its hash route (`#/work/sessions`). */
export function consolePageUrl(origin: string, hashRoute: string): string {
  return `${origin.replace(/\/+$/, '')}${CONSOLE_PATH}${hashRoute}`;
}
