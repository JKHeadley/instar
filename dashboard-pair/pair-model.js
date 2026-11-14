// Pure helpers for the pairing code page (docs/specs/dashboard-console-default-and-pair-page.md §3.2).
// No DOM, no network: unit-tested directly.

/** The device id named in the page's fragment (`#d=<id>`), or null. Never sent to the server. */
export function deviceFromHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  let id = null;
  try { id = new URLSearchParams(raw).get('d'); } catch { return null; }
  if (!id || id.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;
  return id;
}

/**
 * Which waiting phones to show. With a named device: only it, or `missing: true` when it is not
 * waiting any more. Without one: every waiting phone.
 */
export function shownApprovals(approvals, deviceId) {
  const list = Array.isArray(approvals) ? approvals.filter((a) => a && typeof a === 'object' && a.deviceId) : [];
  if (!deviceId) return { list, missing: false };
  const one = list.filter((a) => a.deviceId === deviceId);
  return { list: one, missing: one.length === 0 };
}

/** The code as shown: a word code as sent (`KITE-4172`), six digits as `123 456`. */
export function prettyCode(code) {
  const raw = String(code ?? '');
  if (/[A-Za-z]/.test(raw)) return raw;
  const c = raw.replace(/\D/g, '');
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** The code as copied: what the app accepts, without display spacing (`KITE-4172`, `123456`). */
export function copyText(code) {
  const raw = String(code ?? '').trim();
  if (/[A-Za-z]/.test(raw)) return raw;
  return raw.replace(/\D/g, '');
}

/** Minutes left, in words. */
export function minutesLeft(iso, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return 'expired';
  return `${Math.max(1, Math.round(ms / 60_000))} min left`;
}

/** Whose phone: " — Ann (owner)", " — Sam (MSP)", or a removed person. */
export function personText(d) {
  if (!d) return '';
  if (d.unassigned) return ' — no longer assigned to anyone';
  if (!d.personName) return '';
  return ` — ${d.personName}${d.role === 'msp' ? ' (MSP)' : ' (owner)'}`;
}

/** One line naming a waiting phone. */
export function waitingLine(a, now = Date.now()) {
  return `${a.deviceName || 'A phone'}${a.label ? ` (${a.label})` : ''}${personText(a)} · ${minutesLeft(a.expiresAt, now)}`;
}

/** What the page says above the waiting list, from the approvals answer. */
export function waitingHeadline({ approval, shown, missing }) {
  if (approval === 'telegram') return 'This agent sends pairing codes to your private Telegram chat, not to this page.';
  if (missing) return 'That phone is no longer waiting: it was paired, declined, or its link expired.';
  if (!shown.length) return 'No phone is waiting. Open the pairing link on the phone; it appears here by itself.';
  return shown.length === 1 ? 'A phone is waiting to pair.' : `${shown.length} phones are waiting to pair.`;
}

/** The instruction beside Approve (mobile-pairing-approve §3.2): the matching key is the condition. */
export function approveHint(fingerprint) {
  return fingerprint
    ? `Phone key: ${fingerprint}. Approve only if you are pairing this phone right now and the key matches the one the app shows.`
    : 'Approve only if you are pairing this phone right now.';
}

/**
 * The paired devices, split for display (docs/specs/dashboard-ui-quality-standard.md): phones and
 * browsers are separate groups, so neither heading lists the other kind and no row repeats its kind.
 * Each row is a name line and one short detail line. Only active and pending devices are shown.
 * `personText` (optional) adds whose device it is to the name.
 */
export function pairedGroups(devices, { browserOff = false, personText = () => '' } = {}) {
  const phones = [], browsers = [];
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || (d.status !== 'active' && d.status !== 'pending')) continue;
    const isBrowser = d.client === 'browser';
    const name = `${d.deviceName || (isBrowser ? 'Unnamed browser' : 'Unnamed phone')}${personText(d)}`;
    let detail;
    if (d.status === 'pending') detail = 'Waiting to confirm';
    else if (isBrowser) {
      const t = Date.parse(d.lastSeenAt || '');
      detail = browserOff ? 'Switched off on this agent' : Number.isFinite(t) ? `Last used on this machine ${new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not used yet';
    } else {
      const t = Date.parse(d.approvedAt || '');
      detail = Number.isFinite(t) ? `Paired since ${new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : 'Paired';
    }
    (isBrowser ? browsers : phones).push({ id: d.id, name, detail, removable: d.status === 'active', what: isBrowser ? 'browser' : 'phone' });
  }
  return { phones, browsers };
}
