/**
 * What the Cloudflare-with-your-own-domain recipe needs (docs/specs/recommended-services.md, catalog row
 * cloudflare-domain): Cloudflare's API with the person's token, this agent's tunnel config, and a planned
 * restart. The server does the whole Cloudflare job in `sync`: find the zone for the chosen host name, make (or
 * find) a named tunnel for this agent, point the tunnel at this server's port, point a DNS name at the tunnel,
 * and write the tunnel token into this agent's config. Nothing here logs a token.
 */
export interface CloudflareZone { id: string; name: string; accountId: string }
export interface CloudflareTunnel { id: string; name: string }

export interface CloudflareApi {
  /** The token's own standing: valid, refused, or Cloudflare did not answer. */
  verifyToken(token: string): Promise<'ok' | 'refused' | 'unknown'>;
  /** The zone that holds a host name (the registrable domain), or null when the token sees none. */
  zoneFor(token: string, hostname: string): Promise<CloudflareZone | null | undefined>;
  /** A tunnel by name in the account, or null. */
  tunnelNamed(token: string, accountId: string, name: string): Promise<CloudflareTunnel | null | undefined>;
  createTunnel(token: string, accountId: string, name: string): Promise<CloudflareTunnel | null>;
  /** The tunnel's run token (what `cloudflared tunnel run --token` takes). */
  tunnelToken(token: string, accountId: string, tunnelId: string): Promise<string | null>;
  /** Point the tunnel's ingress at this server. */
  putIngress(token: string, accountId: string, tunnelId: string, hostname: string, localPort: number): Promise<boolean>;
  /** A proxied CNAME from the host name to the tunnel: the record id, and whether this call created it. */
  putDns(token: string, zoneId: string, hostname: string, tunnelId: string): Promise<{ id: string; created: boolean } | null>;
  deleteDns(token: string, zoneId: string, recordId: string): Promise<boolean>;
  deleteTunnel(token: string, accountId: string, tunnelId: string): Promise<boolean>;
}

export interface TunnelSettings { enabled: boolean; type: 'quick' | 'named'; token?: string; hostname?: string; configFile?: string }

/** What the recipe remembers of the block it replaced: never a token (a hand-made named tunnel is never replaced, so none is needed). */
export type PreviousTunnel = Omit<TunnelSettings, 'token'>;

export interface CloudflareSurface {
  api: CloudflareApi;
  /** This agent's tunnel settings as configured, or null when there is no tunnel block. */
  tunnelConfigured(): TunnelSettings | null;
  /** Writes a named tunnel into this agent's config (replacing the block; the previous one, without any token, is returned for the switch-off). */
  writeNamedTunnel(entry: { token: string; hostname: string }): PreviousTunnel | null;
  /** Restores a previous tunnel block (or removes the named one, leaving a quick tunnel) after a switch-off. */
  restoreTunnel(previous: PreviousTunnel | null): void;
  /** One public read of this agent through the host name: `GET https://<hostname>/health` answers 200. */
  reachable(hostname: string): Promise<'ok' | 'unreachable' | 'unknown'>;
  requestRestart(reason: string): boolean;
  /** This server's own port, for the tunnel's ingress. */
  port: number;
}

const API = 'https://api.cloudflare.com/client/v4';

