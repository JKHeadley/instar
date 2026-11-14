/**
 * The Cloudflare fixed-address recipe (docs/specs/recommended-services.md, catalog row cloudflare-domain): the
 * server does the Cloudflare work in sync (zone, tunnel, route, DNS, this agent's tunnel block, a restart); the
 * check is one public read of the agent at its name; a switch-off undoes exactly setup's work. No token is ever
 * printed or put in a URL.
 */
import { describe, expect, it } from 'vitest';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import { CLOUDFLARE_SECRET, catalogWithProving, recipeFor, type StopDeps, type SyncDeps } from '../../src/recommended/recipes.js';
import {
  namedTunnelBlock, parseCloudflareSecret, realCloudflareApi, restoredTunnelBlock, tunnelNameFor, tunnelSettingsFrom, validHostname, withoutToken,
  type CloudflareApi, type CloudflareSurface, type CloudflareWork, type PreviousTunnel, type TunnelSettings,
} from '../../src/recommended/cloudflareDomain.js';

const row = RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'cloudflare-domain')!;
const recipe = recipeFor({ ...row, setupRecipe: 'cloudflare-v1' })!;
const SECRET = JSON.stringify({ token: 'cf-token-value', hostname: 'agent.example.com' });

function fakeApi(over: Partial<CloudflareApi> & { existingTunnel?: boolean } = {}) {
  const calls: string[] = [];
  const api: CloudflareApi = {
    verifyToken: async () => { calls.push('verify'); return 'ok'; },
    zoneFor: async () => { calls.push('zone'); return { id: 'z1', name: 'example.com', accountId: 'acc1' }; },
    tunnelNamed: async () => { calls.push('find'); return over.existingTunnel ? { id: 't-old', name: 'instar-echo' } : null; },
    createTunnel: async () => { calls.push('create'); return { id: 't1', name: 'instar-echo' }; },
    tunnelToken: async () => { calls.push('token'); return 'run-token'; },
    putIngress: async () => { calls.push('ingress'); return true; },
    putDns: async () => { calls.push('dns'); return { id: 'r1', created: true }; },
    deleteDns: async () => { calls.push('deleteDns'); return true; },
    deleteTunnel: async () => { calls.push('deleteTunnel'); return true; },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'existingTunnel')),
  };
  return { api, calls };
}

function surface(over: { tunnel?: TunnelSettings | null; reach?: 'ok' | 'unreachable' | 'unknown'; api?: CloudflareApi } = {}) {
  const state = { tunnel: over.tunnel === undefined ? null : over.tunnel, reach: over.reach ?? 'ok', restarts: [] as string[], restored: [] as Array<PreviousTunnel | null> };
  const s: CloudflareSurface = {
    api: over.api ?? fakeApi().api,
    port: 4042,
    tunnelConfigured: () => state.tunnel,
    writeNamedTunnel: ({ token, hostname }) => { const prev = withoutToken(state.tunnel); state.tunnel = { enabled: true, type: 'named', token, hostname }; return prev; },
    restoreTunnel: (previous) => { state.restored.push(previous); state.tunnel = previous ?? { enabled: true, type: 'quick' }; },
    reachable: async () => state.reach,
    requestRestart: (reason) => { state.restarts.push(reason); return true; },
  };
  return { s, state };
}

function work() {
  let kept: CloudflareWork | null = null;
  return { remember: (w: CloudflareWork) => { kept = w; }, recall: () => kept, forget: () => { kept = null; }, get kept() { return kept; } };
}

