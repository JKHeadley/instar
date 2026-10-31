/** Authenticated, bounded peer transport for advisory failed-file diagnosis. */
import type { DiagnosisPeerClient, DiagnosisPeerRequest } from './failedFileDiagnosisPeer.js';

export function makeDiagnosisPeerClient(authToken: string, agentId: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): DiagnosisPeerClient {
  const call = async (url: string, init: RequestInit): Promise<{ status: number; body: unknown } | null> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { ...init, signal: ac.signal, headers: {
        ...init.headers, Authorization: `Bearer ${authToken}`, 'X-Instar-AgentId': agentId, 'Content-Type': 'application/json',
      } });
      const raw = await r.text();
      let body: unknown = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* invalid peer response is unknown */ }
      return { status: r.status, body };
    } catch { return null; }
    finally { clearTimeout(timer); }
  };
  return {
    async status(peer) {
      const r = await call(`${peer.url}/local-verify/peer-diagnosis-status`, { method: 'GET' });
      if (!r || r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
      const b = r.body as Record<string, unknown>;
      return typeof b.enabled === 'boolean' && typeof b.busy === 'boolean'
        && typeof b.verifierVersion === 'string' && typeof b.policyHash === 'string'
        ? { enabled: b.enabled, busy: b.busy, verifierVersion: b.verifierVersion, policyHash: b.policyHash } : null;
    },
    async diagnose(peer, request: DiagnosisPeerRequest) {
      const r = await call(`${peer.url}/local-verify/peer-diagnose`, { method: 'POST', body: JSON.stringify(request) });
      if (!r || !r.body || typeof r.body !== 'object') return null;
      const b = r.body as Record<string, unknown>;
      return typeof b.accepted === 'boolean' && (b.reason === undefined || typeof b.reason === 'string')
        ? { accepted: b.accepted, ...(typeof b.reason === 'string' ? { reason: b.reason.slice(0, 160) } : {}) } : null;
    },
    async result(peer, attemptId) {
      const r = await call(`${peer.url}/local-verify/peer-diagnosis-result?attemptId=${encodeURIComponent(attemptId)}`, { method: 'GET' });
      if (!r || r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
      const b = r.body as Record<string, unknown>;
      if (b.state === 'unknown' || b.state === 'running') return { state: b.state };
      return b.state === 'done' && b.answer && typeof b.answer === 'object' ? { state: 'done', answer: b.answer as never } : null;
    },
  };
}
