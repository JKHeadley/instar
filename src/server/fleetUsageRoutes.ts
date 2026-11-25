// Owner-only opt-in rollup of already authorized agent pool summaries.
import type { Router } from 'express';
import { principalOf } from './mobilePairingRoutes.js';

const DAY_MS = 86_400_000;
const MAX_SOURCES = 24;
const MAX_BODY_BYTES = 128 * 1024;

interface FleetSource {
  id: string;
  agentId: string;
  label: string;
  endpoint: URL;
}

function fleetSources(env: NodeJS.ProcessEnv): FleetSource[] {
  const raw: unknown = JSON.parse(env.INSTAR_FLEET_USAGE_SOURCES ?? '[]');
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SOURCES) throw new Error('invalid source count');
  const ids = new Set<string>();
  const agentIds = new Set<string>();
  const origins = new Set<string>();
  return raw.map(source => {
    if (typeof source?.id !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(source.id)
      || typeof source.agentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(source.agentId)
      || typeof source.label !== 'string' || !source.label.trim() || source.label.length > 80
      || typeof source.origin !== 'string') throw new Error('invalid source');
    const origin = new URL(source.origin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/'
      || origin.search || origin.hash || ids.has(source.id) || agentIds.has(source.agentId) || origins.has(origin.origin)) throw new Error('invalid or duplicate origin');
    ids.add(source.id);
    agentIds.add(source.agentId);
    origins.add(origin.origin);
    return { id: source.id, agentId: source.agentId, label: source.label.trim(), endpoint: new URL('/usage/summary', origin) };
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) return null;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

interface FleetRow { label: string; tokens: number | null; coverage: 'complete' | 'partial' | 'unavailable' }

function projectSummary(body: unknown, since: number, label: string): FleetRow {
  const unavailable: FleetRow = { label, tokens: null, coverage: 'unavailable' };
  if (!body || typeof body !== 'object') return unavailable;
  const summary = body as {
    total?: { tokens?: { total?: number }; partialCalls?: number };
    grain?: string; scope?: string; since?: string; clamped?: boolean; notReached?: unknown[]; warming?: unknown[];
  };
  const tokens = summary.total?.tokens?.total;
  if (summary.grain !== 'day' || Date.parse(summary.since ?? '') !== since || summary.clamped !== false
    || (summary.scope !== 'pool' && summary.scope !== 'this-machine-only')
    || typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0
    || !Array.isArray(summary.notReached) || !Array.isArray(summary.warming)) return unavailable;
  const partial = summary.scope !== 'pool' || summary.notReached.length > 0 || summary.warming.length > 0
    || summary.total?.partialCalls !== 0;
  return { label, tokens, coverage: partial ? 'partial' : 'complete' };
}

export function mountFleetUsageRoutes(router: Router, {
  verifyOperator, env = process.env, fetchSummary = fetch, now = Date.now,
}: {
  verifyOperator: (token: string | undefined) => boolean;
  env?: NodeJS.ProcessEnv;
  fetchSummary?: typeof fetch;
  now?: () => number;
}): void {
  const enabled = () => env.INSTAR_FLEET_USAGE_ENABLED === 'true';
  router.get('/usage/fleet/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: enabled() });
  });
  let reading: Promise<{ since: string; tokens: number | null; complete: boolean; agents: FleetRow[] }> | null = null;
  router.get('/usage/fleet', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled()) { res.status(503).json({ error: 'fleet-usage-off' }); return; }
    if (principalOf(req).kind !== 'token' || !verifyOperator(req.get('X-Instar-Operator-Session'))) {
      res.status(403).json({ error: 'operator-session-required' }); return;
    }
    let sources: FleetSource[];
    try { sources = fleetSources(env); }
    catch { res.status(503).json({ error: 'fleet-usage-sources-unavailable' }); return; }
    reading ??= readFleet(sources).finally(() => { reading = null; });
    const result = await reading;
    if (!verifyOperator(req.get('X-Instar-Operator-Session'))) {
      res.status(403).json({ error: 'operator-session-required' }); return;
    }
    res.json(result);
  });

  async function readFleet(sources: FleetSource[]) {
    const since = (Math.floor(now() / DAY_MS) - 6) * DAY_MS;
    const agents = await Promise.all(sources.map(async (source): Promise<FleetRow> => {
      const unavailable: FleetRow = { label: source.label, tokens: null, coverage: 'unavailable' };
      const token = env[`INSTAR_FLEET_USAGE_TOKEN_${source.id}`];
      if (!token) return unavailable;
      source.endpoint.search = new URLSearchParams({ since: String(since), grain: 'day' }).toString();
      try {
        const response = await fetchSummary(source.endpoint, {
          headers: { Authorization: `Bearer ${token}`, 'X-Instar-AgentId': source.agentId },
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) { await response.body?.cancel(); return unavailable; }
        return projectSummary(await readBoundedJson(response), since, source.label);
      } catch { return unavailable; }
    }));
    const available = agents.filter(row => row.tokens !== null);
    const sum = available.reduce((total, row) => total + (row.tokens ?? 0), 0);
    const tokens = available.length && Number.isSafeInteger(sum) ? sum : null;
    return { since: new Date(since).toISOString(), tokens, complete: tokens !== null && agents.every(row => row.coverage === 'complete'), agents };
  }
}