/** The production client over Cloudflare's REST API. The token travels in a header only. */
export function realCloudflareApi(doFetch: typeof fetch = fetch): CloudflareApi {
  const call = async <T>(token: string, method: string, pathname: string, body?: unknown): Promise<{ status: number; ok: boolean; result: T | null } | undefined> => {
    try {
      const res = await doFetch(`${API}${pathname}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
      const parsed = await res.json().catch(() => null) as { success?: boolean; result?: T } | null;
      return { status: res.status, ok: res.ok && parsed?.success !== false, result: parsed?.result ?? null };
    } catch {
      // @silent-fallback-ok: "Cloudflare did not answer" is a state the recipe reports as unknown
      return undefined;
    }
  };
  return {
    verifyToken: async (token) => {
      const r = await call<{ status?: string }>(token, 'GET', '/user/tokens/verify');
      if (!r) return 'unknown';
      if (r.status === 401 || r.status === 403) return 'refused';
      return r.ok && r.result?.status === 'active' ? 'ok' : r.ok ? 'refused' : 'unknown';
    },
    zoneFor: async (token, hostname) => {
      const labels = hostname.toLowerCase().split('.');
      // Try the longest suffix first: a zone can itself be a subdomain.
      for (let i = 0; i < labels.length - 1; i += 1) {
        const name = labels.slice(i).join('.');
        const r = await call<Array<{ id: string; name: string; account?: { id?: string } }>>(token, 'GET', `/zones?name=${encodeURIComponent(name)}&status=active`);
        if (!r) return undefined;
        const z = r.ok && Array.isArray(r.result) ? r.result[0] : undefined;
        if (z?.id && z.account?.id) return { id: z.id, name: z.name, accountId: z.account.id };
      }
      return null;
    },
    tunnelNamed: async (token, accountId, name) => {
      const r = await call<Array<{ id: string; name: string; deleted_at?: string | null }>>(token, 'GET', `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
      if (!r) return undefined;
      const t = r.ok && Array.isArray(r.result) ? r.result.find((x) => x.name === name && !x.deleted_at) : undefined;
      return t ? { id: t.id, name: t.name } : null;
    },
    createTunnel: async (token, accountId, name) => {
      const r = await call<{ id: string; name: string }>(token, 'POST', `/accounts/${accountId}/cfd_tunnel`, { name, config_src: 'cloudflare' });
      return r?.ok && r.result?.id ? { id: r.result.id, name: r.result.name } : null;
    },
    tunnelToken: async (token, accountId, tunnelId) => {
      const r = await call<string>(token, 'GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
      return r?.ok && typeof r.result === 'string' && r.result ? r.result : null;
    },
    putIngress: async (token, accountId, tunnelId, hostname, localPort) => {
      const r = await call(token, 'PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: { ingress: [{ hostname, service: `http://localhost:${localPort}` }, { service: 'http_status:404' }] },
      });
      return !!r?.ok;
    },
    putDns: async (token, zoneId, hostname, tunnelId) => {
      const content = `${tunnelId}.cfargotunnel.com`;
      const existing = await call<Array<{ id: string; content?: string }>>(token, 'GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
      const found = existing?.ok && Array.isArray(existing.result) ? existing.result[0] : undefined;
      if (found?.id) {
        if (found.content === content) return { id: found.id, created: false };
        const upd = await call<{ id: string }>(token, 'PATCH', `/zones/${zoneId}/dns_records/${found.id}`, { type: 'CNAME', name: hostname, content, proxied: true });
        return upd?.ok && upd.result?.id ? { id: upd.result.id, created: false } : null;
      }
      const r = await call<{ id: string }>(token, 'POST', `/zones/${zoneId}/dns_records`, { type: 'CNAME', name: hostname, content, proxied: true, ttl: 1 });
      return r?.ok && r.result?.id ? { id: r.result.id, created: true } : null;
    },
    deleteDns: async (token, zoneId, recordId) => !!(await call(token, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`))?.ok,
    deleteTunnel: async (token, accountId, tunnelId) => {
      // Cloudflare refuses to delete a tunnel with live connections. The switch-off runs while this server's own
      // connector is still up (the restart that stops it comes last), so this usually fails; the caller says so.
      await call(token, 'DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`);
      return !!(await call(token, 'DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}?cascade=true`))?.ok;
    },
  };
}

/**
 * The name of the tunnel this recipe makes for an agent on one machine: fixed, so a repeat finds the same one, and
 * per machine, so two machines of one agent never attach connectors to one tunnel (Cloudflare would balance traffic
 * onto a standby).
 */
export function tunnelNameFor(agentName: string, machineId?: string): string {
  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const m = machineId ? slug(machineId).slice(0, 12) : '';
  return `instar-${slug(agentName)}${m ? `-${m}` : ''}`;
}

/** The config block a setup write produces: the old relay and notice settings kept, the kind, token and name replaced, no config file. */
export function namedTunnelBlock(old: Record<string, unknown> | undefined, entry: { token: string; hostname: string }): Record<string, unknown> {
  const { configFile: _cf, ...kept } = old && typeof old === 'object' ? old : {};
  return { ...kept, enabled: true, type: 'named', token: entry.token, hostname: entry.hostname };
}

/** The config block a switch-off restores: the previous kind, name and config file, never a token; a quick tunnel when there was none. */
export function restoredTunnelBlock(old: Record<string, unknown> | undefined, previous: PreviousTunnel | null): Record<string, unknown> {
  const { token: _t, hostname: _h, configFile: _c, ...kept } = old && typeof old === 'object' ? old : {};
  if (!previous) return { ...kept, enabled: true, type: 'quick' };
  return { ...kept, enabled: previous.enabled, type: previous.type, ...(previous.hostname ? { hostname: previous.hostname } : {}), ...(previous.configFile ? { configFile: previous.configFile } : {}) };
}

/** A tunnel block read from config, as the recipe sees it. */
export function tunnelSettingsFrom(t: unknown): TunnelSettings | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  return { enabled: !!o.enabled, type: o.type === 'named' ? 'named' : 'quick', ...(typeof o.token === 'string' ? { token: o.token } : {}), ...(typeof o.hostname === 'string' ? { hostname: o.hostname } : {}), ...(typeof o.configFile === 'string' ? { configFile: o.configFile } : {}) };
}

/** The previous block as the recipe remembers it: no token ever written to the setup state. */
export function withoutToken(t: TunnelSettings | null): PreviousTunnel | null {
  if (!t) return null;
  const { token: _t, ...rest } = t;
  return rest;
}

/** A host name the recipe accepts: lower-case labels, at least two, no scheme or path. */
export function validHostname(value: string): boolean {
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

/** What the recipe remembers of its own work, so a switch-off undoes exactly that. */
export interface CloudflareWork { zoneId: string; accountId: string; tunnelId: string; dnsRecordId: string; createdDns: boolean; hostname: string; createdTunnel: boolean; previousTunnel: PreviousTunnel | null }

/** The stored secret for this recipe: the API token and the person's chosen host name, as one JSON value. */
export function parseCloudflareSecret(raw: string | null): { token: string; hostname: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { token?: unknown; hostname?: unknown };
    if (typeof v.token !== 'string' || !v.token || typeof v.hostname !== 'string' || !validHostname(v.hostname)) return null;
    return { token: v.token, hostname: v.hostname };
  } catch {
    return null; // @silent-fallback-ok: an unreadable value is "no credential stored"
  }
}
