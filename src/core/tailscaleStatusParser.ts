/**
 * tailscaleStatusParser — U4.5's SECOND declared data source (R-r2-3): the
 * Tailscale key-expiry tier reads a bounded exec of `tailscale status --json`
 * (docs/specs/u4-5-rope-health-alerts.md §2). Key expiry is NOT in the U4.3
 * resolver snapshot (the resolver never sees it), so it has its OWN parser.
 *
 * CONTENT-SCRUB BOUNDARY (spec §2 "Content scrub is a hard rule"): the raw
 * tailscale JSON carries IPs, DNS names, tailnet names, account emails and
 * public keys. NONE of that leaves this parser — the return shape carries key
 * EXPIRY TIMES and role labels ONLY. Alert/digest text downstream is composed
 * exclusively from this scrubbed shape.
 *
 * `parseTailscaleStatus` is a REGISTERED parser (Scrape/Parser Fixture
 * Realness): its tests feed it captured byte-for-byte fixtures of real
 * `tailscale status --json` output (tests/fixtures/captured/tailscale-status/
 * + SCRAPE_PARSERS in scripts/lint-scrape-fixture-realness.js).
 */

/** One scrubbed key-expiry entry. `role` is the ONLY identity that survives. */
export interface TailscaleKeyExpiryEntry {
  role: 'self' | 'peer';
  /** ISO-8601 expiry, or null when the node has no expiring key (e.g. expiry disabled). */
  keyExpiryIso: string | null;
}

export interface TailscaleStatusParse {
  /** False ⇒ the body did not parse as the expected tailscale status JSON. */
  parsed: boolean;
  /** Scrubbed entries (self first, then peers in object order). Empty when !parsed. */
  entries: TailscaleKeyExpiryEntry[];
}

/**
 * Parse raw `tailscale status --json` stdout into the scrubbed key-expiry
 * shape. Tolerant of absent fields (a node without KeyExpiry yields null);
 * a malformed body yields `{ parsed: false, entries: [] }` — the expiry tier
 * is then silently absent for that pass (never an error state, spec R-r2-3).
 */
export function parseTailscaleStatus(rawBody: string): TailscaleStatusParse {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // @silent-fallback-ok: an unparseable status IS the classification (the
    // expiry tier is absent this pass) — the verdict carries it; nothing hidden.
    return { parsed: false, entries: [] };
  }
  if (!body || typeof body !== 'object') return { parsed: false, entries: [] };
  const obj = body as { Self?: unknown; Peer?: unknown; BackendState?: unknown };
  // Minimal shape check: real tailscale status JSON always carries BackendState.
  // A captive portal / wrong-command JSON body without it is NOT the contract.
  if (typeof obj.BackendState !== 'string') return { parsed: false, entries: [] };

  const entries: TailscaleKeyExpiryEntry[] = [];
  const expiryOf = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    const raw = (node as { KeyExpiry?: unknown }).KeyExpiry;
    if (typeof raw !== 'string') return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };

  if (obj.Self && typeof obj.Self === 'object') {
    entries.push({ role: 'self', keyExpiryIso: expiryOf(obj.Self) });
  }
  if (obj.Peer && typeof obj.Peer === 'object') {
    for (const peer of Object.values(obj.Peer as Record<string, unknown>)) {
      entries.push({ role: 'peer', keyExpiryIso: expiryOf(peer) });
    }
  }
  return { parsed: true, entries };
}

/**
 * The days-until-soonest-expiry summary the monitor's degraded tier consumes.
 * Returns null when no entry carries an expiry.
 */
export function soonestKeyExpiry(
  parse: TailscaleStatusParse,
  nowMs: number,
): { role: 'self' | 'peer'; expiresAtIso: string; inDays: number } | null {
  let best: { role: 'self' | 'peer'; expiresAtIso: string; inDays: number } | null = null;
  for (const e of parse.entries) {
    if (!e.keyExpiryIso) continue;
    const t = Date.parse(e.keyExpiryIso);
    if (!Number.isFinite(t)) continue;
    const inDays = (t - nowMs) / 86_400_000;
    if (!best || inDays < best.inDays) {
      best = { role: e.role, expiresAtIso: e.keyExpiryIso, inDays };
    }
  }
  return best;
}
