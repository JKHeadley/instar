import { randomUUID } from 'node:crypto';

/** Check that the current public tunnel reaches this agent before wake recovery replaces it. */
export async function probeCurrentTunnelIdentity(opts: {
  url: string | null;
  agentId: string;
  port: number;
  authToken: string | undefined;
  fetchImpl?: typeof fetch;
  delaysMs?: number[];
}): Promise<boolean> {
  const { url, agentId, port, authToken } = opts;
  if (!url || !authToken || !/^https:\/\//i.test(url)) return false;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delaysMs = opts.delaysMs ?? [1_000, 2_000];
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      const response = await fetchImpl(`${url.replace(/\/+$/, '')}/whoami?probe=${randomUUID()}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-Instar-AgentId': agentId,
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(4_000),
      });
      if (response.ok) {
        const identity = await response.json() as { agentId?: unknown; port?: unknown };
        if (identity.agentId === agentId && identity.port === port) return true;
      }
    } catch {
      // A timeout or malformed response is an unreachable tunnel, not proof of identity.
    }
    if (attempt < delaysMs.length) {
      await new Promise(resolve => setTimeout(resolve, delaysMs[attempt]));
    }
  }
  return false;
}
