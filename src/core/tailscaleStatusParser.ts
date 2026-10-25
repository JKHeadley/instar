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
  /**
   * Does this tailnet node actually BACK a mesh rope? A tailnet holds every device the
   * operator owns — phones, other people's laptops, long-dead nodes — and only a handful
   * back a mesh peer. True when the node's tailnet address is in the caller-supplied mesh
   * address set, and true for every node when no set is supplied (back-compatible: an
   * un-scoped caller keeps the previous tailnet-wide behaviour).
   *
   * SCRUB DIRECTION: addresses are matched INSIDE this parser and never leave it — the
   * caller passes addresses IN and gets a BOOLEAN back. The return shape still carries no
   * identity, so the content-scrub boundary above is preserved, not weakened.
   */
  backsMeshRope: boolean;
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
 *
 * `meshAddresses` (optional) is the set of tailnet addresses that back a mesh rope. When
 * supplied, each entry is flagged `backsMeshRope` accordingly; when omitted every entry is
 * flagged true and behaviour is unchanged.
 */
export function parseTailscaleStatus(
  rawBody: string,
  meshAddresses?: ReadonlySet<string>,
): TailscaleStatusParse {
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

  /** True when this node holds one of the mesh-backing addresses (or no scoping asked). */
  const backs = (node: unknown): boolean => {
    if (!meshAddresses || meshAddresses.size === 0) return true;
    if (!node || typeof node !== 'object') return false;
    const ips = (node as { TailscaleIPs?: unknown }).TailscaleIPs;
    if (!Array.isArray(ips)) return false;
    return ips.some((ip) => typeof ip === 'string' && meshAddresses.has(ip));
  };

  if (obj.Self && typeof obj.Self === 'object') {
    // Self ALWAYS counts: this machine's own key expiring drops every rope it has,
    // whether or not its address happens to appear in the mesh address set.
    entries.push({ role: 'self', keyExpiryIso: expiryOf(obj.Self), backsMeshRope: true });
  }
  if (obj.Peer && typeof obj.Peer === 'object') {
    for (const peer of Object.values(obj.Peer as Record<string, unknown>)) {
      entries.push({ role: 'peer', keyExpiryIso: expiryOf(peer), backsMeshRope: backs(peer) });
    }
  }
  return { parsed: true, entries };
}

/**
 * The days-until-soonest-expiry summary the monitor's degraded tier consumes.
 * Returns null when no entry carries an expiry.
 *
 * `opts.meshScopedOnly` restricts the scan to entries that back a mesh rope (self always
 * counts). Without it the scan is tailnet-wide, which is how a dead unrelated node warned
 * forever: an old device whose key expired months ago is the permanent global minimum, so
 * the warning never clears and stops carrying information (observed 2026-08-29 — a node
 * offline since 2026-08-13 kept the mesh digest warning while every real mesh machine's
 * key was months from expiry).
 */
export function soonestKeyExpiry(
  parse: TailscaleStatusParse,
  nowMs: number,
  opts?: { meshScopedOnly?: boolean },
): { role: 'self' | 'peer'; expiresAtIso: string; inDays: number } | null {
  let best: { role: 'self' | 'peer'; expiresAtIso: string; inDays: number } | null = null;
  for (const e of parse.entries) {
    if (opts?.meshScopedOnly && !e.backsMeshRope) continue;
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