describe('the Cloudflare value and names', () => {
  it('accepts a token with a lower-case host name of two labels or more, nothing else', () => {
    expect(parseCloudflareSecret(SECRET)).toEqual({ token: 'cf-token-value', hostname: 'agent.example.com' });
    expect(parseCloudflareSecret(JSON.stringify({ token: 'x', hostname: 'Agent.Example.com' }))).toBeNull();
    expect(parseCloudflareSecret(JSON.stringify({ token: 'x', hostname: 'localhost' }))).toBeNull();
    expect(parseCloudflareSecret(JSON.stringify({ token: '', hostname: 'a.example.com' }))).toBeNull();
    expect(parseCloudflareSecret('cf-token-alone')).toBeNull();
    expect(parseCloudflareSecret(null)).toBeNull();
    expect(validHostname('https://agent.example.com')).toBe(false);
    expect(validHostname('agent.example.com/path')).toBe(false);
  });
  it('names the tunnel after the agent and the machine, the same way every time', () => {
    expect(tunnelNameFor('Echo')).toBe('instar-echo');
    expect(tunnelNameFor('My Agent!')).toBe('instar-my-agent');
    expect(tunnelNameFor('Echo', 'm_abc123')).toBe('instar-echo-m-abc123');
    expect(tunnelNameFor('Echo', 'm_a')).not.toBe(tunnelNameFor('Echo', 'm_b'));
  });
  it('the config blocks: a setup write keeps relay and notice settings and drops any config file; a restore never carries a token', () => {
    const old = { enabled: true, type: 'quick', relaysEnabled: false, notifyTopic: 'lifeline', configFile: '/x/cred.json' };
    expect(namedTunnelBlock(old, { token: 'run', hostname: 'a.example.com' })).toEqual({ enabled: true, type: 'named', token: 'run', hostname: 'a.example.com', relaysEnabled: false, notifyTopic: 'lifeline' });
    expect(namedTunnelBlock(undefined, { token: 'run', hostname: 'a.example.com' })).toEqual({ enabled: true, type: 'named', token: 'run', hostname: 'a.example.com' });
    const written = { enabled: true, type: 'named', token: 'run', hostname: 'a.example.com', relaysEnabled: false };
    expect(restoredTunnelBlock(written, null)).toEqual({ enabled: true, type: 'quick', relaysEnabled: false });
    expect(restoredTunnelBlock(written, { enabled: true, type: 'named', hostname: 'me.example.org', configFile: '/x/cred.json' })).toEqual({ enabled: true, type: 'named', hostname: 'me.example.org', configFile: '/x/cred.json', relaysEnabled: false });
    expect(restoredTunnelBlock(written, { enabled: false, type: 'quick' })).toEqual({ enabled: false, type: 'quick', relaysEnabled: false });
    expect(tunnelSettingsFrom({ enabled: true, type: 'named', token: 't', hostname: 'h.example.com', configFile: '/c' })).toEqual({ enabled: true, type: 'named', token: 't', hostname: 'h.example.com', configFile: '/c' });
    expect(tunnelSettingsFrom(undefined)).toBeNull();
    expect(withoutToken({ enabled: true, type: 'named', token: 't', hostname: 'h' })).toEqual({ enabled: true, type: 'named', hostname: 'h' });
  });
});

describe('the real Cloudflare client', () => {
  const seen: Array<{ method: string; url: string; auth: string | null; body: string | null }> = [];
  const fetchWith = (answer: (url: string, method: string) => { status: number; body: unknown }) => (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    seen.push({ method, url, auth: (init?.headers as Record<string, string>)?.Authorization ?? null, body: typeof init?.body === 'string' ? init.body : null });
    const a = answer(url, method);
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;

  it('sends the token only in the Authorization header, never in a URL or body', async () => {
    seen.length = 0;
    const api = realCloudflareApi(fetchWith(() => ({ status: 200, body: { success: true, result: { status: 'active' } } })));
    expect(await api.verifyToken('tok-123')).toBe('ok');
    expect(seen[0].auth).toBe('Bearer tok-123');
    expect(seen[0].url).not.toContain('tok-123');
    expect(seen[0].body).toBeNull();
  });
  it('refused, ok and unknown each have their own answer', async () => {
    const refused = realCloudflareApi(fetchWith(() => ({ status: 403, body: { success: false } })));
    expect(await refused.verifyToken('t')).toBe('refused');
    const down = realCloudflareApi((async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(await down.verifyToken('t')).toBe('unknown');
    expect(await down.zoneFor('t', 'agent.example.com')).toBeUndefined();
    expect(await down.tunnelNamed('t', 'acc', 'instar-echo')).toBeUndefined();
  });
  it('finds the zone by the longest suffix first, and points the DNS name at the tunnel as a proxied CNAME', async () => {
    seen.length = 0;
    const api = realCloudflareApi(fetchWith((url, method) => {
      if (url.includes('/zones?name=agents.example.com')) return { status: 200, body: { success: true, result: [] } };
      if (url.includes('/zones?name=example.com')) return { status: 200, body: { success: true, result: [{ id: 'z1', name: 'example.com', account: { id: 'acc1' } }] } };
      if (url.endsWith('/dns_records?type=CNAME&name=echo.agents.example.com')) return { status: 200, body: { success: true, result: [] } };
      if (method === 'POST' && url.endsWith('/dns_records')) return { status: 200, body: { success: true, result: { id: 'r1' } } };
      return { status: 404, body: { success: false } };
    }));
    expect(await api.zoneFor('t', 'echo.agents.example.com')).toEqual({ id: 'z1', name: 'example.com', accountId: 'acc1' });
    expect(await api.putDns('t', 'z1', 'echo.agents.example.com', 't1')).toEqual({ id: 'r1', created: true });
    const post = seen.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toMatchObject({ type: 'CNAME', content: 't1.cfargotunnel.com', proxied: true });
  });
  it('a CNAME already pointing at the tunnel is reused and not counted as created', async () => {
    const api = realCloudflareApi(fetchWith(() => ({ status: 200, body: { success: true, result: [{ id: 'r9', content: 't1.cfargotunnel.com' }] } })));
    expect(await api.putDns('t', 'z1', 'a.example.com', 't1')).toEqual({ id: 'r9', created: false });
  });
  it('the tunnel calls: create with Cloudflare-held config, the ingress shape, the run token, connections then tunnel on delete', async () => {
    seen.length = 0;
    const api = realCloudflareApi(fetchWith((url, method) => {
      if (method === 'POST' && url.endsWith('/cfd_tunnel')) return { status: 200, body: { success: true, result: { id: 't1', name: 'instar-echo' } } };
      if (url.endsWith('/token')) return { status: 200, body: { success: true, result: 'run-token' } };
      return { status: 200, body: { success: true, result: {} } };
    }));
    expect(await api.createTunnel('t', 'acc1', 'instar-echo')).toEqual({ id: 't1', name: 'instar-echo' });
    expect(JSON.parse(seen[0].body!)).toEqual({ name: 'instar-echo', config_src: 'cloudflare' });
    expect(await api.putIngress('t', 'acc1', 't1', 'a.example.com', 4042)).toBe(true);
    expect(JSON.parse(seen[1].body!)).toEqual({ config: { ingress: [{ hostname: 'a.example.com', service: 'http://localhost:4042' }, { service: 'http_status:404' }] } });
    expect(seen[1].method).toBe('PUT');
    expect(await api.tunnelToken('t', 'acc1', 't1')).toBe('run-token');
    expect(await api.deleteTunnel('t', 'acc1', 't1')).toBe(true);
    expect(seen.slice(-2).map((c) => c.url.split('/v4')[1])).toEqual(['/accounts/acc1/cfd_tunnel/t1/connections', '/accounts/acc1/cfd_tunnel/t1?cascade=true']);
  });
});

describe('the cloudflare-v1 recipe', () => {
  it('is dark: proving agents only, until its live proof; it keeps one named secret', () => {
    expect(row.setupRecipe).toBeNull();
    expect(row.wayIn).toBe(true);
    expect(recipe.secretName).toBe(CLOUDFLARE_SECRET);
    expect(recipeFor(catalogWithProving(['cloudflare-v1'], () => true).find((r) => r.id === 'cloudflare-domain')!)?.id).toBe('cloudflare-v1');
  });

  it('the check: absent without a named tunnel, pass when the agent answers at its name, unknown on silence, fail with the reason', async () => {
    const v = (over: Parameters<typeof surface>[0], secret: string | null = SECRET) => recipe.verify({ readSecret: () => secret, cloudflare: surface(over).s });
    expect(await v({ tunnel: null })).toMatchObject({ result: 'fail', absent: true });
    expect(await v({ tunnel: { enabled: true, type: 'quick' } })).toMatchObject({ result: 'fail', absent: true });
    const named: TunnelSettings = { enabled: true, type: 'named', token: 'run', hostname: 'agent.example.com' };
    expect(await v({ tunnel: named, reach: 'ok' })).toMatchObject({ result: 'pass' });
    expect((await v({ tunnel: named, reach: 'unknown' })).result).toBe('unknown');
    expect((await v({ tunnel: named, reach: 'unreachable' })).detail).toContain('does not answer yet');
    const refusing = fakeApi({ verifyToken: async () => 'refused' }).api;
    expect((await v({ tunnel: named, reach: 'unreachable', api: refusing })).detail).toContain('refused the stored token');
    expect((await recipe.verify({ readSecret: () => SECRET })).result).toBe('unknown');
  });

  it('sync does the whole Cloudflare job once, remembers its work, writes the tunnel and asks for a restart', async () => {
    const { api, calls } = fakeApi();
    const mine = surface({ tunnel: { enabled: true, type: 'quick' }, api });
    const w = work();
    const out = await recipe.sync!({ readSecret: () => SECRET, cloudflare: mine.s, agentName: 'Echo', cloudflareWork: w, secretNames: () => [] } as SyncDeps);
    expect(out).toMatchObject({ ok: true, copied: ['agent.example.com'] });
    expect(calls).toEqual(['verify', 'zone', 'find', 'create', 'ingress', 'dns', 'token']);
    expect(mine.state.tunnel).toEqual({ enabled: true, type: 'named', token: 'run-token', hostname: 'agent.example.com' });
    expect(w.kept).toMatchObject({ zoneId: 'z1', accountId: 'acc1', tunnelId: 't1', dnsRecordId: 'r1', createdDns: true, createdTunnel: true, previousTunnel: { enabled: true, type: 'quick' } });
    expect(JSON.stringify(w.kept)).not.toContain('run-token');
    expect(mine.state.restarts).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('cf-token-value');
    // The daily refresh: the same block again changes nothing and asks for no restart.
    const again = await recipe.sync!({ readSecret: () => SECRET, cloudflare: mine.s, agentName: 'Echo', cloudflareWork: w, secretNames: () => [] } as SyncDeps);
    expect(again).toMatchObject({ ok: true, detail: expect.stringContaining('still points') });
    expect(mine.state.restarts).toHaveLength(1);
  });

  it('sync reuses a tunnel of the same name, and stops at the first refusal without writing anything', async () => {
    const reuse = fakeApi({ existingTunnel: true });
    const a = surface({ api: reuse.api });
    const w = work();
    await recipe.sync!({ readSecret: () => SECRET, cloudflare: a.s, agentName: 'Echo', cloudflareWork: w, secretNames: () => [] } as SyncDeps);
    expect(reuse.calls).not.toContain('create');
    expect(w.kept?.createdTunnel).toBe(false);

    const noZone = fakeApi({ zoneFor: async () => null });
    const b = surface({ api: noZone.api });
    const out = await recipe.sync!({ readSecret: () => SECRET, cloudflare: b.s, agentName: 'Echo', cloudflareWork: work(), secretNames: () => [] } as SyncDeps);
    expect(out).toMatchObject({ ok: false, detail: expect.stringContaining('No Cloudflare zone holds') });
    expect(b.state.tunnel).toBeNull();
    expect(b.state.restarts).toHaveLength(0);

    const refused = fakeApi({ verifyToken: async () => 'refused' });
    expect((await recipe.sync!({ readSecret: () => SECRET, cloudflare: surface({ api: refused.api }).s, cloudflareWork: work(), secretNames: () => [] } as SyncDeps)).detail).toBe('Cloudflare refused the token.');
    expect((await recipe.sync!({ readSecret: () => null, cloudflare: surface().s, cloudflareWork: work(), secretNames: () => [] } as SyncDeps)).detail).toContain('No Cloudflare token');
  });

  it('a corrected host name before the first pass supersedes the old record and keeps the first undo record', async () => {
    const dnsIds = ['r1', 'r2'];
    const { api, calls } = fakeApi({ putDns: async () => { calls.push('dns'); return { id: dnsIds.shift()!, created: true }; } });
    const mine = surface({ tunnel: { enabled: true, type: 'quick' }, api });
    const w = work();
    await recipe.sync!({ readSecret: () => SECRET, cloudflare: mine.s, agentName: 'Echo', cloudflareWork: w, secretNames: () => [] } as SyncDeps);
    const corrected = JSON.stringify({ token: 'cf-token-value', hostname: 'bot.example.com' });
    const reuse = fakeApi({ tunnelNamed: async () => ({ id: 't1', name: 'instar-echo' }), putDns: async () => { calls.push('dns'); return { id: dnsIds.shift()!, created: true }; }, deleteDns: async () => { calls.push('deleteDns'); return true; } });
    mine.s.api = reuse.api;
    await recipe.sync!({ readSecret: () => corrected, cloudflare: mine.s, agentName: 'Echo', cloudflareWork: w, secretNames: () => [] } as SyncDeps);
    expect(calls).toContain('deleteDns');
    expect(w.kept).toMatchObject({ dnsRecordId: 'r2', hostname: 'bot.example.com', createdTunnel: true, previousTunnel: { enabled: true, type: 'quick' } });
    expect(mine.state.tunnel?.hostname).toBe('bot.example.com');
    expect(mine.state.restarts).toHaveLength(2);
  });

  it('a switch-off restores the previous tunnel, removes exactly the DNS name and tunnel setup made, and forgets; the person\'s own address is left alone', async () => {
    const { api, calls } = fakeApi();
    const mine = surface({ tunnel: { enabled: true, type: 'named', token: 'run-token', hostname: 'agent.example.com' }, api });
    const w = work();
    w.remember({ zoneId: 'z1', accountId: 'acc1', tunnelId: 't1', dnsRecordId: 'r1', createdDns: true, hostname: 'agent.example.com', createdTunnel: true, previousTunnel: { enabled: true, type: 'quick' } });
    let deleted: string[] = [];
    const out = await recipe.stop({ readSecret: () => SECRET, deleteSecret: (n) => { deleted.push(n); }, setUpHere: true, cloudflare: mine.s, cloudflareWork: w } as StopDeps);
    expect(out).toMatchObject({ stopped: true, changed: true });
    expect(out.detail).toContain('no longer points here');
    expect(mine.state.tunnel).toEqual({ enabled: true, type: 'quick' });
    expect(calls).toEqual(['deleteDns', 'deleteTunnel']);
    expect(deleted).toEqual([CLOUDFLARE_SECRET]);
    expect(w.kept).toBeNull();
    expect(mine.state.restarts).toHaveLength(1);

    // A tunnel or a DNS record that was already in the account is never deleted.
    const found = fakeApi();
    const reused = surface({ tunnel: { enabled: true, type: 'named', token: 'run-token', hostname: 'agent.example.com' }, api: found.api });
    const w2 = work();
    w2.remember({ zoneId: 'z1', accountId: 'acc1', tunnelId: 't-old', dnsRecordId: 'r1', createdDns: false, hostname: 'agent.example.com', createdTunnel: false, previousTunnel: null });
    deleted = [];
    await recipe.stop({ readSecret: () => SECRET, deleteSecret: (n) => { deleted.push(n); }, setUpHere: true, cloudflare: reused.s, cloudflareWork: w2 } as StopDeps);
    expect(found.calls).toEqual([]);
    expect(reused.state.tunnel).toEqual({ enabled: true, type: 'quick' });

    // Cloudflare refusing the tunnel delete (the connector is still up) is said plainly; the address is still switched off.
    const busy = fakeApi({ deleteTunnel: async () => false });
    const live = surface({ tunnel: { enabled: true, type: 'named', token: 'run-token', hostname: 'agent.example.com' }, api: busy.api });
    const w3 = work();
    w3.remember({ zoneId: 'z1', accountId: 'acc1', tunnelId: 't1', dnsRecordId: 'r1', createdDns: true, hostname: 'agent.example.com', createdTunnel: true, previousTunnel: null });
    const said = await recipe.stop({ readSecret: () => SECRET, deleteSecret: () => undefined, setUpHere: true, cloudflare: live.s, cloudflareWork: w3 } as StopDeps);
    expect(said.detail).toContain('stays in your Cloudflare account');
    expect(live.state.tunnel).toEqual({ enabled: true, type: 'quick' });

    const theirs = surface({ tunnel: { enabled: true, type: 'named', token: 'their-run', hostname: 'me.example.org' } });
    const left = await recipe.stop({ readSecret: () => null, deleteSecret: () => undefined, setUpHere: false, cloudflare: theirs.s, cloudflareWork: work() } as StopDeps);
    expect(left).toMatchObject({ stopped: true, changed: false });
    expect(theirs.state.tunnel?.hostname).toBe('me.example.org');
    expect(theirs.state.restarts).toHaveLength(0);
  });

  it('the brief: both account choices offered as good, the price confirmed before any purchase, the token never on a command line', () => {
    const brief = recipe.brief({ port: 4042 });
    expect(brief).toContain('present both options as good');
    expect(brief).toContain('Never buy without the yes');
    expect(brief).toContain('through one Secret Drop');
    expect(brief).toContain('/recommended-services/cloudflare-domain/key');
    expect(brief).toContain('/recommended-services/cloudflare-domain/sync');
    expect(brief).toContain('never with the token in a command line');
    expect(brief).not.toMatch(/ask (them|the person) to (go|visit|open|run|paste)/i);
  });
});
